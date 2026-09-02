/**
 * 気候ソルバの WGSL カーネル。docs/04-8。
 *
 * 設計上の要点:
 *
 * 1. **PCG のループ全体を GPU 上で回し切る。**
 *    内積の結果を毎反復 CPU に戻すと、読み戻しの遅延（1 回 0.5ms）が
 *    100 反復で 50ms になり、CPU 版より遅くなる。
 *    スカラー（alpha, beta, rz, pAp）も GPU バッファに置き、
 *    反復回数を固定して 1 solve につき読み戻し 1 回にする。
 *
 * 2. **リダクションは固定小数点の整数 atomics**（docs/04-8.4a）。
 *    WebGPU の atomics は i32/u32 のみで float の atomicAdd は存在しない。
 *    整数加算は結合的かつ厳密なので、順序が変わってもビット単位で同一になる。
 *    浮動小数の atomicAdd は非結合性で run-to-run に結果が変わるため使えない。
 *
 * 3. **超越関数はカーネルに置かない**（docs/04-8.4b）。
 *    exp / log はベンダごとに ULP が違う。
 *    CPU と共有する多項式近似（core/fastmath.ts と同じ式）を WGSL でも使う。
 */

/** core/fastmath.ts の fastExp と【同一の式】。ベンダ非依存にするため。 */
export const WGSL_FASTEXP = /* wgsl */`
const LOG2E: f32 = 1.4426950408889634;
const LN2: f32 = 0.6931471805599453;

fn fastExp(x: f32) -> f32 {
  if (x > 88.0) { return 1e38; }
  if (x < -88.0) { return 0.0; }
  let k = round(x * LOG2E);
  let f = x - k * LN2;
  let p = 1.0 + f * (1.0 + f * (0.5 + f * (0.16666667
        + f * (0.041666668 + f * (0.008333334 + f * 0.0013888889)))));
  return p * exp2(k);
}

fn fastTanh(x: f32) -> f32 {
  if (x > 10.0) { return 1.0; }
  if (x < -10.0) { return -1.0; }
  return 1.0 - 2.0 / (fastExp(2.0 * x) + 1.0);
}
`

/** 全カーネルが共有する uniform とバインディング */
/**
 * 全カーネルが共有する uniform とバインディング。
 *
 * 【重要】WebGPU の maxStorageBuffersPerShaderStage は既定 8 しかない。
 * 場ごとに 1 本ずつバインドすると 26 本になり、レイアウト作成が失敗する
 * （SwiftShader も実 GPU も同じ）。そこで
 *   R = 行ごとの定数を全部詰めた 1 本
 *   F = セルごとの場を全部詰めた 1 本
 * にまとめ、ストレージバッファを 4 本（R, F, acc, sc）に抑える。
 *
 * オフセットは W,H が決まればコンパイル時定数にできるので、
 * パイプライン生成時にソースへ埋め込む。境界チェックも定数になって速い。
 */
export const FIELD_SLOTS = [
  "elev", "landFrac", "temp", "albedo", "iceFrac", "surfT", "dAlphaDT",
  "dEast", "dSouth", "gSum", "diag",
  "cgB", "cgX", "cgR", "cgZ", "cgP", "cgAp", "triCp", "triDp", "part",
] as const
export const ROW_SLOTS = ["rowW", "rowGN", "rowGS", "rowGZ", "rowS"] as const
export type FieldSlot = (typeof FIELD_SLOTS)[number]
export type RowSlot = (typeof ROW_SLOTS)[number]

/** 場のスロット番号 */
export function fieldSlot(name: FieldSlot): number { return FIELD_SLOTS.indexOf(name) }
export function rowSlot(name: RowSlot): number { return ROW_SLOTS.indexOf(name) }

function commonFor(W: number, H: number): string {
  const n = W * H
  const offs = FIELD_SLOTS.map((nm, i) => `const ${nm}_: u32 = ${i * n}u;`).join("\n")
  const roffs = ROW_SLOTS.map((nm, i) => `const ${nm}_: u32 = ${i * H}u;`).join("\n")
  return /* wgsl */`
struct Params {
  W: u32, H: u32, n: u32, nGroups: u32,
  A0: f32, B: f32, T0: f32, Tq: f32,
  D: f32, kMoist: f32, tIce: f32, dTIce: f32,
  alphaOcean: f32, alphaLand: f32, alphaIce: f32, hazeAlbedo: f32,
  seaLevel: f32, gGhg: f32, cOcean: f32, cLand: f32,
  pseudoDt: f32, dGhotDT: f32, lapsePerM: f32, fixedScale: f32,
  invTotalW: f32, geo: f32, _p1: f32, _p2: f32,
};

@group(0) @binding(0) var<uniform> P: Params;
/** 行ごとの定数を詰めたもの */
@group(0) @binding(1) var<storage, read> R: array<f32>;
/** セルごとの場を詰めたもの */
@group(0) @binding(2) var<storage, read_write> F: array<f32>;
/** 固定小数点のリダクション用アキュムレータ（決定論的） */
@group(0) @binding(3) var<storage, read_write> acc: array<atomic<i32>>;
/** GPU 上に置くスカラー（CPU に戻さない） */
@group(0) @binding(4) var<storage, read_write> sc: array<f32>;

const NW: u32 = ${W}u;
const NH: u32 = ${H}u;
const NN: u32 = ${n}u;
/** 内積カーネルのワークグループ数。二段目のリダクションで使う。 */
const NG: u32 = ${Math.ceil(n / 64)}u;
${offs}
${roffs}

// acc の割り当て
//  0: dot(r,z)   1: dot(p,Ap)   2: dot(r,r)
//  3: sumS  4: sumSaSurface  5: sumSaIce  6: sumSaHaze  7: sumT
// sc の割り当て
//  0: rz   1: pAp   2: alpha   3: beta

fn idx(x: u32, y: u32) -> u32 { return y * NW + x; }
fn wrapE(x: u32) -> u32 { if (x + 1u == NW) { return 0u; } return x + 1u; }
fn wrapWst(x: u32) -> u32 { if (x == 0u) { return NW - 1u; } return x - 1u; }

fn addFixed(slot: u32, v: f32) {
  atomicAdd(&acc[slot], i32(v * P.fixedScale));
}
`
}

/**
 * アルベド・氷・地表温度を計算し、放射の集計を積む。
 *
 * alpha = (1-f)*alpha_base + f*alpha_ice + alpha_haze と【成分の和】で書くので、
 * S*alpha の分解に残差が出ない（寄与分解パネルの厳密性を支えている）。
 */
export const WGSL_ALBEDO = /* wgsl */`
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.W * P.H) { return; }
  let y = i / P.W;
  let S = rowS[y];
  let wRow = rowW[y];
  let e = elev[i];
  // 【CPU 版と必ず同じ式にすること】。陸は 0/1 ではなくセル内の割合。
  // 粒子から求めた値で、セルの 30% が大陸というような混合セルを表す
  let isLand = clamp(landFrac[i], 0.0, 1.0);
  // 氷は【標高補正後の】地表温度で判定する。高山に氷河ができる。
  let ts = temp[i] - isLand * max(0.0, e - P.seaLevel) * P.lapsePerM;
  surfT[i] = ts;
  let th = fastTanh((ts - P.tIce) / P.dTIce);
  let f = 0.5 * (1.0 - th);
  iceFrac[i] = f;
  let aBase = mix(P.alphaOcean, P.alphaLand, isLand);
  let sSurf = (1.0 - f) * aBase;
  let sIce = f * P.alphaIce;
  let raw = sSurf + sIce + P.hazeAlbedo;
  albedo[i] = clamp(raw, 0.05, 0.90);
  // d(alpha)/dT。氷が融けるとアルベドが下がる = 正のフィードバックなので負。
  dAlphaDT[i] = (P.alphaIce - aBase) * (-0.5 * (1.0 - th * th) / P.dTIce);

  // 面積重み付きの集計（固定小数点の整数 atomics で決定論的に）
  // rowW の総和は 4pi なので、CPU 側の規約（総和 1 の面積重み）に合わせて割る。
  // ここで割らないと固定小数点が i32 を溢れる（340*4pi*2^20 > 2^31）。
  let aw = wRow * P.invTotalW;
  addFixed(3u, S * aw);
  addFixed(4u, S * sSurf * aw);
  addFixed(5u, S * sIce * aw);
  addFixed(6u, S * P.hazeAlbedo * aw);
  addFixed(7u, temp[i] * aw);
}
`

/** 辺の実効拡散係数（湿潤熱輸送）。東と南の 2 面だけ持てば全辺を覆える。 */
export const WGSL_EDGED = /* wgsl */`
fn edgeD(ta: f32, tb: f32) -> f32 {
  let te = 0.5 * (ta + tb);
  let lh = fastExp((te - P.T0) / P.Tq) - 1.0;
  return P.D * (1.0 + P.kMoist * max(0.0, lh));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.W * P.H) { return; }
  let y = i / P.W;
  let x = i % P.W;
  let t = temp[i];
  dEast[i] = edgeD(t, temp[idx(wrapE(x), y)]);
  if (y + 1u < P.H) { dSouth[i] = edgeD(t, temp[idx(x, y + 1u)]); }
  else { dSouth[i] = 0.0; }
}
`

/** ラプラシアンの対角 sum(g)。B は含まない。 */
export const WGSL_GSUM = /* wgsl */`
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.W * P.H) { return; }
  let y = i / P.W;
  let x = i % P.W;
  var d = rowGZ[y] * (dEast[i] + dEast[idx(wrapWst(x), y)]);
  if (y > 0u) { d = d + rowGN[y] * dSouth[idx(x, y - 1u)]; }
  if (y + 1u < P.H) { d = d + rowGS[y] * dSouth[i]; }
  gSum[i] = d;
}
`

/**
 * Newton の残差 F = w*f - w*B*T - L*T と、Newton の対角。
 * ついでに cgB（右辺）と cgX（初期値 0）も用意する。
 */
export const WGSL_RESIDUAL = /* wgsl */`
fn lap(i: u32, x: u32, y: u32) -> f32 {
  var accv = gSum[i] * temp[i];
  accv = accv - rowGZ[y] * dEast[i] * temp[idx(wrapE(x), y)];
  accv = accv - rowGZ[y] * dEast[idx(wrapWst(x), y)] * temp[idx(wrapWst(x), y)];
  if (y > 0u) { accv = accv - rowGN[y] * dSouth[idx(x, y - 1u)] * temp[idx(x, y - 1u)]; }
  if (y + 1u < P.H) { accv = accv - rowGS[y] * dSouth[i] * temp[idx(x, y + 1u)]; }
  return accv;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.W * P.H) { return; }
  let y = i / P.W;
  let x = i % P.W;
  let wRow = rowW[y];
  let S = rowS[y];
  // 内部熱流（マントル起源）を足す。CPU 版 climate.ts と同じ式にすること
  let f = S * (1.0 - albedo[i]) - P.A0 + P.gGhg + P.geo - P.B * temp[i];
  let res = wRow * f - lap(i, x, y);
  cgB[i] = res;
  cgR[i] = res;
  cgX[i] = 0.0;

  // Newton の対角。B_eff は【負になってよい】——氷縁は局所的に不安定で、
  // 系を安定化しているのは拡散であって局所の放射ではない。
  // 正定値性を保つ下限だけ設ける。
  var bEff = P.B + S * dAlphaDT[i] - P.dGhotDT;
  let floorB = (-0.5 * gSum[i]) / wRow;
  bEff = max(bEff, floorB);
  let c = mix(P.cOcean, P.cLand, select(0.0, 1.0, elev[i] >= P.seaLevel));
  diag[i] = wRow * (bEff + c / P.pseudoDt) + gSum[i];
}
`

/** 行列ベクトル積 (A p)_i = diag_i p_i - sum_k g_ik p_k */
export const WGSL_MATVEC = /* wgsl */`
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.W * P.H) { return; }
  let y = i / P.W;
  let x = i % P.W;
  let iw = idx(wrapWst(x), y);
  var a = diag[i] * cgP[i];
  a = a - rowGZ[y] * dEast[i] * cgP[idx(wrapE(x), y)];
  a = a - rowGZ[y] * dEast[iw] * cgP[iw];
  if (y > 0u) { a = a - rowGN[y] * dSouth[idx(x, y - 1u)] * cgP[idx(x, y - 1u)]; }
  if (y + 1u < P.H) { a = a - rowGS[y] * dSouth[i] * cgP[idx(x, y + 1u)]; }
  cgAp[i] = a;
}
`

/**
 * 前処理: 南北方向の三重対角を Thomas 法で解く（列ごと）。
 *
 * Jacobi 前処理では CG が 300 反復に張り付いた。対称化した系では
 * B の項にセル面積が掛かるため B*w が sum(g) の 0.1% しかなく、
 * ほぼ純粋なラプラシアン（定数モードの固有値がほぼゼロ）になるため。
 * 南北を厳密に解くと列ごとの平均が B から正しく決まり、定数モードが捕まる。
 *
 * 1 スレッド = 1 列。列どうしは独立。
 * H が大きい場合は PCR（並列巡回縮約）に置き換える余地がある。
 */
export const WGSL_PRECOND = /* wgsl */`
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  if (x >= P.W) { return; }
  let H = P.H;
  // 前進消去
  var m = 1.0 / diag[idx(x, 0u)];
  var sup0 = 0.0;
  if (H > 1u) { sup0 = -rowGS[0] * dSouth[idx(x, 0u)]; }
  triCp[x] = sup0 * m;
  triDp[x] = cgR[idx(x, 0u)] * m;
  for (var y: u32 = 1u; y < H; y = y + 1u) {
    let i = idx(x, y);
    let sub = -rowGN[y] * dSouth[idx(x, y - 1u)];
    var sup = 0.0;
    if (y + 1u < H) { sup = -rowGS[y] * dSouth[i]; }
    m = 1.0 / (diag[i] - sub * triCp[(y - 1u) * P.W + x]);
    triCp[y * P.W + x] = sup * m;
    triDp[y * P.W + x] = (cgR[i] - sub * triDp[(y - 1u) * P.W + x]) * m;
  }
  // 後退代入
  var prev = triDp[(H - 1u) * P.W + x];
  cgZ[idx(x, H - 1u)] = prev;
  for (var k: u32 = 0u; k < H - 1u; k = k + 1u) {
    let y = H - 2u - k;
    prev = triDp[y * P.W + x] - triCp[y * P.W + x] * prev;
    cgZ[idx(x, y)] = prev;
  }
}
`

/**
 * 内積の一段目。ワークグループごとの部分和を part に書く。
 *
 * 【なぜ固定小数点 atomics を使わないか】
 * 放射の集計（meanS など）は大きさが既知で有界なので固定小数点でよい。
 * だが CG の内積は反復とともに何桁も小さくなる。
 * 2^20 の固定スケールでは rz が 1e-7 まで落ちた時点で有効数字が消え、
 * beta が壊れて CG が収束しなくなる。
 *
 * 代わりに f32 のまま二段で畳む。
 * 一段目はワークグループ内の固定順ツリー、二段目は 1 スレッドの固定順逐次和。
 * 【順序が固定なら IEEE754 の加算は決定論的】なので、
 * run-to-run でもベンダ間でもビット単位で同じ結果になる。
 * float の atomicAdd が使えないのは制約ではなく、
 * これを選ばざるを得なくしてくれた点でむしろ好都合だった。
 */
export const WGSL_DOT = /* wgsl */`
var<workgroup> partial: array<f32, 64>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>,
        @builtin(workgroup_id) wid: vec3<u32>,
        @builtin(local_invocation_id) lid: vec3<u32>) {
  let i = gid.x;
  var v = 0.0;
  if (i < NN) {
    // 内積の中身はパイプライン生成時に決まる
    v = DOT_EXPR;
  }
  partial[lid.x] = v;
  workgroupBarrier();
  var s: u32 = 32u;
  loop {
    if (s == 0u) { break; }
    if (lid.x < s) { partial[lid.x] = partial[lid.x] + partial[lid.x + s]; }
    workgroupBarrier();
    s = s >> 1u;
  }
  if (lid.x == 0u) { part[wid.x] = partial[0]; }
}
`

/**
 * CG のスカラー更新。1 スレッドで走る。
 * 固定小数点のアキュムレータを f32 に戻してから alpha / beta を作る。
 */
export const WGSL_CGSCALARS = /* wgsl */`
@compute @workgroup_size(1)
fn main() {
  // 二段目のリダクション。1 スレッドの固定順逐次和なので決定論的。
  var v = 0.0;
  for (var g: u32 = 0u; g < NG; g = g + 1u) { v = v + part[g]; }
  // 以下はパイプライン生成時に決まる。v が内積の値。
  STAGE_BODY
}
`

/** x += alpha*p ; r -= alpha*Ap */
export const WGSL_CG_AXPY = /* wgsl */`
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.W * P.H) { return; }
  let alpha = sc[2];
  cgX[i] = cgX[i] + alpha * cgP[i];
  cgR[i] = cgR[i] - alpha * cgAp[i];
}
`

/** p = z + beta*p */
export const WGSL_CG_PUPDATE = /* wgsl */`
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.W * P.H) { return; }
  cgP[i] = cgZ[i] + sc[3] * cgP[i];
}
`

/** p = z（CG の初期化） */
export const WGSL_CG_PINIT = /* wgsl */`
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.W * P.H) { return; }
  cgP[i] = cgZ[i];
}
`

/** Newton のステップを適用する。T += dT（クランプ付き） */
export const WGSL_APPLY = /* wgsl */`
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.W * P.H) { return; }
  temp[i] = clamp(temp[i] + cgX[i], -120.0, 500.0);
}
`

/** アキュムレータをゼロにする */
export const WGSL_CLEARACC = /* wgsl */`
@compute @workgroup_size(8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x < 8u) { atomicStore(&acc[gid.x], 0); }
}
`

/**
 * 場の配列アクセスをパック済みバッファへの参照に書き換える。
 *
 * `temp[i]` → `F[temp_ + (i)]` のような単純な置換。
 * 添字の式に `]` が現れないことに依存している（実際に現れない）。
 * カーネル本体を物理そのままの見た目で書けるようにするための仕掛け。
 */
function packRefs(src: string): string {
  const f = FIELD_SLOTS.join("|")
  const r = ROW_SLOTS.join("|")
  return src
    .replace(new RegExp(`\\b(${f})\\[([^\\]]*)\\]`, "g"), "F[$1_ + ($2)]")
    .replace(new RegExp(`\\b(${r})\\[([^\\]]*)\\]`, "g"), "R[$1_ + ($2)]")
}

/** 内積カーネルのソースを組み立てる */
export function dotSource(W: number, H: number, expr: string): string {
  return commonFor(W, H) + WGSL_FASTEXP +
    packRefs(WGSL_DOT.replaceAll("DOT_EXPR", expr))
}

/** スカラー更新カーネルのソースを組み立てる */
export function scalarSource(W: number, H: number, body: string): string {
  return commonFor(W, H) + packRefs(WGSL_CGSCALARS.replaceAll("STAGE_BODY", body))
}

/** カーネル本体を共通部と連結する */
export function kernelSource(W: number, H: number, body: string): string {
  return commonFor(W, H) + WGSL_FASTEXP + packRefs(body)
}

/**
 * 2 次元エネルギーバランスモデル (EBM)。docs/01-3。
 *
 *   C dT/dt = S(1-alpha) - (A0 + B*T - G) + div(D grad T)
 *
 * 1 次元プロトタイプ (proto/) で以下を検証済み:
 *   - 現在の地球の再現（全球平均・南北傾度・氷被覆率・ECS の 4 点同時拘束）
 *   - スノーボール分岐とヒステリシス
 *   - 暴走温室
 * 2 次元で新たに入るのは【陸海コントラスト】と【東西方向の非一様性】。
 *
 * 数値解法: 前処理付き共役勾配法 (PCG)。
 *
 *   ここに至るまでに 2 回失敗している。記録しておく。
 *
 *   1. 赤黒 Gauss-Seidel  -> 収束しない。
 *   2. 南北方向の線形陰解法 (Thomas) + 東西を右辺 -> やはり収束しない。
 *
 *   原因は同じ: この系は【拡散支配】である。拡散の結合係数 D*c は
 *   放射の応答 B の 100 倍あり、拡散の一部でも陽的に扱うと、
 *   前反復値への復元力が物理より 100 倍強くなって収束率が 1 - B/(D*c) ~ 0.99 になる。
 *   極フィルタを強めても直らない（極だけの問題ではなく、赤道でも同じ比になる）。
 *
 *   正しい解法:
 *     各セルの式に【セル面積】を掛けると、行列が対称正定値になる。
 *       A_ii = w_i*B + sum_k g_ik ,  A_ij = -g_ij ,  g_ij = D_ij * L_ij / d_ij
 *     g_ij は辺の量なので i,j を入れ替えても同じ = 対称。
 *     さらに B*I の項が定数モードに正の固有値を与えるので条件数が小さい
 *     (kappa ~ (B + 4*D*c)/B ~ 900、平方根で 30)。
 *     -> Jacobi 前処理の CG が数十反復で収束する。
 *
 *   さらに、外側を素の Picard 反復にすると【今度は外側が収束しない】。
 *   氷アルベドフィードバックのループゲインが 0.77 あるため。
 *   -> アルベドの温度微分 dalpha/dT を解析的に求めて対角に入れ、Newton にする。
 *
 *   ところが素の Newton も破綻した。氷縁ではセルの 12% で
 *   S*dalpha/dT ~ -7.5 が B = 2.22 を上回り、局所的に不安定になる。
 *   その結果ヤコビアンの定数モードの固有値が小さくなり（条件数 5000）、
 *   CG が近ゼロ方向を解けずに巨大な歩幅を返して残差が 0.19K -> 12.3K に発散した。
 *   線形探索を足しても振動したまま停滞した。
 *
 *   最終解: 擬似時間発展法 (pseudo-transient continuation)。
 *     ヤコビアンに擬似的な熱容量項 w*c/dt を足す。
 *       (w*(B_eff + c/dt) + L) dT = F_steady
 *     これは物理的には「陰的オイラーで気候を dt 年進める」ことに等しく、
 *     dt が有限なら常に正定値・安定。残差が下がるにつれて dt を伸ばし、
 *     dt -> 無限大 で Newton に一致する（SER 則）。
 *
 *     副次的な利点として、これは物理的な緩和過程そのものなので、
 *     複数平衡がある場合に【物理的に到達する側】の平衡に落ちる。
 *     スノーボールのヒステリシス (docs/01-3.7) が正しく再現される。
 *
 *   GPU 移植: matvec はステンシル、内積は固定小数点の整数 atomics による
 *   リダクション（docs/04-8.4a）。どちらも決定論的。
 */

import { Grid } from "../core/grid"
import type { FieldStore, FieldSpec } from "../core/fields"
import { clamp, fastExp, fastTanh } from "../core/fastmath"
import {
  type PlanetParams, type PlanetGlobals,
  co2Forcing, ch4Forcing, n2Forcing, runawayForcing, hazeAlbedo,
} from "./state"

/** 気温減率 [K/km]。標高補正 (docs/01-3.4) */
export const LAPSE_RATE = 6.5

/**
 * 極フィルタ: 東西結合係数を南北結合係数の何倍までに抑えるか。
 *
 * 緯度経度格子では東西結合が 1/cos²phi で発散する（極の行で南北の 2 万倍になる）。
 * 東西項を右辺に置く解法では、これが致命的になる:
 *   極の行が自分自身の東西隣にほぼ完全に縛られ、1 反復あたり
 *   aS/(2*aE) ~ 1/40000 しか動かない。実際、極の行が初期値のまま凍りついた。
 *
 * 極の行はもともと東西にほぼ一様（全セルが球面上のほぼ同じ点）なので、
 * 東西結合を頭打ちにしても物理は変わらない。GCM の極フィルタと同じ発想。
 * この値は scripts/probe-polar.ts で掃引して決めた。
 */
const POLAR_ZONAL_CAP = 8

/** 残差がこの倍率を超えて悪化したらステップを差し戻し、擬似時間刻みを縮める */
const REJECT_FACTOR = 3
/** 擬似時間刻みの下限 [yr] */
const MIN_PSEUDO_DT = 1e-3

export const M1_FIELDS: readonly FieldSpec[] = [
  { name: "elevation", kind: "f32", doubleBuffered: true, comment: "m。海面基準" },
  { name: "crustType", kind: "u8", doubleBuffered: false, comment: "0=oceanic, 1=continental" },
  { name: "temperature", kind: "f32", doubleBuffered: true, comment: "degC。海面基準の EBM 解" },
  { name: "surfaceTemp", kind: "f32", doubleBuffered: false, comment: "degC。標高補正後" },
  { name: "albedo", kind: "f32", doubleBuffered: false, comment: "惑星アルベド（導出）" },
  { name: "iceFraction", kind: "f32", doubleBuffered: false, comment: "0..1（導出）" },
]

/**
 * 放射収支の全球集計。寄与分解パネル (docs/03-5.3) の入力になる。
 *
 * S(1-alpha) を成分ごとに厳密に分解しておくことが要点。
 * alpha が成分の【和】として書けているので、この分解には残差が出ない。
 */
export interface RadiativeAggregate {
  /** 面積重み付き平均の入射日射 [W/m²] */
  meanS: number
  /** meanS のうち、地表アルベドで反射された分 */
  meanSaSurface: number
  /** 氷アルベドで反射された分 */
  meanSaIce: number
  /** ヘイズで反射された分 */
  meanSaHaze: number
  /** クランプによる補正分（通常はゼロ） */
  meanSaClamp: number
  /** 温室効果による OLR 減少 [W/m²] */
  gCo2: number
  gCh4: number
  /** 窒素の圧力広がり [W/m²]。pN2 = 1 気圧でゼロ */
  gN2: number
  gRunaway: number
  /** エアロゾルによる負の強制 [W/m²] */
  aerosol: number
  /** マントル起源の地表熱流量 [W/m²]。冥王代は太陽吸収の 15 倍ある */
  internal: number
}

export interface ClimateStats {
  meanT: number
  equatorT: number
  poleT: number
  minT: number
  maxT: number
  iceFraction: number
  landFraction: number
  planetaryAlbedo: number
  /**
   * 反射の内訳 [W/m²]。**惑星アルベドが高いときに何が反射しているかを言う。**
   *
   * 混合モデルで推定して「残差が説明できない」と悩むのをやめるために置く
   * （寄与台帳と同じ考え方、docs/04-5）。日射で重み付けされているので、
   * 極の氷は面積のわりに小さく出る——それが物理的に正しい。
   */
  reflSurface: number
  reflIce: number
  /**
   * 大気の反射 [W/m²]。**有機ヘイズ + 生物起源の雲**（`ccnAlbedoShift`）。
   * 雲のずれは負にもなる（生物圏が小さい時代は雲が暗い）ので、
   * この項も負になりうる。
   */
  reflHaze: number
  absorbedSW: number
  olr: number
  /** 収支の不平衡 [W/m²]。平衡解ならほぼゼロ */
  imbalance: number
  iterations: number
  /** CG の総反復数（性能の目安） */
  cgIterations: number
  /** 氷アルベドフィードバックが局所的に不安定なセル数（分岐近傍の指標） */
  unstableCells: number
  /** 温度がモデルの範囲 [-120, 500] にクランプされたセル数。0 でなければ暴走・凍結 */
  clampedCells: number
  /** 最後に採用した Newton の歩幅。1 未満なら分岐に近い */
  lastStep: number
  /** 最後の Newton ステップで動いた温度の最大幅 [K]。収束判定の量 */
  residual: number
  converged: boolean
  radiative: RadiativeAggregate
}

export interface SolveOptions {
  /** 平衡解を求めるなら null、時間積分するなら年数 */
  dtYears: number | null
  maxOuter?: number
  innerSweeps?: number
  /** 収束判定 [K] */
  tol?: number
  /** CG の最大反復数 */
  cgIterations?: number
  /** CG の相対残差の目標。Newton の内側なので緩くてよい（不正確 Newton） */
  cgTol?: number
  /** Newton の各反復を報告する（デバッグ用） */
  onNewtonStep?: (iter: number, residK: number, cgIter: number, unstable: number) => void
  /** アルベドの緩和係数。分岐近傍での振動を防ぐ */
  albedoRelax?: number
  /** 擬似時間の初期刻み [yr]。省略時は残差から自動で決める */
  pseudoDt0?: number
}

/**
 * 行ごとの幾何係数。単位球上で計算する
 * （EBM の D は「単位球上のラプラシアン」に対する係数なので R は入らない）。
 */
class Geometry {
  /** セル面積（単位球）。長さ H */
  readonly w: Float64Array
  /** 北側の辺のコンダクタンス L/d（面積で割らない）。長さ H */
  readonly gN: Float64Array
  /** 南側の辺のコンダクタンス。gS[y] === gN[y+1] （同じ辺だから）*/
  readonly gS: Float64Array
  /** 東西の辺のコンダクタンス */
  readonly gZ: Float64Array
  readonly insolationShape: Float64Array

  constructor(grid: Grid, polarCap?: number) {
    const { W, H } = grid
    const dLon = (2 * Math.PI) / W
    const dLat = Math.PI / H
    this.w = new Float64Array(H)
    this.gN = new Float64Array(H)
    this.gS = new Float64Array(H)
    this.gZ = new Float64Array(H)
    this.insolationShape = new Float64Array(H)

    for (let y = 0; y < H; y++) {
      const phiTop = (0.5 - y / H) * Math.PI
      const phiBot = (0.5 - (y + 1) / H) * Math.PI
      const phiC = grid.latRad[y]
      this.w[y] = dLon * (Math.sin(phiTop) - Math.sin(phiBot))
      // 南北: 辺長 cos(phi_edge)*dLon、中心間距離 dLat
      //  -> 極 (cos=0) でコンダクタンスがゼロになり、境界条件を書かずに済む
      this.gN[y] = (Math.cos(phiTop) * dLon) / dLat
      this.gS[y] = (Math.cos(phiBot) * dLon) / dLat
      // 東西: 辺長 dLat、中心間距離 cos(phi_c)*dLon
      const gz = dLat / (Math.cos(phiC) * dLon)
      // 極フィルタ。CG は剛性を扱えるので必須ではないが、
      // 極の行は物理的に東西一様なので上限を置いて条件数を下げる。
      const cap = (polarCap ?? POLAR_ZONAL_CAP) * Math.max(this.gN[y], this.gS[y])
      this.gZ[y] = Math.min(gz, cap)

      const x = grid.sinLat[y]
      this.insolationShape[y] = 0.5 * (3 * x * x - 1)
    }
  }
}

export class Climate {
  readonly grid: Grid
  private geo: Geometry
  private tPrev: Float32Array
  // PCG のスクラッチ。ティックループ内で確保しない（docs/04-8.5 規則 7）
  private cgX: Float64Array
  private cgR: Float64Array
  private cgZ: Float64Array
  private cgP: Float64Array
  private cgAp: Float64Array
  private cgDiag: Float64Array
  private cgB: Float64Array
  /** 辺の実効拡散係数。東 / 南 の 2 面だけ持てば全辺を覆える */
  private dEast: Float64Array
  private dSouth: Float64Array
  /** 前処理（南北方向の三重対角）のスクラッチ */
  private preCp: Float64Array
  private preDp: Float64Array
  /** 各セルの sum(g)（ラプラシアンの対角）。B を含まない */
  private gSum: Float64Array
  /** アルベドの温度微分。氷アルベドフィードバックの線形化に使う */
  private dAlphaDT: Float64Array
  /** Newton の残差 */
  private resid: Float64Array
  /** ステップ差し戻し用の温度場 */
  private tTrial: Float32Array

  constructor(grid: Grid, polarCap?: number) {
    this.grid = grid
    this.geo = new Geometry(grid, polarCap)
    const n = grid.cellCount
    this.tPrev = new Float32Array(n)
    this.cgX = new Float64Array(n)
    this.cgR = new Float64Array(n)
    this.cgZ = new Float64Array(n)
    this.cgP = new Float64Array(n)
    this.cgAp = new Float64Array(n)
    this.cgDiag = new Float64Array(n)
    this.cgB = new Float64Array(n)
    this.dEast = new Float64Array(n)
    this.dSouth = new Float64Array(n)
    this.preCp = new Float64Array(grid.H)
    this.preDp = new Float64Array(grid.H)
    this.gSum = new Float64Array(n)
    this.dAlphaDT = new Float64Array(n)
    this.resid = new Float64Array(n)
    this.tTrial = new Float32Array(n)
  }

  /** 行 y の入射日射 [W/m²] */
  insolation(p: PlanetParams, globals: PlanetGlobals, y: number): number {
    return (globals.solarConstant / 4) * (1 + p.s2 * this.geo.insolationShape[y])
  }

  /**
   * アルベドと標高補正温度を計算し、放射集計を返す。
   *
   * alpha = (1-f)*alpha_base + f*alpha_ice + alpha_haze
   * と【成分の和】で書けているので、S*alpha の分解に残差が出ない。
   * これが寄与分解パネル (docs/03-5.3) の厳密性を支えている。
   */
  private albedoPass(
    store: FieldStore, T: Float32Array, p: PlanetParams, g: PlanetGlobals,
  ): { agg: RadiativeAggregate; iceFrac: number; landFrac: number } {
    const { W, H } = this.grid
    const elev = store.f32("elevation").read
    const lf = store.f32("landFraction").read
    const alb = store.f32("albedo").read
    const ice = store.f32("iceFraction").read
    const surfT = store.f32("surfaceTemp").read
    // ★**大気の反射は 1 つの項にまとめる。**
    // 有機ヘイズ（`hazeAlbedo`）と、生物起源の雲凝結核による雲アルベドの
    // ずれ（`globals.ccnAlbedoShift`。負にもなる）。
    //
    // ★**アルベドに足したら、反射の台帳にも足すこと**（docs/04-5）。
    // CCN を `raw` にだけ足して台帳に入れていなかったので、
    // `absorbedSW = 入射 − (地表 + 氷 + ヘイズ)` から CCN の分が抜け、
    // **放射の不平衡が中央値 4.7 W/m² のまま残った**（2026-09-02 の実測。
    // 監査の「エネルギー収支」が 7.2e-5 → 4.7 で FAIL）。
    // GPU 側は最初から 1 つの定数にまとめてある（`gpuClimate.ts` の d[15]）。
    const aHaze = hazeAlbedo(p, g.co2, g.ch4) + g.ccnAlbedoShift
    const invDTIce = 1 / p.dTIce
    const lapsePerM = LAPSE_RATE / 1000

    let sumS = 0, sumSaSurf = 0, sumSaIce = 0, sumSaHaze = 0, sumSaClamp = 0
    let sumIce = 0, sumLand = 0

    for (let y = 0; y < H; y++) {
      const S = this.insolation(p, g, y)
      const wRow = this.grid.areaWeight[y] * W
      const row = y * W
      // 行内は逐次和 -> 行を固定順序で加重（docs/04-8.5 規則 5）
      let rS = 0, rSurf = 0, rIce = 0, rHaze = 0, rClamp = 0, rIceFrac = 0, rLand = 0
      for (let x = 0; x < W; x++) {
        const i = row + x
        const e = elev[i]
        // 【陸は 0/1 ではなくセル内の割合】。標高は厚さの非線形な関数なので、
        // セル平均で切ると「セルの 30% が大陸で 70% が海洋」という混合セルが
        // 丸ごと海になる。粒子から求めた landFraction を使う（GPU 版と同じ式）。
        const isLand = lf[i] < 0 ? 0 : lf[i] > 1 ? 1 : lf[i]
        // 氷は【標高補正後の】地表温度で判定する。高山に氷河ができる。
        const ts = T[i] - isLand * Math.max(0, e - g.seaLevel) * lapsePerM
        surfT[i] = ts
        const th = fastTanh((ts - p.tIce) * invDTIce)
        const f = 0.5 * (1 - th)
        ice[i] = f

        // ★**割合を真偽値として使っていた**（2026-08-30 に発見）。
        // `isLand` は 0..1 の割合なのに `isLand ? ...` と書いていたので、
        // **セルの 1% でも陸なら陸のアルベド 0.34 が丸ごと乗っていた。**
        // `subgridLand` を有効にした途端に効き、32Myr の実測で
        // **全球平均が 3.2K 下がっていた**（16.54 → 13.36℃）。
        // GPU 版（`climateShaders.ts`）は最初から `mix()` で混ぜていたので、
        // 「CPU 版と必ず同じ式にすること」という自分のコメントに反していた。
        // **端点で厳密に一致する形で書くこと。** `a + t*(b-a)` だと
        // t=1 で 0.34000000000000004 になり、既定（lf が 0/1）の軌跡が
        // ビット単位で変わってしまう（`CLAUDE.md` の 11）。
        // WGSL の `mix` も `x*(1-s)+y*s` なのでこちらが GPU と同じ式。
        const aBase = (1 - isLand) * p.alphaOcean + isLand * p.alphaLand
        // d(alpha)/dT = (alpha_ice - alpha_base) * df/dT,  df/dT = -0.5*(1-th^2)/dTIce
        // 氷が融けるとアルベドが下がる = 正のフィードバックなので負の値になる。
        this.dAlphaDT[i] = (p.alphaIce - aBase) * (-0.5 * (1 - th * th) * invDTIce)
        const sSurf = (1 - f) * aBase
        const sIce = f * p.alphaIce
        // ★生物起源の雲凝結核（`globals.ccnAlbedoShift`）。
        // 生物圏が小さい時代は核が少なく、**雲が暗い** = 惑星が暖かい
        const raw = sSurf + sIce + aHaze + g.ccnAlbedoShift
        const a = clamp(raw, 0.05, 0.9)
        alb[i] = a

        rS += S
        rSurf += S * sSurf
        rIce += S * sIce
        rHaze += S * aHaze
        rClamp += S * (a - raw)
        rIceFrac += f
        rLand += isLand
      }
      sumS += (rS / W) * wRow
      sumSaSurf += (rSurf / W) * wRow
      sumSaIce += (rIce / W) * wRow
      sumSaHaze += (rHaze / W) * wRow
      sumSaClamp += (rClamp / W) * wRow
      sumIce += (rIceFrac / W) * wRow
      sumLand += (rLand / W) * wRow
    }

    return {
      agg: {
        meanS: sumS,
        meanSaSurface: sumSaSurf,
        meanSaIce: sumSaIce,
        meanSaHaze: sumSaHaze,
        meanSaClamp: sumSaClamp,
        internal: g.internalHeatFlux,
        gCo2: co2Forcing(p, g.co2),
        gCh4: ch4Forcing(p, g.ch4),
        gN2: n2Forcing(p, g.n2Pressure),
        gRunaway: 0,
        aerosol: g.aerosolForcing,
      },
      iceFrac: sumIce,
      landFrac: sumLand,
    }
  }

  /** セル境界の実効拡散係数（湿潤熱輸送。docs/01-3.3） */
  private edgeD(p: PlanetParams, ta: number, tb: number): number {
    const te = 0.5 * (ta + tb)
    // 潜熱輸送は T0 より暖かい側でのみ加算される（乾燥輸送 D が下限）
    const raw = fastExp((te - p.T0) / p.Tq) - 1
    if (!(raw > 0)) return p.D
    // **指数関数の外挿を止める**（`moistMax` のコメント）。
    // 4 乗のソフトミン: raw ≪ max では素通り（2% 以内）、raw ≫ max では max。
    // 折れ点を作らないので気候ソルバの収束を乱さない。
    const r = raw / p.moistMax
    const lh = raw / Math.pow(1 + r * r * r * r, 0.25)
    return p.D * (1 + p.kMoist * lh)
  }

  /** 辺ごとの拡散係数を現在の温度場から更新する（Picard の外側で呼ぶ） */
  private updateEdgeDiffusivity(T: Float32Array, p: PlanetParams): void {
    const { W, H } = this.grid
    for (let y = 0; y < H; y++) {
      const row = y * W
      const rowS = y < H - 1 ? row + W : -1
      for (let x = 0; x < W; x++) {
        const i = row + x
        const xe = x + 1 === W ? 0 : x + 1
        this.dEast[i] = this.edgeD(p, T[i], T[row + xe])
        this.dSouth[i] = rowS >= 0 ? this.edgeD(p, T[i], T[rowS + x]) : 0
      }
    }
  }

  /**
   * 対称化した行列とのベクトル積。
   *   (A x)_i = diag_i * x_i - sum_k g_ik * x_k
   * g は辺の量なので東と南の 2 面だけ保持すれば全辺を覆える（gather 形式）。
   */
  private matvec(vec: Float64Array, out: Float64Array): void {
    const { W, H } = this.grid
    const { gN, gS, gZ } = this.geo
    const { dEast, dSouth, cgDiag } = this
    for (let y = 0; y < H; y++) {
      const row = y * W
      const rowN = row - W
      const rowS = row + W
      const kN = gN[y], kS = gS[y], kZ = gZ[y]
      for (let ix = 0; ix < W; ix++) {
        const i = row + ix
        const ie = row + (ix + 1 === W ? 0 : ix + 1)
        const iw = row + (ix === 0 ? W - 1 : ix - 1)
        let acc = cgDiag[i] * vec[i]
        // 東: 自分の東辺、西: 西隣の東辺（同じ辺を共有する = 対称）
        acc -= kZ * dEast[i] * vec[ie]
        acc -= kZ * dEast[iw] * vec[iw]
        if (y > 0) acc -= kN * dSouth[rowN + ix] * vec[rowN + ix]
        if (y < H - 1) acc -= kS * dSouth[i] * vec[rowS + ix]
        out[i] = acc
      }
    }
  }

  /** ラプラシアンの対角 sum(g) を組む。B を含まない。 */
  private buildGSum(): void {
    const { W, H } = this.grid
    const { gN, gS, gZ } = this.geo
    const { dEast, dSouth, gSum } = this
    for (let y = 0; y < H; y++) {
      const row = y * W
      const rowN = row - W
      const kN = gN[y], kS = gS[y], kZ = gZ[y]
      for (let ix = 0; ix < W; ix++) {
        const i = row + ix
        const iw = row + (ix === 0 ? W - 1 : ix - 1)
        let d = kZ * dEast[i] + kZ * dEast[iw]
        if (y > 0) d += kN * dSouth[rowN + ix]
        if (y < H - 1) d += kS * dSouth[i]
        gSum[i] = d
      }
    }
  }

  /**
   * Newton の対角: w*(B + S*dalpha/dT - dG_hot/dT) + sum(g)
   *
   * 氷アルベドフィードバックを対角に取り込むことで Picard を Newton に変える。
   *
   * B_eff は【負になってよい】。氷縁では S*dalpha/dT ~ -7.5 に対し B = 2.22 しかなく、
   * 局所的には不安定（＝正のフィードバックが放射の復元より強い）。
   * 系を安定化しているのは拡散であって、局所の放射ではない。
   *
   * 最初 B_eff の下限を 0.15*B に置いたところ、氷縁の広い範囲で下限に張り付き、
   * Newton が線形収束に劣化して 23 反復かかった。
   * 下限は「行列の正定値性が保てる範囲」まで緩める:
   *   w*B_eff >= -0.5*sum(g)  であれば対角が sum(g) の半分以上残り、CG が安定に回る。
   *
   * 下限に当たったセル数は「分岐にどれだけ近いか」の指標として返す。
   */
  private buildNewtonDiagonal(
    p: PlanetParams, g: PlanetGlobals, elev: Float32Array,
    pseudoDt: number, dGhotDT: number,
  ): number {
    const { W, H } = this.grid
    const { w } = this.geo
    const { gSum, dAlphaDT, cgDiag } = this
    let unstable = 0
    for (let y = 0; y < H; y++) {
      const S = this.insolation(p, g, y)
      const row = y * W
      const wy = w[y]
      for (let ix = 0; ix < W; ix++) {
        const i = row + ix
        let bEff = p.B + S * dAlphaDT[i] - dGhotDT
        if (bEff < 0) unstable++
        // 正定値性を保つ下限。対角が sum(g) の半分を下回らないようにする。
        const floor = (-0.5 * gSum[i]) / wy
        if (bEff < floor) bEff = floor
        // 擬似的な熱容量項。これが正定値性と条件数を保証する。
        const c = elev[i] >= g.seaLevel ? p.cLand : p.cOcean
        cgDiag[i] = wy * (bEff + c / pseudoDt) + gSum[i]
      }
    }
    return unstable
  }

  /** Float32 の温度場を Float64 のスクラッチに写す（行列演算は倍精度で行う） */
  private toF64(T: Float32Array): Float64Array {
    const v = this.cgZ
    for (let i = 0; i < T.length; i++) v[i] = T[i]
    return v
  }

  /** ラプラシアン単独とのベクトル積（Newton の残差計算に使う） */
  private laplacian(vec: Float64Array, out: Float64Array): void {
    const { W, H } = this.grid
    const { gN, gS, gZ } = this.geo
    const { dEast, dSouth, gSum } = this
    for (let y = 0; y < H; y++) {
      const row = y * W
      const rowN = row - W
      const rowS = row + W
      const kN = gN[y], kS = gS[y], kZ = gZ[y]
      for (let ix = 0; ix < W; ix++) {
        const i = row + ix
        const ie = row + (ix + 1 === W ? 0 : ix + 1)
        const iw = row + (ix === 0 ? W - 1 : ix - 1)
        let acc = gSum[i] * vec[i]
        acc -= kZ * dEast[i] * vec[ie]
        acc -= kZ * dEast[iw] * vec[iw]
        if (y > 0) acc -= kN * dSouth[rowN + ix] * vec[rowN + ix]
        if (y < H - 1) acc -= kS * dSouth[i] * vec[rowS + ix]
        out[i] = acc
      }
    }
  }

  /**
   * 前処理: 南北方向の三重対角を Thomas 法で厳密に解く（ライン前処理）。
   *
   * Jacobi 前処理では CG が 300 反復に張り付いた。原因は【定数モード】:
   * 対称化した系では B の項にセル面積が掛かるため、B*w は g の 0.1% 程度しかない。
   * つまり系はほぼ純粋なラプラシアン（定数モードの固有値がほぼゼロ）で、
   * 条件数が 6000 近くなる。
   *
   * 南北の三重対角を厳密に解くと、列ごとの平均が B から正しく決まるので
   * この定数モードが前処理で捕まる。反復数が 1 桁減る。
   *
   * 列どうしは独立なので GPU では「1 ワークグループ = 1 列 + PCR」に対応する。
   */
  private precondition(r: Float64Array, z: Float64Array): void {
    const { W, H } = this.grid
    const { gN, gS } = this.geo
    const { dSouth, preCp, preDp } = this
    const cgDiag = this.cgDiag
    for (let ix = 0; ix < W; ix++) {
      // 前進消去
      let b0 = cgDiag[ix]
      let m = 1 / b0
      preCp[0] = (H > 1 ? -gS[0] * dSouth[ix] : 0) * m
      preDp[0] = r[ix] * m
      for (let y = 1; y < H; y++) {
        const i = y * W + ix
        const sub = -gN[y] * dSouth[i - W]
        const sup = y < H - 1 ? -gS[y] * dSouth[i] : 0
        m = 1 / (cgDiag[i] - sub * preCp[y - 1])
        preCp[y] = sup * m
        preDp[y] = (r[i] - sub * preDp[y - 1]) * m
      }
      // 後退代入
      let prev = preDp[H - 1]
      z[(H - 1) * W + ix] = prev
      for (let y = H - 2; y >= 0; y--) {
        prev = preDp[y] - preCp[y] * prev
        z[y * W + ix] = prev
      }
    }
  }

  /** 固定順序の内積（docs/04-8.5 規則 5）。行ごとに畳んでから行を順に足す。 */
  private dot(a: Float64Array, b: Float64Array): number {
    const { W, H } = this.grid
    let total = 0
    for (let y = 0; y < H; y++) {
      const row = y * W
      let rowSum = 0
      for (let x = 0; x < W; x++) rowSum += a[row + x] * b[row + x]
      total += rowSum
    }
    return total
  }

  /**
   * 平衡解（または 1 時間ステップ）を求める。
   * store の "temperature" を初期値として使い、その場で更新する。
   */
  solve(
    store: FieldStore, p: PlanetParams, g: PlanetGlobals, opts: SolveOptions,
  ): ClimateStats {
    const { W, H } = this.grid
    const n = this.grid.cellCount
    const maxOuter = opts.maxOuter ?? 40
    const cgMax = opts.cgIterations ?? 400
    const tol = opts.tol ?? 1e-4
    const cgTol = opts.cgTol ?? 1e-8
    let unstableCells = 0

    const Tfield = store.f32("temperature")
    const T = Tfield.read
    const elev = store.f32("elevation").read
    const alb = store.f32("albedo").read
    const { w } = this.geo
    const { cgX, cgR, cgZ, cgP, cgAp, cgB } = this
    const tPrevStep = this.tTrial

    const dt = opts.dtYears
    const transient = dt !== null && dt > 0
    if (transient) this.tPrev.set(T)
    // 擬似時間法では F は【定常】残差を使う。過渡計算のときだけ c/dt*(Tprev - T) を含める。

    let agg: RadiativeAggregate = {
      meanS: 0, meanSaSurface: 0, meanSaIce: 0, meanSaHaze: 0, meanSaClamp: 0,
      gCo2: 0, gCh4: 0, gN2: 0, gRunaway: 0, aerosol: 0, internal: 0,
    }
    let iceFrac = 0, landFrac = 0
    let converged = false
    let outer = 0
    let cgTotal = 0
    let lastStep = 1

    /**
     * 与えられた温度場に対する Newton の残差 F = w*f - w*B*T - L*T を計算し、
     * 温度スケールの最大残差 [K] を返す。副作用としてアルベド・氷・地表温度を更新する。
     */
    const evalResidual = (Tcur: Float32Array): number => {
      // 拡散係数とラプラシアンの対角は Tcur に対して作り直す。
      // （最初これを外側ループに置いたままにしていて、初回呼び出しで
      //   未初期化のゼロが使われ、ラプラシアン項が丸ごと落ちていた）
      this.updateEdgeDiffusivity(Tcur, p)
      this.buildGSum()

      const r = this.albedoPass(store, Tcur, p, g)
      agg = r.agg
      iceFrac = r.iceFrac
      landFrac = r.landFrac
      const meanT = this.grid.globalMean(Tcur)
      const gHot = runawayForcing(p, meanT)
      agg.gRunaway = gHot
      // エアロゾルは負の強制（docs/01-3.3 の f_aerosol）
      const gTotal = agg.gCo2 + agg.gCh4 + agg.gN2 + gHot - g.aerosolForcing

      this.laplacian(this.toF64(Tcur), this.cgAp)
      // 線形探索の比較用に残差のノルムを返す。
      // 正規化は【定常演算子の対角】 w*B + sum(g) で行う。
      // w*B だけで割ると面積が極小の極セルで発散する（実際に 55K で張り付いた）。
      //
      // 注意: この量は K の次元を持たない。gSum が w*B の 3000 倍あるため、
      // 平衡から 0.77K ずれた状態でも 3e-4 程度にしかならない。
      // 【収束判定には使えない】。判定は Newton の歩幅 (K) で行う。
      let sumSq = 0
      for (let y = 0; y < H; y++) {
        const S = this.insolation(p, g, y)
        const row = y * W
        const wy = w[y]
        const wb = wy * p.B
        for (let ix = 0; ix < W; ix++) {
          const i = row + ix
          // 内部熱流を足す。無視するとマグマオーシャンの惑星が凍る
          let f = S * (1 - alb[i]) - p.A0 + gTotal + g.internalHeatFlux - p.B * Tcur[i]
          if (transient) {
            const c = (elev[i] >= g.seaLevel ? p.cLand : p.cOcean) / (dt as number)
            f += c * (this.tPrev[i] - Tcur[i])
          }
          const res = wy * f - this.cgAp[i]
          this.resid[i] = res
          const k = res / (wb + this.gSum[i])
          sumSq += k * k
        }
      }
      return Math.sqrt(sumSq / n)
    }

    let residK = evalResidual(T)

    // 擬似時間の初期値。c/dt が |B| の 10 倍程度になるようにする。
    // 擬似時間は毎回この値から始める。
    // 前回到達した刻みを引き継ぐ実験もしたが、大きい刻みから始めると
    // 差し戻しが増えて【かえって遅くなった】(700ms -> 1200ms)。
    let pseudoDt = transient ? (dt as number)
      : (opts.pseudoDt0 ?? p.cOcean / (10 * p.B))
    let stall = 0
    let stepK = Infinity
    let clampedCells = 0

    for (outer = 0; outer < maxOuter; outer++) {

      const meanT = this.grid.globalMean(T)
      const dGhotDT = meanT > p.Thot
        ? Math.min(p.wHot * Math.exp(Math.min(20, (meanT - p.Thot) / p.Tw)), 4 * p.B)
        : 0

      // 拡散係数と gSum は evalResidual が T に対して更新済み
      unstableCells = this.buildNewtonDiagonal(p, g, elev, pseudoDt, dGhotDT)

      // --- (w*(B_eff + c/dt) + L) dT = F を PCG で解く ---
      // メモリ帯域律速なので axpy とノルム計算は融合する。
      cgB.set(this.resid)
      cgX.fill(0)
      cgR.set(cgB)
      this.precondition(cgR, cgZ)
      cgP.set(cgZ)
      let rz = this.dot(cgR, cgZ)
      let rr = this.dot(cgR, cgR)
      const rrTarget = rr * cgTol * cgTol
      let cgIter = 0
      for (; cgIter < cgMax && rr > rrTarget; cgIter++) {
        this.matvec(cgP, cgAp)
        const pAp = this.dot(cgP, cgAp)
        if (!(pAp > 0)) break
        const alpha = rz / pAp
        rr = 0
        for (let i = 0; i < n; i++) {
          cgX[i] += alpha * cgP[i]
          const ri = cgR[i] - alpha * cgAp[i]
          cgR[i] = ri
          rr += ri * ri
        }
        this.precondition(cgR, cgZ)
        const rzNew = this.dot(cgR, cgZ)
        const beta = rzNew / rz
        rz = rzNew
        for (let i = 0; i < n; i++) cgP[i] = cgZ[i] + beta * cgP[i]
      }
      cgTotal += cgIter
      opts.onNewtonStep?.(outer, residK, cgIter, unstableCells)
      clampedCells = 0

      // --- ステップの適用と擬似時間刻みの適応 ---
      //
      // 線形探索（残差ノルムが減る歩幅を探す）は【使えない】。
      // 氷縁は局所的に不安定なので、平衡に向かう正しい一歩でも
      // その近傍の残差は増えることがある。残差ノルムは単調な指標にならず、
      // 探索が必ず失敗して早期に打ち切られた（ECS が 0.05 になった）。
      //
      // 正しいのは【適応的な陰的時間刻み】。
      // 常に全ステップを適用し、残差が大きく悪化したときだけ差し戻して dt を縮める。
      tPrevStep.set(T)
      for (let i = 0; i < n; i++) {
        const raw = T[i] + cgX[i]
        if (raw <= -120 || raw >= 500) clampedCells++
        T[i] = clamp(raw, -120, 500)
      }
      const newResid = evalResidual(T)

      if (newResid > residK * REJECT_FACTOR && pseudoDt > MIN_PSEUDO_DT) {
        // 悪化しすぎた: 差し戻して刻みを縮める
        T.set(tPrevStep)
        evalResidual(T)
        pseudoDt = Math.max(MIN_PSEUDO_DT, pseudoDt * 0.2)
        stall++
        lastStep = 0
        if (stall >= 12) break
        continue
      }

      stepK = 0
      for (let i = 0; i < n; i++) {
        const d = T[i] - tPrevStep[i]
        const m = d < 0 ? -d : d
        if (m > stepK) stepK = m
      }
      lastStep = 1
      // SER 則: 残差が下がった分だけ刻みを伸ばす。dt -> 無限大 で Newton に一致。
      if (newResid < residK) {
        pseudoDt *= Math.min(6, Math.max(1.3, residK / Math.max(newResid, 1e-30)))
        stall = 0
      } else {
        stall++
      }
      residK = newResid
      if (transient) pseudoDt = dt as number
      // 収束判定は【温度の変化幅】で行う。残差ノルムは尺度が K ではないので使わない。
      if (stepK < tol && clampedCells === 0) { converged = true; break }
      if (stepK < tol && clampedCells > 0) break   // モデルの範囲外（暴走・凍結）
      if (stall >= 12) break   // 停滞したら打ち切る（分岐のごく近傍で起こりうる）
    }

    // 収束後の場（アルベド・氷・地表温度）を最終温度で整合させる
    evalResidual(T)

    Tfield.write.set(T)

    // --- 統計 ---
    const meanT = this.grid.globalMean(T)
    const absorbed = agg.meanS - (agg.meanSaSurface + agg.meanSaIce + agg.meanSaHaze + agg.meanSaClamp)
    const olr = p.A0 + p.B * meanT
      - (agg.gCo2 + agg.gCh4 + agg.gN2 + agg.gRunaway - agg.aerosol)
    let minT = Infinity, maxT = -Infinity
    for (let i = 0; i < n; i++) {
      if (T[i] < minT) minT = T[i]
      if (T[i] > maxT) maxT = T[i]
    }

    return {
      meanT,
      equatorT: this.zonalMeanRow(T, H >> 1),
      poleT: this.zonalMeanRow(T, H - 1),
      minT, maxT,
      iceFraction: iceFrac,
      landFraction: landFrac,
      planetaryAlbedo: agg.meanS > 0 ? 1 - absorbed / agg.meanS : 0,
      reflSurface: agg.meanSaSurface,
      reflIce: agg.meanSaIce,
      reflHaze: agg.meanSaHaze,
      absorbedSW: absorbed,
      olr,
      imbalance: absorbed + g.internalHeatFlux - olr,
      iterations: outer + 1,
      cgIterations: cgTotal,
      unstableCells,
      clampedCells,
      lastStep,
      residual: stepK,
      converged,
      radiative: agg,
    }
  }

  /** 行 y の帯状平均 */
  private zonalMeanRow(T: Float32Array, y: number): number {
    const W = this.grid.W
    let s = 0
    for (let x = 0; x < W; x++) s += T[y * W + x]
    return s / W
  }

  /**
   * 粗い格子で解いてから細かい格子に補間する（nested iteration）。
   *
   * 冷間開始（一様な初期温度から）は Newton も CG も多くの反復を要する。
   * 1/4 の格子で解いてから内挿すれば、細格子側は数反復で済む。
   * 粗格子のコストは 1/4 なので、全体で 3〜5 倍速くなる。
   */
  static solveNested(
    grid: Grid, store: FieldStore, p: PlanetParams, g: PlanetGlobals,
    opts: SolveOptions, makeStore: (grid: Grid) => FieldStore,
  ): ClimateStats {
    const { W, H } = grid
    if (W >= 128 && H >= 64 && W % 2 === 0 && H % 2 === 0) {
      const cw = W >> 1, ch = H >> 1
      if (cw % 8 === 0 && ch % 8 === 0) {
        const cGrid = new Grid(cw, ch)
        const cStore = makeStore(cGrid)
        // 標高を粗格子に平均で落とす
        const eSrc = store.f32("elevation").read
        const eDst = cStore.f32("elevation").read
        for (let y = 0; y < ch; y++)
          for (let x = 0; x < cw; x++) {
            const a = (2 * y) * W + 2 * x
            eDst[y * cw + x] = 0.25 * (eSrc[a] + eSrc[a + 1] + eSrc[a + W] + eSrc[a + W + 1])
          }
        cStore.f32("temperature").read.fill(15)
        cStore.f32("albedo").read.fill(0.3)
        const cClim = new Climate(cGrid)
        cClim.solve(cStore, p, g, opts)
        // 温度を細格子に最近傍で持ち上げる（CG の初期値なので精度は要らない）
        const tSrc = cStore.f32("temperature").read
        const tDst = store.f32("temperature").read
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) tDst[y * W + x] = tSrc[(y >> 1) * cw + (x >> 1)]
      }
    }
    return new Climate(grid).solve(store, p, g, opts)
  }

  /** 帯状平均気温（緯度プロファイルの検査用） */
  zonalMean(store: FieldStore): Float64Array {
    const { W, H } = this.grid
    const T = store.f32("temperature").read
    const out = new Float64Array(H)
    for (let y = 0; y < H; y++) {
      let s = 0
      for (let x = 0; x < W; x++) s += T[y * W + x]
      out[y] = s / W
    }
    return out
  }
}

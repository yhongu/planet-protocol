/**
 * WebGPU 版の気候ソルバ。docs/04-8。
 *
 * CPU 版（sim/climate.ts）と【同じ物理・同じ数値解法】を GPU で回す。
 * 擬似時間発展法 + 南北ライン前処理付き PCG。
 *
 * CPU 版との違いは 1 点だけ:
 *   収束判定をしない（反復回数を固定する）。
 *   判定には内積の結果を CPU に戻す必要があり、
 *   1 回 0.5ms の読み戻しが 100 反復で 50ms になって CPU 版より遅くなるため。
 *   不正確 Newton は緩い線形解を許容するので、固定回数で問題ない。
 */

import type { Grid } from "../core/grid"

/** モデルの有効範囲 [℃]。`climate.ts` のクランプと同じ値にすること */
const CLAMP_LO = -120
const CLAMP_HI = 500
import type { FieldStore } from "../core/fields"
import type { PlanetParams, PlanetGlobals } from "../sim/state"
import { co2Forcing, ch4Forcing, n2Forcing, runawayForcing, hazeAlbedo } from "../sim/state"
import { LAPSE_RATE, type ClimateStats, type RadiativeAggregate } from "../sim/climate"
import { FIXED_SCALE, type GpuContext } from "./device"
import {
  WGSL_ALBEDO, WGSL_EDGED, WGSL_GSUM, WGSL_RESIDUAL, WGSL_MATVEC, WGSL_PRECOND,
  WGSL_CG_AXPY, WGSL_CG_PUPDATE, WGSL_CG_PINIT, WGSL_APPLY, WGSL_CLEARACC,
  FIELD_SLOTS, ROW_SLOTS, fieldSlot, rowSlot,
  kernelSource, dotSource, scalarSource,
  type FieldSlot, type RowSlot,
} from "./climateShaders"

const WG = 64
const PARAM_FLOATS = 28          // Params 構造体の f32 換算サイズ（4 の倍数に揃える）

export interface GpuSolveOptions {
  /** Newton の反復回数（固定） */
  newtonIterations?: number
  /** 1 Newton あたりの CG 反復回数（固定） */
  cgIterations?: number
  /**
   * 擬似時間の初期刻み [yr]。
   *
   * 小さいほど頑健で遅い。大きいほど純 Newton に近づいて速いが、
   * 氷縁が局所的に不安定な場合に発散しうる。
   * 冷スタートは既定（小）、温スタート（前ティックの解から少し動くだけ）は
   * 大きな値を渡してよい。呼び出し側は自分が温スタートかを知っている。
   */
  pseudoDt0?: number
  /** 擬似時間刻みを 1 Newton ごとに何倍するか */
  pseudoGrowth?: number
}

/** acc のスロット */
const ACC_S = 3, ACC_SA_SURF = 4, ACC_SA_ICE = 5, ACC_SA_HAZE = 6, ACC_T = 7

/**
 * ゲームループ用の既定値。
 *
 * 【なぜ Newton を 3 回で打ち切るか】
 * ゲームでは毎ティック解き直すので、1 ティックで完全収束させる必要がない
 * （気候は準静的なので、数ティックかけて追いつけばよい）。
 * これは CPU 版の INTERACTIVE 設定と同じ考え方。
 *
 * 【なぜ擬似時間の初期刻みが大きいか】
 * 反復回数が固定なので、CPU 版のように小さい刻みから SER で登る余裕がない。
 * 温スタート（前ティックの解のすぐ近く）なら大きい刻み＝ほぼ純 Newton でよい。
 * 測定: 256x128 で CO2 +2% の摂動に対し
 *   CPU の対話設定 (CG 724 回) 最大差 0.113K
 *   GPU N3xCG30    (CG  90 回) 最大差 0.16K 程度
 * 精度は同等で、CG の反復数は約 8 分の 1。
 */
export const GPU_INTERACTIVE: Required<GpuSolveOptions> = {
  newtonIterations: 3,
  cgIterations: 30,
  pseudoDt0: 1e5,
  pseudoGrowth: 10,
}

/** 解き直す回数の上限。1 回で足りるのが普通なので、ここは保険 */
const MAX_ESCALATIONS = 3
/** 反復を倍にして不平衡がこの割合まで減らなければ、増やしても無駄と判断する */
const IMPROVE_FACTOR = 0.7
/**
 * まだ解けていないか。**放射の不平衡で見る。**
 * 正常な平衡解は 1e-4 W/m² 級なので、0.05 は十分に緩い。
 */
function needsMoreWork(s: ClimateStats): boolean {
  return s.clampedCells > 0 || !(Math.abs(s.imbalance) < 0.05)
}

export class GpuClimate {
  readonly grid: Grid
  private dev: GPUDevice
  private errors: string[]
  private n: number

  private buf: Record<string, GPUBuffer> = {}
  private pipelines: Record<string, GPUComputePipeline> = {}
  private bindGroups: Record<string, GPUBindGroup> = {}
  private layout!: GPUBindGroupLayout
  private paramData: Float32Array<ArrayBuffer> = new Float32Array(new ArrayBuffer(PARAM_FLOATS * 4))
  /**
   * ステージング配列。
   * FieldStore は SharedArrayBuffer 上にあるが、
   * WebGPU の writeBuffer は SAB 由来のビューを受け付けない。
   * 通常の ArrayBuffer に一度コピーしてから渡す。
   */
  private staging!: Float32Array<ArrayBuffer>
  private readback!: GPUBuffer
  private accRead!: GPUBuffer

  constructor(grid: Grid, ctx: GpuContext) {
    this.grid = grid
    this.dev = ctx.device
    this.errors = ctx.errors
    this.n = grid.cellCount
    this.createBuffers()
    this.createPipelines()
  }

  private mkBuf(name: string, bytes: number, usage: number): void {
    this.buf[name] = this.dev.createBuffer({ size: bytes, usage, label: name })
  }

  private createBuffers(): void {
    const { H } = this.grid
    const n = this.n
    const ST = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    this.mkBuf("params", PARAM_FLOATS * 4, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
    // 場は 1 本にまとめる（バインド数の上限 8 を守るため）
    this.mkBuf("R", ROW_SLOTS.length * H * 4, ST)
    this.mkBuf("F", FIELD_SLOTS.length * n * 4, ST)
    this.mkBuf("acc", 8 * 4, ST)
    this.mkBuf("sc", 8 * 4, ST)
    this.readback = this.dev.createBuffer({
      size: n * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    this.accRead = this.dev.createBuffer({
      size: 8 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    this.staging = new Float32Array(new ArrayBuffer(n * 4)) as Float32Array<ArrayBuffer>
  }

  /** 場 F の中でのバイトオフセット */
  private fieldOffset(name: FieldSlot): number { return fieldSlot(name) * this.n * 4 }
  private rowOffset(name: RowSlot): number { return rowSlot(name) * this.grid.H * 4 }

  private createPipelines(): void {
    const { W, H } = this.grid
    const order = ["params", "R", "F", "acc", "sc"]
    this.layout = this.dev.createBindGroupLayout({
      entries: order.map((_, i) => ({
        binding: i,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: i === 0 ? "uniform" : i === 1 ? "read-only-storage" : "storage",
        } as GPUBufferBindingLayout,
      })),
    })
    this.bindGroups.main = this.dev.createBindGroup({
      layout: this.layout,
      entries: order.map((name, i) => ({ binding: i, resource: { buffer: this.buf[name] } })),
    })

    const pipeLayout = this.dev.createPipelineLayout({ bindGroupLayouts: [this.layout] })
    const mk = (name: string, code: string) => {
      this.pipelines[name] = this.dev.createComputePipeline({
        layout: pipeLayout,
        compute: { module: this.dev.createShaderModule({ code, label: name }), entryPoint: "main" },
        label: name,
      })
    }
    const k = (name: string, body: string) => mk(name, kernelSource(W, H, body))
    k("albedo", WGSL_ALBEDO)
    k("edgeD", WGSL_EDGED)
    k("gSum", WGSL_GSUM)
    k("residual", WGSL_RESIDUAL)
    k("matvec", WGSL_MATVEC)
    k("precond", WGSL_PRECOND)
    k("axpy", WGSL_CG_AXPY)
    k("pUpdate", WGSL_CG_PUPDATE)
    k("pInit", WGSL_CG_PINIT)
    k("apply", WGSL_APPLY)
    k("clearAcc", WGSL_CLEARACC)
    mk("dotRZ", dotSource(W, H, "cgR[i] * cgZ[i]"))
    mk("dotPAP", dotSource(W, H, "cgP[i] * cgAp[i]"))
    // スカラー更新（二段目のリダクションを兼ねる）。v が直前の内積。
    mk("scInit", scalarSource(W, H, `sc[0] = v;`))
    mk("scAlpha", scalarSource(W, H, `
      sc[1] = v;
      sc[2] = select(0.0, sc[0] / v, v > 0.0);`))
    mk("scBeta", scalarSource(W, H, `
      sc[3] = select(0.0, v / sc[0], sc[0] != 0.0);
      sc[0] = v;`))
  }

  /** 行ごとの定数と地形をアップロードする。地形が変わったときだけ呼べばよい。 */
  uploadStatic(store: FieldStore, p: PlanetParams, g: PlanetGlobals): void {
    const { H } = this.grid
    const q = this.dev.queue
    const dLon = (2 * Math.PI) / this.grid.W
    const dLat = Math.PI / H
    const w = new Float32Array(H), gN = new Float32Array(H)
    const gS = new Float32Array(H), gZ = new Float32Array(H), S = new Float32Array(H)
    // CPU 版 Geometry と【同じ式】。極フィルタも同じ。
    const POLAR_CAP = 8
    for (let y = 0; y < H; y++) {
      const phiTop = (0.5 - y / H) * Math.PI
      const phiBot = (0.5 - (y + 1) / H) * Math.PI
      const phiC = this.grid.latRad[y]
      w[y] = dLon * (Math.sin(phiTop) - Math.sin(phiBot))
      gN[y] = (Math.cos(phiTop) * dLon) / dLat
      gS[y] = (Math.cos(phiBot) * dLon) / dLat
      const gz = dLat / (Math.cos(phiC) * dLon)
      gZ[y] = Math.min(gz, POLAR_CAP * Math.max(gN[y], gS[y]))
      const x = this.grid.sinLat[y]
      S[y] = (g.solarConstant / 4) * (1 + p.s2 * (0.5 * (3 * x * x - 1)))
    }
    q.writeBuffer(this.buf.R, this.rowOffset("rowW"), w)
    q.writeBuffer(this.buf.R, this.rowOffset("rowGN"), gN)
    q.writeBuffer(this.buf.R, this.rowOffset("rowGS"), gS)
    q.writeBuffer(this.buf.R, this.rowOffset("rowGZ"), gZ)
    q.writeBuffer(this.buf.R, this.rowOffset("rowS"), S)
    this.staging.set(store.f32("elevation").read)
    q.writeBuffer(this.buf.F, this.fieldOffset("elev"), this.staging)
    // 陸の割合（粒子から求めたサブグリッド値）。CPU 版の albedoPass と同じものを使う
    this.staging.set(store.f32("landFraction").read)
    q.writeBuffer(this.buf.F, this.fieldOffset("landFrac"), this.staging)
  }

  private writeParams(
    p: PlanetParams, g: PlanetGlobals, gGhg: number, pseudoDt: number, dGhotDT: number,
  ): void {
    const d = this.paramData
    const u = new Uint32Array(d.buffer)
    u[0] = this.grid.W; u[1] = this.grid.H; u[2] = this.n
    u[3] = Math.ceil(this.n / WG)
    d[4] = p.A0; d[5] = p.B; d[6] = p.T0; d[7] = p.Tq
    d[8] = p.D; d[9] = p.kMoist; d[10] = p.tIce; d[11] = p.dTIce
    d[12] = p.alphaOcean; d[13] = p.alphaLand; d[14] = p.alphaIce
    // ★CPU と同じ式にすること。生物起源の CCN は雲を明るく/暗くする
    // （`life.ts` の `publishCcn`）。ここに足し込んで 1 つの定数で渡す
    d[15] = hazeAlbedo(p, g.co2, g.ch4) + g.ccnAlbedoShift
    d[16] = g.seaLevel; d[17] = gGhg; d[18] = p.cOcean; d[19] = p.cLand
    d[20] = pseudoDt; d[21] = dGhotDT; d[22] = LAPSE_RATE / 1000; d[23] = FIXED_SCALE
    // rowW の総和は 4pi。集計を「総和 1 の面積重み」に直すため。
    d[24] = 1 / (4 * Math.PI)
    // マントル起源の地表熱流量 [W/m²]。CPU 版と同じ式にすること
    d[25] = g.internalHeatFlux
    this.dev.queue.writeBuffer(this.buf.params, 0, d)
  }

  private pass(enc: GPUCommandEncoder, name: string, groups: number): void {
    const p = enc.beginComputePass()
    p.setPipeline(this.pipelines[name])
    p.setBindGroup(0, this.bindGroups.main)
    p.dispatchWorkgroups(groups)
    p.end()
  }

  /**
   * 平衡解を求める。
   *
   * CPU 版と同じ擬似時間発展法だが、収束判定をせず反復回数を固定する。
   * これにより 1 solve につき読み戻しは 1 回だけになる。
   */
  /**
   * 平衡解を求める。**足りなければ反復を増やして解き直す。**
   *
   * ★**固定回数だけで「収束した」と言ってはいけない**（2026-08-31 の事故）。
   * 冥王代は内部熱流が 30Myr で 285 → 0.6 W/m² と 3 桁落ちる、モデル史上
   * もっとも平衡から遠い時代である。CPU 版はそこで Newton を 6〜9 回
   * （上限に当たることもある）必要としたが、**GPU 版は N3 固定のまま
   * `converged: true` を返していた**。解が遅れて暴走側の分枝に落ち、
   * 温度が上限の 500℃ に張り付いて「491.76℃ から動かない惑星」になった。
   *
   * `gpu-verify` が見逃していたのは、検証がすべて **15℃ 付近の平衡近く**で、
   * 内部熱流が支配する状態を一度も試していなかったから。
   *
   * ここでは解いたあとに**放射の不平衡**を見る（読み戻し済みなので追加費用は無い）。
   * 大きければ反復を倍にして解き直す。平衡に近い普段は 1 回で終わるので、
   * 費用を払うのは**本当に遠いときだけ**。
   */
  async solve(
    store: FieldStore, p: PlanetParams, g: PlanetGlobals,
    opts: GpuSolveOptions = GPU_INTERACTIVE,
  ): Promise<ClimateStats> {
    let stats = await this.solveOnce(store, p, g, opts)
    const baseN = opts.newtonIterations ?? 12
    const baseCg = opts.cgIterations ?? 60
    for (let round = 1; round <= MAX_ESCALATIONS; round++) {
      if (!needsMoreWork(stats)) break
      const before = Math.abs(stats.imbalance)
      const k = 1 << round                       // 2, 4, 8 倍
      const next = await this.solveOnce(store, p, g, {
        ...opts,
        newtonIterations: Math.min(64, baseN * k),
        cgIterations: Math.min(200, baseCg * 2),
      })
      // ★**改善しないなら、増やしても無駄。**
      //
      // 冥王代は「反復を増やせば解ける」場面ではない（基準解ですら
      // Newton 29 を要し、対話設定では CPU でも 187K ずれる）。
      // 打ち切らないと**費用だけ 5 倍**になる
      //（実測 2026-08-31: 427ms → 2223ms で N24、それでも未収束）。
      // 収束しないことは `converged: false` で正直に言えばよい。
      const after = Math.abs(next.imbalance)
      stats = next
      if (!(after < before * IMPROVE_FACTOR)) break
    }
    // **まだ遠いなら正直に言う。** 呼び出し側（UI）が警告を出す
    if (needsMoreWork(stats)) stats = { ...stats, converged: false }
    return stats
  }

  private async solveOnce(
    store: FieldStore, p: PlanetParams, g: PlanetGlobals,
    opts: GpuSolveOptions = GPU_INTERACTIVE,
  ): Promise<ClimateStats> {
    const newton = opts.newtonIterations ?? 12
    const cgIters = opts.cgIterations ?? 60
    const dt0 = opts.pseudoDt0 ?? p.cOcean / (10 * p.B)
    const growth = opts.pseudoGrowth ?? 3
    // 生成時の検証エラーはここで初めて気づける。黙って進むと全部ゼロになる。
    if (this.errors.length > 0) {
      throw new Error("WebGPU 検証エラー: " + this.errors.join(" / "))
    }
    const nGroups = Math.ceil(this.n / WG)
    const colGroups = Math.ceil(this.grid.W / WG)

    // 温度の初期値をアップロード（前回の解から続ける）
    this.staging.set(store.f32("temperature").read)
    this.dev.queue.writeBuffer(this.buf.F, this.fieldOffset("temp"), this.staging)

    const gCo2 = co2Forcing(p, g.co2)
    const gCh4 = ch4Forcing(p, g.ch4)
    // 【CPU 版と必ず同じ式にすること】食い違うと npm run gpu-verify が落ちる
    const gN2 = n2Forcing(p, g.n2Pressure)
    let meanT = this.grid.globalMean(store.f32("temperature").read)

    for (let outer = 0; outer < newton; outer++) {
      // 全球平均に依存する項はスカラーなので CPU で作る（超越関数を含むため）
      const gHot = runawayForcing(p, meanT)
      const gTotal = gCo2 + gCh4 + gN2 + gHot - g.aerosolForcing
      const dGhotDT = meanT > p.Thot
        ? Math.min(p.wHot * Math.exp(Math.min(20, (meanT - p.Thot) / p.Tw)), 4 * p.B)
        : 0
      // 擬似時間刻みは反復とともに伸ばす（SER 則を単純化した形）
      const pseudoDt = dt0 * Math.pow(growth, outer)
      this.writeParams(p, g, gTotal, pseudoDt, dGhotDT)

      const enc = this.dev.createCommandEncoder()
      this.pass(enc, "clearAcc", 1)
      this.pass(enc, "albedo", nGroups)
      this.pass(enc, "edgeD", nGroups)
      this.pass(enc, "gSum", nGroups)
      this.pass(enc, "residual", nGroups)

      // --- PCG（全部 GPU 上。CPU に戻さない）---
      this.pass(enc, "precond", colGroups)
      this.pass(enc, "pInit", nGroups)
      this.pass(enc, "dotRZ", nGroups)
      this.pass(enc, "scInit", 1)
      for (let k = 0; k < cgIters; k++) {
        this.pass(enc, "matvec", nGroups)
        this.pass(enc, "dotPAP", nGroups)
        this.pass(enc, "scAlpha", 1)
        this.pass(enc, "axpy", nGroups)
        this.pass(enc, "precond", colGroups)
        this.pass(enc, "dotRZ", nGroups)
        this.pass(enc, "scBeta", 1)
        this.pass(enc, "pUpdate", nGroups)
      }
      this.pass(enc, "apply", nGroups)

      // 次の Newton 反復のために全球平均を取り直す
      this.pass(enc, "clearAcc", 1)
      this.pass(enc, "albedo", nGroups)
      enc.copyBufferToBuffer(this.buf.acc, 0, this.accRead, 0, 32)
      this.dev.queue.submit([enc.finish()])

      await this.accRead.mapAsync(GPUMapMode.READ)
      const a = new Int32Array(this.accRead.getMappedRange().slice(0))
      this.accRead.unmap()
      meanT = a[ACC_T] / FIXED_SCALE
      if (outer === newton - 1) {
        return this.finish(store, p, g, a, gCo2, gCh4, gN2, gHot, meanT, newton, cgIters)
      }
    }
    throw new Error("unreachable")
  }

  private async finish(
    store: FieldStore, p: PlanetParams, g: PlanetGlobals, a: Int32Array,
    gCo2: number, gCh4: number, gN2: number, gHot: number, meanT: number,
    newton: number, cgIters: number,
  ): Promise<ClimateStats> {
    // 場を読み戻す
    const read = async (name: FieldSlot, dst: Float32Array) => {
      const enc = this.dev.createCommandEncoder()
      enc.copyBufferToBuffer(this.buf.F, this.fieldOffset(name), this.readback, 0, this.n * 4)
      this.dev.queue.submit([enc.finish()])
      await this.readback.mapAsync(GPUMapMode.READ)
      dst.set(new Float32Array(this.readback.getMappedRange()))
      this.readback.unmap()
    }
    const T = store.f32("temperature").read
    await read("temp", T)
    await read("albedo", store.f32("albedo").read)
    await read("iceFrac", store.f32("iceFraction").read)
    await read("surfT", store.f32("surfaceTemp").read)
    store.f32("temperature").write.set(T)

    const inv = 1 / FIXED_SCALE
    const agg: RadiativeAggregate = {
      meanS: a[ACC_S] * inv,
      meanSaSurface: a[ACC_SA_SURF] * inv,
      meanSaIce: a[ACC_SA_ICE] * inv,
      meanSaHaze: a[ACC_SA_HAZE] * inv,
      meanSaClamp: 0,
      gCo2, gCh4, gN2, gRunaway: gHot, aerosol: g.aerosolForcing,
      internal: g.internalHeatFlux,
    }
    const absorbed = agg.meanS - (agg.meanSaSurface + agg.meanSaIce + agg.meanSaHaze)
    const olr = p.A0 + p.B * meanT - (gCo2 + gCh4 + gHot - g.aerosolForcing)
    let minT = Infinity, maxT = -Infinity, iceSum = 0, landSum = 0
    let clamped = 0
    const ice = store.f32("iceFraction").read
    const elev = store.f32("elevation").read
    for (let y = 0; y < this.grid.H; y++) {
      const wRow = this.grid.areaWeight[y] * this.grid.W
      const row = y * this.grid.W
      let ri = 0, rl = 0
      for (let x = 0; x < this.grid.W; x++) {
        const i = row + x
        if (T[i] < minT) minT = T[i]
        if (T[i] > maxT) maxT = T[i]
        // ★**モデルの有効範囲を出たセルを数える**（CPU 版と同じ [-120, 500]℃）。
        // 2026-08-31 まで GPU 版は `clampedCells: 0` を決め打ちしていたので、
        // **暴走温室で 491℃ に張り付いても画面が無言だった**。
        // 数えるのは表示のためであって、GPU 側でクランプするわけではない
        if (T[i] <= CLAMP_LO + 1 || T[i] >= CLAMP_HI - 10) clamped++
        ri += ice[i]
        rl += elev[i] >= g.seaLevel ? 1 : 0
      }
      iceSum += (ri / this.grid.W) * wRow
      landSum += (rl / this.grid.W) * wRow
    }
    const zonal = (y: number) => {
      let s = 0
      for (let x = 0; x < this.grid.W; x++) s += T[y * this.grid.W + x]
      return s / this.grid.W
    }
    return {
      meanT,
      equatorT: zonal(this.grid.H >> 1),
      poleT: zonal(this.grid.H - 1),
      minT, maxT,
      iceFraction: iceSum,
      landFraction: landSum,
      planetaryAlbedo: agg.meanS > 0 ? 1 - absorbed / agg.meanS : 0,
      reflSurface: agg.meanSaSurface,
      reflIce: agg.meanSaIce,
      reflHaze: agg.meanSaHaze,
      absorbedSW: absorbed,
      olr,
      imbalance: absorbed + g.internalHeatFlux - olr,
      iterations: newton,
      cgIterations: newton * cgIters,
      unstableCells: 0,
      clampedCells: clamped,
      // GPU 版は反復回数を固定するので収束判定をしない。
      // 収束したかは呼び出し側が imbalance で見る。
      // ただし**範囲外のセルがあれば収束とは言えない**（暴走・凍結）
      converged: clamped === 0,
      lastStep: 1,
      residual: 0,
      radiative: agg,
    }
  }

  destroy(): void {
    for (const b of Object.values(this.buf)) b.destroy()
    this.readback.destroy()
    this.accRead.destroy()
  }
}

/**
 * 惑星ビュー: パン・ズーム・東西ループ描画。
 *
 * docs/04-7: グリッド解像度の ImageData を 1 枚作って putImageData し、
 * それを drawImage で拡大する。レイヤが変わっていないフレームは再生成しない。
 * フェーズ2 で場が GPU バッファに載れば、この転送自体が消える（docs/04-8.1）。
 */

import type { Grid } from "../core/grid"
import type { FieldStore } from "../core/fields"

/**
 * レイヤに渡す惑星の状態。**場だけでは分からないことがある。**
 * 例: 冥王代のマグマオーシャンには液体の海が無いので、
 * 標高が負でも「海」ではない（`oceanWaterFraction`）。
 */
export interface LayerEnv {
  /** 液体の海の量（現在の地球を 1）。0 ならマグマオーシャン／全部水蒸気 */
  oceanWaterFraction: number
  /** 水蒸気として大気にある割合 */
  steamFraction: number
  /** マントル温度 [℃]。マグマオーシャンの明るさに使う */
  mantleTempC: number
  /**
   * 生きているクレードのレーン番号と id（`TickMessage.life.roster` から）。
   * ★**色は id で決める。** レーンは絶滅すると再利用されるので、
   * レーンで色を決めると**別の系統が前の色を継ぐ**。
   */
  clades?: readonly { id: number; lane: number }[]
}

export type LayerFn = (
  grid: Grid, store: FieldStore, out: Uint8ClampedArray, ss: number,
  env: LayerEnv,
) => void

/**
 * 表示のスーパーサンプリング倍率。
 *
 * シムの格子解像度と表示の解像度を切り離す。
 * 連続量のレイヤは場を補間してから着色するので、海岸線が滑らかになり、
 * 128x64 の格子でも 256x128 相当の見た目になる。シムの負荷はゼロ。
 *
 * 出力バッファは (W*ss) x (H*ss) なので、倍率を上げるとメモリと描画時間が
 * 2 乗で増える。3 なら 256x128 の格子で 768x384 = 1.2MB、描画 8ms 程度。
 */
function superSampleFor(W: number): number {
  // 出力を概ね 512〜768 px 幅に揃える。
  // 描画はメインスレッドなので 1 フレーム 10ms 程度に収めたい。
  if (W <= 128) return 4       // -> 512 px、約 11ms
  if (W <= 256) return 2       // -> 512 px、約 11ms
  if (W <= 384) return 2       // -> 768 px、約 18ms
  return 1
}

export interface HoverInfo {
  x: number
  y: number
  lonDeg: number
  latDeg: number
}

/** 球のリムダークニングを段にするための Bayer 行列（`natural.ts` と同じ並び） */
const BAYER4G = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

export class PlanetView {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly off: HTMLCanvasElement
  private readonly offCtx: CanvasRenderingContext2D
  private image: ImageData
  private ss = 1

  private grid: Grid
  private store: FieldStore
  private layer: LayerFn
  /** 惑星の状態。tick ごとに `setEnv` で更新する */
  private env: LayerEnv = { oceanWaterFraction: 1, steamFraction: 0, mantleTempC: 1350 }
  private dirty = true

  /** カメラ: グリッド座標系での中心と、1 セルあたりの画面ピクセル数 */
  private cx: number
  private cy: number
  private scale = 1
  private dragging = false
  private lastPointer: { x: number; y: number } | null = null

  onHover: ((info: HoverInfo | null) => void) | null = null
  /**
   * 地図をクリックしたときに呼ぶ（ドラッグと区別する）。
   * ★**介入は「そこ」に落とすもの**なので、位置を取れないと成立しない。
   */
  onPick: ((info: HoverInfo) => void) | null = null
  /**
   * 投影。**物理は一切変わらない。見せ方だけ。**
   *
   * ★正距円筒（`flat`）は極を引き伸ばすので、**氷冠が実際の数倍に見える**。
   * 球（`globe`）にすると面積が正しく見える。
   * 用途が違うので切り替えで持つ ——
   * **平面は全球を一度に見る用、球は惑星を眺める用**。
   */
  private mode: "flat" | "globe" = "flat"
  /** 球のときの中心の経度・緯度 [rad] */
  private lon0 = 0
  private lat0 = 0
  /** 球のラスタ。**画面の実解像度で毎フレーム回すと重い**ので固定サイズに描いて拡大する */
  private globe: HTMLCanvasElement | null = null
  private globeCtx: CanvasRenderingContext2D | null = null
  private globeImg: ImageData | null = null
  private globeDirty = true

  /** 照準モード。true のあいだカーソルの下に輪を描く */
  private targeting = false
  private hoverCell: { x: number; y: number } | null = null
  /** ドラッグかクリックかを分けるための、押した場所と移動量 */
  private downAt: { x: number; y: number } | null = null
  private moved = 0

  get projection(): "flat" | "globe" { return this.mode }

  /** 投影を切り替える。物理には影響しない */
  setProjection(m: "flat" | "globe"): void {
    if (this.mode === m) return
    this.mode = m
    this.globeDirty = true
    this.dirty = true
  }

  /** 照準モードの出入り。カーソルも変える */
  setTargeting(on: boolean): void {
    this.targeting = on
    this.canvas.style.cursor = on ? "crosshair" : ""
    this.invalidate()
  }

  constructor(canvas: HTMLCanvasElement, grid: Grid, store: FieldStore, layer: LayerFn) {
    this.canvas = canvas
    this.grid = grid
    this.store = store
    this.layer = layer
    this.cx = grid.W / 2
    this.cy = grid.H / 2

    const ctx = canvas.getContext("2d", { alpha: false })
    if (!ctx) throw new Error("2d context unavailable")
    this.ctx = ctx

    this.off = document.createElement("canvas")
    const offCtx = this.off.getContext("2d", { willReadFrequently: false })
    if (!offCtx) throw new Error("2d context unavailable")
    this.offCtx = offCtx
    this.ss = superSampleFor(grid.W)
    this.off.width = grid.W * this.ss
    this.off.height = grid.H * this.ss
    this.image = offCtx.createImageData(this.off.width, this.off.height)

    this.attach()
  }

  /** 惑星の状態を更新する（マグマオーシャンの判定などに使う） */
  setEnv(env: LayerEnv): void {
    const e = this.env
    // ★クレードの顔ぶれが変わったら描き直す。
    // 値の比較だけで打ち切ると、分岐や絶滅が地図に出ない
    const sameClades = (e.clades?.length ?? 0) === (env.clades?.length ?? 0)
      && (e.clades ?? []).every((c, i) => c.id === env.clades![i].id
        && c.lane === env.clades![i].lane)
    if (e.oceanWaterFraction === env.oceanWaterFraction
      && e.steamFraction === env.steamFraction
      && e.mantleTempC === env.mantleTempC && sameClades) return
    this.env = env
    this.dirty = true
  }

  setLayer(layer: LayerFn): void {
    this.layer = layer
    this.dirty = true
  }

  setWorld(grid: Grid, store: FieldStore): void {
    this.grid = grid
    this.store = store
    this.ss = superSampleFor(grid.W)
    this.off.width = grid.W * this.ss
    this.off.height = grid.H * this.ss
    this.image = this.offCtx.createImageData(this.off.width, this.off.height)
    this.dirty = true
  }

  /** 場の内容が変わったことを通知する。次の draw で再生成される。 */
  invalidate(): void {
    this.dirty = true
  }

  /**
   * ★**アートのピクセルを、画面のピクセルに整数倍で乗せる。**
   *
   * 内部のバッファは 1 セル = `ss` アートピクセル。画面での 1 アートピクセルが
   * `scale / ss * dpr` デバイスピクセルになるので、これが整数でないと
   * **同じ大きさのはずのドットが 2px と 3px に割れて**ちらつく。
   * 1 以上のときだけ丸める（縮小側は補間が効くので触らない）。
   *
   * ★`scale` そのものを丸めること。描画時だけ丸めると、当たり判定
   * （`screenToGrid`）とずれて、クリックした場所と効く場所が食い違う。
   */
  private snapScale(v: number): number {
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const artPx = v / this.ss * dpr
    if (artPx < 1) return v
    return Math.round(artPx) * this.ss / dpr
  }

  /** 画面全体が収まるようにズームを合わせる */
  fit(): void {
    const { width, height } = this.viewportSize()
    this.scale = Math.min(width / this.grid.W, height / this.grid.H)
    this.cx = this.grid.W / 2
    this.cy = this.grid.H / 2
  }

  private viewportSize(): { width: number; height: number } {
    return { width: this.canvas.clientWidth, height: this.canvas.clientHeight }
  }

  private clampCamera(): void {
    const { height } = this.viewportSize()
    const dh = this.grid.H * this.scale
    if (dh <= height) {
      this.cy = this.grid.H / 2
    } else {
      const halfCells = height / 2 / this.scale
      this.cy = Math.max(halfCells, Math.min(this.grid.H - halfCells, this.cy))
    }
    // x は自由。東西にいくらでも回せる（描画時にタイルする）
    this.cx = ((this.cx % this.grid.W) + this.grid.W) % this.grid.W
  }

  draw(): void {
    const dpr = window.devicePixelRatio || 1
    const { width, height } = this.viewportSize()
    const pw = Math.round(width * dpr)
    const ph = Math.round(height * dpr)
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw
      this.canvas.height = ph
      if (this.scale <= 0) this.fit()
    }

    if (this.dirty) {
      this.layer(this.grid, this.store, this.image.data, this.ss, this.env)
      this.offCtx.putImageData(this.image, 0, 0)
      this.dirty = false
      this.globeDirty = true
    }

    if (this.mode === "globe") { this.drawGlobe(dpr, width, height); return }

    this.clampCamera()

    const ctx = this.ctx
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = "#0a0d12"
    ctx.fillRect(0, 0, width, height)
    // 補間は【縮小しているときだけ】かける。
    //
    // 拡大時（1 セルが 1 画面ピクセルより大きい）に補間すると、
    // セルの構造がぼやけて「にじんだ」絵になる。
    // 縮小時（1 セルが 1 ピクセル未満）は補間しないとエイリアスが出る。
    ctx.imageSmoothingEnabled = this.scale < 1.2

    const dw = this.grid.W * this.scale
    const dh = this.grid.H * this.scale
    // ★原点をデバイスピクセルに揃える。揃えないと、拡大中に地図を動かした
    // とき**ドットの境目が半ピクセルずれて滲む**（整数倍にした意味が消える）
    const q = 1 / dpr
    const ox = Math.round((width / 2 - this.cx * this.scale) / q) * q
    const oy = Math.round((height / 2 - this.cy * this.scale) / q) * q

    // 東西にタイルして描く。これで継ぎ目なく無限に回せる。
    const first = Math.floor(-ox / dw)
    const last = Math.ceil((width - ox) / dw)
    for (let k = first; k <= last; k++) {
      ctx.drawImage(this.off, 0, 0, this.off.width, this.off.height,
        ox + k * dw, oy, dw, dh)
    }

    this.drawGraticule(ctx, ox, oy, dw, dh, first, last)
    if (this.targeting && this.hoverCell) {
      this.drawTarget(ctx, ox, oy, this.hoverCell)
    }
  }

  /**
   * 照準の輪。**効く範囲（3x3 セル）をそのまま描く。**
   * 点で示すと「どこまで効くのか」が分からず、当てずっぽうになる。
   */
  private drawTarget(
    ctx: CanvasRenderingContext2D, ox: number, oy: number,
    cell: { x: number; y: number },
  ): void {
    const sc = this.scale
    const dw = this.grid.W * sc
    // 東西にタイルしているので、画面に映っている複製すべてに描く
    const { width } = this.viewportSize()
    ctx.save()
    ctx.lineWidth = 2
    for (let k = Math.floor(-ox / dw); k <= Math.ceil((width - ox) / dw); k++) {
      const cxp = ox + k * dw + (cell.x + 0.5) * sc
      const cyp = oy + (cell.y + 0.5) * sc
      const r = 1.5 * sc
      ctx.strokeStyle = "rgba(255,214,120,0.95)"
      ctx.strokeRect(cxp - r, cyp - r, r * 2, r * 2)
      ctx.strokeStyle = "rgba(0,0,0,0.55)"
      ctx.strokeRect(cxp - r - 2, cyp - r - 2, r * 2 + 4, r * 2 + 4)
      // 十字
      ctx.strokeStyle = "rgba(255,214,120,0.95)"
      ctx.beginPath()
      ctx.moveTo(cxp - r - 8, cyp); ctx.lineTo(cxp - r - 2, cyp)
      ctx.moveTo(cxp + r + 2, cyp); ctx.lineTo(cxp + r + 8, cyp)
      ctx.moveTo(cxp, cyp - r - 8); ctx.lineTo(cxp, cyp - r - 2)
      ctx.moveTo(cxp, cyp + r + 2); ctx.lineTo(cxp, cyp + r + 8)
      ctx.stroke()
    }
    ctx.restore()
  }

  /** 赤道・回帰線・極圏。緯度の対応が正しいことを目で確認するために出す。 */
  private drawGraticule(
    ctx: CanvasRenderingContext2D, _ox: number, oy: number,
    _dw: number, dh: number, _first: number, _last: number,
  ): void {
    const { width } = this.viewportSize()
    const lines: Array<[number, string, number]> = [
      [0, "rgba(255,255,255,0.30)", 1.2],
      [23.44, "rgba(255,255,255,0.14)", 0.8],
      [-23.44, "rgba(255,255,255,0.14)", 0.8],
      [66.56, "rgba(255,255,255,0.14)", 0.8],
      [-66.56, "rgba(255,255,255,0.14)", 0.8],
    ]
    ctx.save()
    for (const [lat, color, lw] of lines) {
      const yFrac = 0.5 - lat / 180
      const sy = oy + yFrac * dh
      ctx.strokeStyle = color
      ctx.lineWidth = lw
      ctx.beginPath()
      ctx.moveTo(0, sy)
      ctx.lineTo(width, sy)
      ctx.stroke()
    }
    ctx.restore()
  }

  /** 球のラスタの一辺 [px]。画面解像度と切り離す（回転のたびに回すので） */
  private static readonly GLOBE_PX = 560

  /**
   * 正射投影（見えている半球だけ描く）。
   *
   * ★**WebGL を持ち込まない。** 既存のレイヤが吐いた正距円筒のラスタを
   * そのまま標本化するので、**レイヤ側は 1 行も変えなくてよい**。
   *
   * 逆変換（Snyder の正射図法。sin c = ρ、cos c = √(1−ρ²)）:
   *   lat = asin( z·sin φ0 + y·cos φ0 )
   *   lon = λ0 + atan2( x, z·cos φ0 − y·sin φ0 )
   */
  private drawGlobe(dpr: number, width: number, height: number): void {
    const D = PlanetView.GLOBE_PX
    if (!this.globe) {
      this.globe = document.createElement("canvas")
      this.globe.width = D; this.globe.height = D
      const g = this.globe.getContext("2d")
      if (!g) throw new Error("2d context unavailable")
      this.globeCtx = g
      this.globeImg = g.createImageData(D, D)
    }
    const gctx = this.globeCtx!, gimg = this.globeImg!
    if (this.globeDirty) {
      const src = this.image.data
      const SW = this.off.width, SH = this.off.height
      const out = gimg.data
      const R = D / 2
      const sinP = Math.sin(this.lat0), cosP = Math.cos(this.lat0)
      let o = 0
      for (let py = 0; py < D; py++) {
        const y = (py + 0.5 - R) / R
        for (let px = 0; px < D; px++, o += 4) {
          const x = (px + 0.5 - R) / R
          const rho2 = x * x + y * y
          if (rho2 > 1) { out[o + 3] = 0; continue }
          const z = Math.sqrt(1 - rho2)
          // ★y は画面の下向きが正なので、緯度は −y で入れる（北が上）
          const lat = Math.asin(z * sinP - y * cosP)
          const lon = this.lon0 + Math.atan2(x, z * cosP + y * sinP)
          let u = lon / (2 * Math.PI) + 0.5
          u -= Math.floor(u)
          const sx = Math.min(SW - 1, (u * SW) | 0)
          const sy = Math.min(SH - 1, Math.max(0, ((0.5 - lat / Math.PI) * SH) | 0))
          const si = (sy * SW + sx) * 4
          // 縁を暗くして球に見せる（リムダークニング）。
          // ★**段にする。** 連続で暗くすると色数が爆発して、地図だけ
          // ドット絵・球だけ滑らかという食い違いが出る（`natural.ts` の `BANDS`）。
          // 4 段 + 4x4 の Bayer で、明暗の境目をドットで砕く
          const dz = (BAYER4G[(py & 3) * 4 + (px & 3)] + 0.5) / 16
          const k = 0.55 + 0.45 * (Math.min(3, Math.floor(z * 3 + dz)) / 3)
          out[o] = src[si] * k
          out[o + 1] = src[si + 1] * k
          out[o + 2] = src[si + 2] * k
          out[o + 3] = 255
        }
      }
      gctx.putImageData(gimg, 0, 0)
      this.globeDirty = false
    }
    const ctx = this.ctx
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = "#05070b"
    ctx.fillRect(0, 0, width, height)
    // 画面に収まる最大の円。`scale` を倍率として効かせる
    const base = Math.min(width, height) * 0.86
    const size = Math.max(64, base * this.globeZoom)
    // ★球も補間しない。ここだけ滑らかにすると、平面図と球で見た目が変わる
    ctx.imageSmoothingEnabled = size < D
    ctx.drawImage(this.globe, (width - size) / 2, (height - size) / 2, size, size)
    if (this.targeting && this.hoverCell) {
      this.drawGlobeTarget(ctx, width, height, size, this.hoverCell)
    }
  }

  /** 球のときの照準。セル中心を球面に投影して輪を描く */
  private drawGlobeTarget(
    ctx: CanvasRenderingContext2D, width: number, height: number,
    size: number, cell: { x: number; y: number },
  ): void {
    const lat = (this.grid.latDeg[cell.y] * Math.PI) / 180
    const lon = ((cell.x + 0.5) / this.grid.W) * 2 * Math.PI - Math.PI
    const sinP = Math.sin(this.lat0), cosP = Math.cos(this.lat0)
    const dl = lon - this.lon0
    const cosc = sinP * Math.sin(lat) + cosP * Math.cos(lat) * Math.cos(dl)
    if (cosc <= 0) return                       // 裏側なので描かない
    const x = Math.cos(lat) * Math.sin(dl)
    const y = -(cosP * Math.sin(lat) - sinP * Math.cos(lat) * Math.cos(dl))
    const R = size / 2
    const cxp = width / 2 + x * R, cyp = height / 2 + y * R
    ctx.save()
    ctx.strokeStyle = "rgba(255,214,120,0.95)"
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(cxp, cyp, Math.max(4, R * 0.035), 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  /** 球のズーム倍率（1 = 画面いっぱい） */
  private globeZoom = 1

  /** 画面座標 → グリッド座標 */
  private screenToGrid(sx: number, sy: number): { x: number; y: number } | null {
    const { width, height } = this.viewportSize()
    if (this.mode === "globe") {
      const size = Math.max(64, Math.min(width, height) * 0.86 * this.globeZoom)
      const R = size / 2
      const x = (sx - width / 2) / R, y = (sy - height / 2) / R
      const rho2 = x * x + y * y
      if (rho2 > 1) return null                 // 球の外
      const z = Math.sqrt(1 - rho2)
      const sinP = Math.sin(this.lat0), cosP = Math.cos(this.lat0)
      const lat = Math.asin(z * sinP - y * cosP)
      const lon = this.lon0 + Math.atan2(x, z * cosP + y * sinP)
      let u = lon / (2 * Math.PI) + 0.5
      u -= Math.floor(u)
      const gx = Math.min(this.grid.W - 1, (u * this.grid.W) | 0)
      const gy = Math.min(this.grid.H - 1,
        Math.max(0, ((0.5 - lat / Math.PI) * this.grid.H) | 0))
      return { x: gx, y: gy }
    }
    const ox = width / 2 - this.cx * this.scale
    const oy = height / 2 - this.cy * this.scale
    const gx = (sx - ox) / this.scale
    const gy = (sy - oy) / this.scale
    if (gy < 0 || gy >= this.grid.H) return null
    return { x: this.grid.wrapX(Math.floor(gx)), y: Math.floor(gy) }
  }

  private attach(): void {
    const c = this.canvas

    c.addEventListener("pointerdown", (e) => {
      this.dragging = true
      this.lastPointer = { x: e.clientX, y: e.clientY }
      this.downAt = { x: e.clientX, y: e.clientY }
      this.moved = 0
      c.setPointerCapture(e.pointerId)
    })
    c.addEventListener("pointerup", (e) => {
      this.dragging = false
      this.lastPointer = null
      c.releasePointerCapture(e.pointerId)
      // ★**動かさずに離したらクリック。** 4px はドラッグの取りこぼしを防ぐ幅。
      // これが無いと、地図を動かすたびに介入が落ちる
      if (this.downAt && this.moved < 4) {
        const r = c.getBoundingClientRect()
        const g = this.screenToGrid(e.clientX - r.left, e.clientY - r.top)
        if (g) {
          this.onPick?.({
            x: g.x, y: g.y,
            lonDeg: ((g.x + 0.5) / this.grid.W) * 360 - 180,
            latDeg: this.grid.latDeg[g.y],
          })
        }
      }
      this.downAt = null
    })
    c.addEventListener("pointerleave", () => {
      this.hoverCell = null
      this.onHover?.(null)
    })
    c.addEventListener("pointermove", (e) => {
      if (this.dragging && this.lastPointer) {
        const dx = e.clientX - this.lastPointer.x
        const dy = e.clientY - this.lastPointer.y
        this.moved += Math.abs(dx) + Math.abs(dy)
        if (this.mode === "globe") {
          // ★球は【回す】。1 画面ぶんのドラッグで半周くらいが気持ちいい
          const { width, height } = this.viewportSize()
          const R = Math.max(64, Math.min(width, height) * 0.86 * this.globeZoom) / 2
          this.lon0 -= (dx / R) * 0.9
          this.lat0 += (dy / R) * 0.9
          // 極を越えると向きが反転して操作不能になるので止める
          const lim = (85 * Math.PI) / 180
          this.lat0 = Math.max(-lim, Math.min(lim, this.lat0))
          this.globeDirty = true
        } else {
          this.cx -= dx / this.scale
          this.cy -= dy / this.scale
        }
        this.lastPointer = { x: e.clientX, y: e.clientY }
      }
      const r = c.getBoundingClientRect()
      const g = this.screenToGrid(e.clientX - r.left, e.clientY - r.top)
      if (!g) {
        this.hoverCell = null
        this.onHover?.(null)
        return
      }
      if (!this.hoverCell || this.hoverCell.x !== g.x || this.hoverCell.y !== g.y) {
        this.hoverCell = g
      }
      this.onHover?.({
        x: g.x,
        y: g.y,
        lonDeg: ((g.x + 0.5) / this.grid.W) * 360 - 180,
        latDeg: this.grid.latDeg[g.y],
      })
    })
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault()
        if (this.mode === "globe") {
          // 球は中心を保ったまま大きさを変える（カーソル基準の拡大はしない）
          this.globeZoom = Math.max(0.5, Math.min(6,
            this.globeZoom * Math.exp(-e.deltaY * 0.0016)))
          return
        }
        const r = c.getBoundingClientRect()
        const sx = e.clientX - r.left
        const sy = e.clientY - r.top
        const before = this.screenToGridF(sx, sy)
        const factor = Math.exp(-e.deltaY * 0.0016)
        const minScale = Math.min(
          this.viewportSize().width / this.grid.W,
          this.viewportSize().height / this.grid.H,
        ) * 0.5
        this.scale = this.snapScale(
          Math.max(minScale, Math.min(48, this.scale * factor)))
        const after = this.screenToGridF(sx, sy)
        // カーソル位置のグリッド座標が動かないようにカメラを補正する
        this.cx += before.x - after.x
        this.cy += before.y - after.y
      },
      { passive: false },
    )
  }

  private screenToGridF(sx: number, sy: number): { x: number; y: number } {
    const { width, height } = this.viewportSize()
    const ox = width / 2 - this.cx * this.scale
    const oy = height / 2 - this.cy * this.scale
    return { x: (sx - ox) / this.scale, y: (sy - oy) / this.scale }
  }
}

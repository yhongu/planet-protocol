/**
 * ★★**タイトル画面で回る惑星**（2026-09-10）。
 *
 * ★プレイして「地球は円型で回転してて / **ちゃんとこのゲームの惑星**ね」と
 * 要望された。だから**絵を描かない** —— `scripts/make-chapter-maps.ts` が
 * 配られている章（＝本当に 45 億年回した惑星）の自然な見た目レイヤを
 * 正距円筒の PNG に焼いてあるので、それを球へ投影する。
 *
 * ★**`planetView.drawGlobe` と同じ図法・同じ陰影**にすること。
 * タイトルの球とゲーム中の球が違って見えたら、それは別の惑星に見える。
 * 正射図法（Snyder）の逆変換:
 *
 *   lat = asin( z·sinφ0 − y·cosφ0 )
 *   lon = lon0 + atan2( x, z·cosφ0 + y·sinφ0 )
 *
 * ★**縁の暗さは 4 段 + Bayer** —— 連続で暗くすると色数が爆発して、
 * 地図だけドット絵・球だけ滑らか、という食い違いが出る（罠 61）。
 *
 * ## 速さ
 *
 * ★**毎フレーム逆変換を解き直さない。** 回転で変わるのは `lon0` だけで、
 * それは**元画像の x を横にずらすだけ**。緯度・陰影・裏表の判定は
 * 回っても変わらないので、**1 回だけ表に焼いて使い回す**。
 * これで 1 フレームの仕事が「表を引いて 4 バイト書く」だけになる。
 */

/** Bayer 4x4（`natural.ts` と同じ並び） */
const BAYER4 = [
  0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5,
]

interface Table {
  /** 描く画素の番号（球の内側だけ） */
  idx: Int32Array
  /** 元画像の行の先頭バイト位置 */
  row: Int32Array
  /** 元画像の列（lon0 = 0 のとき）。回転はこれに足す */
  col: Int32Array
  /** 縁の暗さ（0..1 を 256 段にしたもの） */
  shade: Uint8Array
  n: number
}

export interface GlobeSource {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** 表を作る。★`lat0`（見ている緯度）と大きさが変わったときだけ作り直す */
function buildTable(D: number, src: GlobeSource, lat0: number): Table {
  const R = D / 2
  const sinP = Math.sin(lat0), cosP = Math.cos(lat0)
  const SW = src.width, SH = src.height
  const cap = D * D
  const idx = new Int32Array(cap), row = new Int32Array(cap)
  const col = new Int32Array(cap), shade = new Uint8Array(cap)
  let n = 0
  for (let py = 0; py < D; py++) {
    const y = (py + 0.5 - R) / R
    for (let px = 0; px < D; px++) {
      const x = (px + 0.5 - R) / R
      const rho2 = x * x + y * y
      if (rho2 > 1) continue
      const z = Math.sqrt(1 - rho2)
      const lat = Math.asin(z * sinP - y * cosP)
      const lon = Math.atan2(x, z * cosP + y * sinP)
      const u = lon / (2 * Math.PI) + 0.5
      const sx = Math.min(SW - 1, Math.max(0, Math.floor(u * SW)))
      const sy = Math.min(SH - 1, Math.max(0, Math.floor((0.5 - lat / Math.PI) * SH)))
      const dz = (BAYER4[(py & 3) * 4 + (px & 3)]! + 0.5) / 16
      const k = 0.55 + 0.45 * (Math.min(3, Math.floor(z * 3 + dz)) / 3)
      idx[n] = (py * D + px) * 4
      row[n] = sy * SW * 4
      col[n] = sx
      shade[n] = Math.round(k * 255)
      n++
    }
  }
  return { idx, row, col, shade, n }
}

export class TitleGlobe {
  private ctx: CanvasRenderingContext2D
  private img: ImageData
  private table: Table | null = null
  private src: GlobeSource | null = null
  private raf = 0
  private lon = 0
  /** 1 秒あたりの回転 [rad]。★地球の自転を見せるのではなく、眺めるための速さ */
  private speed: number
  private last = 0
  private readonly D: number
  private readonly lat0: number

  constructor(canvas: HTMLCanvasElement, opts?: {
    /** 球の内部解像度 [px]。★大きくしても CSS で拡大するので粗さは変わらない */
    size?: number
    /** 見ている緯度 [deg]。少し傾けると立体に見える */
    tiltDeg?: number
    /** 1 周にかかる秒数 */
    periodSec?: number
  }) {
    this.D = opts?.size ?? 320
    this.lat0 = ((opts?.tiltDeg ?? 12) * Math.PI) / 180
    this.speed = (2 * Math.PI) / (opts?.periodSec ?? 90)
    canvas.width = this.D; canvas.height = this.D
    const c = canvas.getContext("2d")
    if (!c) throw new Error("2d context unavailable")
    this.ctx = c
    this.img = c.createImageData(this.D, this.D)
  }

  /**
   * 惑星の絵（正距円筒）を読み込んで回し始める。
   * ★**読めなければ黙って何もしない** —— 絵は後から差し込めるので、
   * 素材が無くてもタイトルは出る（`creatures.ts` と同じ約束）。
   */
  async load(url: string): Promise<boolean> {
    const src = await loadEquirect(url)
    if (!src) return false
    this.src = src
    this.table = buildTable(this.D, src, this.lat0)
    this.draw()
    return true
  }

  start(): void {
    if (this.raf || !this.table) return
    this.last = performance.now()
    const step = (t: number) => {
      const dt = Math.min(0.1, (t - this.last) / 1000)
      this.last = t
      this.lon += this.speed * dt
      this.draw()
      this.raf = requestAnimationFrame(step)
    }
    this.raf = requestAnimationFrame(step)
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  /** 1 枚だけ描く（章のサムネイルはこれ。回さない） */
  draw(lon?: number): void {
    const t = this.table, s = this.src
    if (!t || !s) return
    const SW = s.width
    // ★回転は「元画像の列をずらす」だけ。逆変換は解き直さない
    const shift = Math.round((((lon ?? this.lon) / (2 * Math.PI)) % 1) * SW)
    const out = this.img.data
    out.fill(0)
    const sd = s.data
    for (let i = 0; i < t.n; i++) {
      let sx = t.col[i]! + shift
      sx %= SW
      if (sx < 0) sx += SW
      const si = t.row[i]! + sx * 4
      const o = t.idx[i]!
      const k = t.shade[i]! / 255
      out[o] = sd[si]! * k
      out[o + 1] = sd[si + 1]! * k
      out[o + 2] = sd[si + 2]! * k
      out[o + 3] = 255
    }
    this.ctx.putImageData(this.img, 0, 0)
  }
}

/** 正距円筒の PNG を読んで画素を取り出す。★読めなければ `null` */
export async function loadEquirect(url: string): Promise<GlobeSource | null> {
  const img = new Image()
  const ok = await new Promise<boolean>((res) => {
    img.onload = () => res(true)
    img.onerror = () => res(false)
    img.src = url
  })
  if (!ok || !img.naturalWidth) return null
  const cv = document.createElement("canvas")
  cv.width = img.naturalWidth; cv.height = img.naturalHeight
  const c = cv.getContext("2d")
  if (!c) return null
  c.imageSmoothingEnabled = false
  c.drawImage(img, 0, 0)
  const d = c.getImageData(0, 0, cv.width, cv.height)
  return { data: d.data, width: cv.width, height: cv.height }
}

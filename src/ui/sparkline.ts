/**
 * **数字に向きを与える。**
 *
 * ★惑星シムで読みたいのは「CO₂ が 324356 ppm」ではなく
 * 「**CO₂ が下がりつつある**」の方である。値だけの表は、
 * 変化を読むのに**画面を覚えておくこと**を要求する。
 *
 * ## 標本の刻みは【年】で取る。フレームではない
 *
 * フレームごとに積むと、速度の段（×1〜×20）とマシンの速さで
 * **同じ惑星が違う形の線になる**（`docs/04-6` の決定論の考え方を表示にも適用）。
 * `SAMPLE_YEARS` ごとに 1 点だけ取る。
 *
 * ## 桁の違う量は対数で描く
 *
 * CO₂ は冥王代の 30 万 ppm から現在の 300 ppm まで **3 桁**動く。
 * 線形で描くと顕生代がすべて底に張り付いて、**一番読みたい時代が平らになる**。
 */

/** 標本の刻み [年]。×20（200 万年/秒）で 1 秒に 1 点 */
const SAMPLE_YEARS = 2e6
/** 保持する点の数。240 点 = 4.8 億年ぶんの履歴 */
const KEEP = 240

interface Series {
  /** 値。古い順 */
  v: number[]
  /** 次に標本を取る年 */
  next: number
  log: boolean
}

const series = new Map<string, Series>()

/** 惑星を作り直したら履歴も捨てる（前の惑星の線が残ると誤読する） */
export function resetSparklines(): void {
  series.clear()
}

/**
 * 標本を 1 点足す。`year` は経過年（`yearsElapsed`）。
 * ★**同じ年で 2 回呼ばれても 1 点しか積まない**（毎フレーム呼んでよい）
 */
export function track(key: string, year: number, value: number, log = false): void {
  let s = series.get(key)
  if (!s) { s = { v: [], next: -Infinity, log }; series.set(key, s) }
  // 巻き戻し（作り直し）を検出したら履歴を捨てる
  if (year + SAMPLE_YEARS < s.next) { s.v.length = 0; s.next = -Infinity }
  if (year < s.next) return
  s.next = year + SAMPLE_YEARS
  s.v.push(Number.isFinite(value) ? value : 0)
  if (s.v.length > KEEP) s.v.shift()
}

/**
 * 直近の変化。★**「増えた／減った」だけを返す。**
 * 何 ppm 増えたかは値そのものを見れば分かるので、
 * ここで欲しいのは**向き**である。しきい値は相対 2%
 * （それ未満を「変化」と書くと、常に矢印が出て意味が消える）
 */
export function trend(key: string): -1 | 0 | 1 {
  const s = series.get(key)
  if (!s || s.v.length < 4) return 0
  // 直近 1/4 の平均と、その前の 1/4 の平均を比べる（1 点の揺らぎで判定しない）
  const n = s.v.length
  const q = Math.max(1, n >> 2)
  const mean = (a: number, b: number) => {
    let t = 0
    for (let i = a; i < b; i++) t += s.v[i]
    return t / (b - a)
  }
  const now = mean(n - q, n), before = mean(Math.max(0, n - 2 * q), n - q)
  const scale = Math.max(1e-12, Math.abs(before))
  const d = (now - before) / scale
  return d > 0.02 ? 1 : d < -0.02 ? -1 : 0
}

/**
 * 線を描く。★**canvas は CSS の大きさ × dpr で持つこと。**
 * 等倍だと 1px の線が滲んで、ドット絵の外装から浮く
 */
export function drawSparkline(cv: HTMLCanvasElement, key: string, color: string): void {
  const s = series.get(key)
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const w = cv.clientWidth || 64, h = cv.clientHeight || 14
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr)
  }
  const ctx = cv.getContext("2d")
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  if (!s || s.v.length < 2) return
  const t = s.log ? s.v.map((x) => Math.log10(Math.max(1e-12, x))) : s.v
  let lo = Infinity, hi = -Infinity
  for (const x of t) { if (x < lo) lo = x; if (x > hi) hi = x }
  const span = Math.max(1e-9, hi - lo)
  // ★左端を最古に固定しない。**点が増えるほど線が縮む**と、
  // 同じ変化が時代によって違う傾きに見える。常に幅いっぱいに引き伸ばす
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 0; i < t.length; i++) {
    const x = (i / (t.length - 1)) * (w - 1) + 0.5
    const y = h - 1.5 - ((t[i] - lo) / span) * (h - 3) + 0.5
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  }
  ctx.stroke()
  // いまの点を打つ（線の右端がどこかを見失わないように）
  const lx = w - 0.5, ly = h - 1.5 - ((t[t.length - 1] - lo) / span) * (h - 3) + 0.5
  ctx.fillStyle = color
  ctx.fillRect(lx - 1.5, ly - 1.5, 3, 3)
}

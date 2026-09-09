/**
 * **集落の絵を、文明ごとの色に塗り替えて地図に置く**
 * （`docs/07-art-spec.md` §7.7。2026-09-09）。
 *
 * ★プレイして「各時代で家のイラストが変わったり」と要望された。
 *
 * ★**`creatures.ts` と同じ仕組みをそのまま使う。** 新しい機構を作らない:
 *
 * | 生命 | 文明 |
 * |---|---|
 * | 段階（`gradeOf`） | 集落の段階（`settlementOf`） |
 * | クレードの色 | 文明の色（地図の領域と同じ） |
 * | `icons/life-*.png` | `icons/town-*.png` |
 *
 * 絵は建物の主要部分を `#FF00FF`、影を `#AA00AA`、
 * ハイライトを `#FF88FF` で塗ってある。窓・煙・炎など
 * **色を変えたくない部分**はパレットの他の色なのでそのまま残る。
 *
 * ★**絵が無ければ黙って落とす。** 絵は後から差し込めるので、
 * 素材が揃う前でもコードは動く（`creatures.ts` と同じ約束）。
 */
import { cladeColor } from "./layers"
import type { Settlement } from "../ui/settlementGrade"

/**
 * 1 セルに絵を置くのに要る最低の画面ピクセル。
 * ★生き物（22px）より大きくする —— 建物は生き物の**上に**重ねるので、
 * 両方置くには場所が要る。小さいうちは都市の点だけで足りる。
 */
export const MIN_TOWN_PX = 26

interface Loaded { img: HTMLImageElement; ok: boolean }

const sources = new Map<Settlement, Loaded>()
const tinted = new Map<string, HTMLCanvasElement>()
const shadows = new Map<string, HTMLCanvasElement>()
const urls = new Map<string, string>()

function source(s: Settlement): Loaded {
  let e = sources.get(s)
  if (!e) {
    const img = new Image()
    e = { img, ok: false }
    img.onload = () => { e!.ok = true }
    img.onerror = () => { e!.ok = false }
    img.src = `icons/town-${s}.png`
    sources.set(s, e)
  }
  return e
}

/** その画素がマゼンタ系か。★完全一致にしない（手で塗るとずれる） */
function magentaKind(r: number, g: number, b: number): 0 | 1 | 2 | 3 {
  if (g > 200 || r < 90 || b < 90) return 0
  if (Math.abs(r - b) > 70) return 0
  if (g > 60) return r > 200 ? 3 : 0
  return r > 210 ? 1 : 2
}

/** 文明の色。★**地図の領域と同じ式**（別々に書くと画面が食い違う。罠 82） */
export const civColorOf = (civId: number) => cladeColor(civId * 7)

/**
 * その段階・その文明の絵を返す。まだ読めていなければ `null`。
 * ★塗り替えた結果は使い回す（毎フレーム塗ると 60fps が出ない）
 */
export function settlementSprite(
  stage: Settlement, civId: number,
): HTMLCanvasElement | null {
  const key = `${stage}|${civId}`
  const hit = tinted.get(key)
  if (hit) return hit
  const src = source(stage)
  if (!src.ok) return null
  const w = src.img.naturalWidth, h = src.img.naturalHeight
  if (!w || !h) return null
  const cv = document.createElement("canvas")
  cv.width = w; cv.height = h
  const ctx = cv.getContext("2d")
  if (!ctx) return null
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(src.img, 0, 0)
  const d = ctx.getImageData(0, 0, w, h)
  const p = d.data
  const [cr, cg, cb] = civColorOf(civId)
  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3]! < 8) continue
    const kind = magentaKind(p[i]!, p[i + 1]!, p[i + 2]!)
    if (kind === 0) continue
    const k = kind === 1 ? 1 : kind === 2 ? 0.62 : 1
    const lift = kind === 3 ? 0.45 : 0
    const cl = (c: number) => {
      const v = c * k + (255 - c * k) * lift
      return v < 0 ? 0 : v > 255 ? 255 : v
    }
    p[i] = cl(cr); p[i + 1] = cl(cg); p[i + 2] = cl(cb)
  }
  ctx.putImageData(d, 0, 0)
  tinted.set(key, cv)
  return cv
}

/**
 * **輪郭を作るための影**（暗く落とした同じ絵）。
 * ★`ctx.filter` を描画のたびに設定してはいけない（実測 60fps → 2fps）。
 * 焼いてから使い回す（`creatures.ts` と同じ理由）。
 */
export function settlementShadow(
  stage: Settlement, civId: number,
): HTMLCanvasElement | null {
  const key = `${stage}|${civId}`
  const hit = shadows.get(key)
  if (hit) return hit
  const src = settlementSprite(stage, civId)
  if (!src) return null
  const cv = document.createElement("canvas")
  cv.width = src.width; cv.height = src.height
  const ctx = cv.getContext("2d")
  if (!ctx) return null
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(src, 0, 0)
  const d = ctx.getImageData(0, 0, cv.width, cv.height)
  const p = d.data
  for (let i = 0; i < p.length; i += 4) {
    p[i]! *= 0.15; p[i + 1]! *= 0.15; p[i + 2]! *= 0.15
  }
  ctx.putImageData(d, 0, 0)
  shadows.set(key, cv)
  return cv
}

/**
 * 文明タブや虫眼鏡のような **HTML 側**へ渡すための絵。
 * ★塗り替えないまま `<img src="icons/town-*.png">` を出すと
 * **ピンクの塊**になる（塗り替える場所をマゼンタで置いているため）。
 */
export function settlementImageUrl(stage: Settlement, civId: number): string | null {
  const key = `${stage}|${civId}`
  const hit = urls.get(key)
  if (hit) return hit
  const cv = settlementSprite(stage, civId)
  if (!cv) return null
  const u = cv.toDataURL()
  urls.set(key, u)
  return u
}

/** 惑星を作り直したら捨てる（文明の id が振り直される） */
export function clearSettlementCache(): void {
  tinted.clear(); shadows.clear(); urls.clear()
}

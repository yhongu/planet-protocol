/**
 * **生命体の絵を、系統ごとの色に塗り替えて地図に置く**
 * （`docs/07-art-spec.md` §7.6）。
 *
 * ## マゼンタを置き換える
 *
 * 絵は体の主要部分を `#FF00FF`、影を `#AA00AA`、ハイライトを `#FF88FF`
 * で塗ってある。エンジンはこの 3 色を **`cladeColor(id)` とその暗い色・
 * 明るい色**に置き換える。眼・骨・道具など**色を変えたくない部分**は
 * パレットの他の色なので、そのまま残る。
 *
 * ★**置き換えは「マゼンタらしさ」で判定する。** 完全一致にすると、
 * 絵を描き直したときに 1 だけずれた画素が取り残されて**マゼンタの点**が残る
 * （ドット絵は手で塗るので必ずずれる）。
 *
 * ## 置く場所
 *
 * ★**1 マスに 1 種族ではない。** 最大 16 クレードが取り分で同居している。
 * 地図に置けるのは**そのセルで一番多いクレード**だけなので、
 * **セルが十分大きいときにしか出さない**（虫眼鏡で中身を読む方が正しい）。
 */
import { cladeColor } from "./layers"
import { gradeOf, type Grade } from "../ui/creatureGrade"

/** 1 セルに絵を置くのに要る最低の画面ピクセル。★これ未満は点にしかならない */
export const MIN_CELL_PX = 22

interface Loaded { img: HTMLImageElement; ok: boolean }

const sources = new Map<Grade, Loaded>()
/** 塗り替えた結果。`grade|cladeId` で引く */
const tinted = new Map<string, HTMLCanvasElement>()

/** 絵を読み込む。★無い段階は黙って落とす（絵は後から差し込める） */
function source(g: Grade): Loaded {
  let s = sources.get(g)
  if (!s) {
    const img = new Image()
    s = { img, ok: false }
    img.onload = () => { s!.ok = true }
    img.onerror = () => { s!.ok = false }
    img.src = `icons/life-${g}.png`
    sources.set(g, s)
  }
  return s
}

/** その画素がマゼンタ系か。★完全一致にしない（手で塗るとずれる） */
function magentaKind(r: number, g: number, b: number): 0 | 1 | 2 | 3 {
  if (g > 200 || r < 90 || b < 90) return 0          // 緑が強い or 暗すぎる
  if (Math.abs(r - b) > 70) return 0                 // 赤と青が揃っていない
  if (g > 60) return r > 200 ? 3 : 0                 // 明るい（ハイライト）
  return r > 210 ? 1 : 2                             // 主 / 影
}

/**
 * その段階・その系統の絵を返す。まだ読めていなければ `null`。
 * ★塗り替えた結果は使い回す（毎フレーム塗ると 60fps が出ない）
 */
export function creatureSprite(grade: Grade, cladeId: number): HTMLCanvasElement | null {
  const key = `${grade}|${cladeId}`
  const hit = tinted.get(key)
  if (hit) return hit
  const src = source(grade)
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
  const [cr, cg, cb] = cladeColor(cladeId)
  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3] < 8) continue
    const kind = magentaKind(p[i], p[i + 1], p[i + 2])
    if (kind === 0) continue
    // 主 = そのまま / 影 = 0.62 倍 / ハイライト = 白へ 0.45 寄せ
    const k = kind === 1 ? 1 : kind === 2 ? 0.62 : 1
    const lift = kind === 3 ? 0.45 : 0
    p[i] = cr * k + (255 - cr * k) * lift
    p[i + 1] = cg * k + (255 - cg * k) * lift
    p[i + 2] = cb * k + (255 - cb * k) * lift
  }
  ctx.putImageData(d, 0, 0)
  tinted.set(key, cv)
  return cv
}

/** 惑星を作り直したら捨てる（クレードの id が振り直される） */
export function clearCreatureCache(): void { tinted.clear() }

export { gradeOf }
export type { Grade }

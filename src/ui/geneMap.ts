/**
 * 遺伝子地図。**ゲノムを、本物のデータだけで見えるようにする。**
 *
 * ★**二重らせんに ATCG を並べてはいけない。** このモデルのゲノムに塩基は無い。
 * 1 個の遺伝子が持つのは **種類・強さ・由来 id** の 3 つだけで、
 * 刻みが 100 万年なので配列を持っても意味が無いという設計判断による
 * （`docs/02` §2.2b）。存在しない機構を絵で保証してはいけない
 * （`CLAUDE.md` の 50）。
 *
 * かわりに、**実際に起きていること**を出す:
 *
 * - **同じ色が並ぶ = 遺伝子の重複**。飾りではなく、
 *   **新機能化の材料が溜まっている**という状態そのもの（§2.2b）
 * - **由来 id** が他の系統と共有なら**相同**（受け継いだ）、単独なら**発明**
 * - 神の手の水平伝播で入った遺伝子も、由来を引き継ぐので相同として出る
 */

import { GENE_KINDS, FIRST_CAPABILITY } from "../sim/genome"
import { GENE_LABELS } from "./geneLabels"

export interface Gene { kind: number; value: number; origin: number }

/**
 * 遺伝子の色。**形質と能力を彩度で分ける**（能力の方が鮮やか）。
 * 黄金角で回すので、隣り合う種類が似た色にならない。
 */
export function geneColor(kind: number): string {
  const h = (kind * 137.508) % 360
  const cap = kind >= FIRST_CAPABILITY
  return `hsl(${h.toFixed(0)} ${cap ? 68 : 34}% ${cap ? 58 : 48}%)`
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;")

/**
 * 遺伝子地図の HTML。
 *
 * @param genes    そのクレードのゲノム
 * @param shared   由来 id → それを持つ系統の数（2 以上なら相同）
 */
export function geneMapHtml(genes: readonly Gene[], shared: Map<number, number>): string {
  if (genes.length === 0) return `<div class="lg-note">遺伝子がありません</div>`
  // ★種類で並べる。**ゲノムの順序に意味は無い**（`removeGene` が末尾と入れ替える）ので、
  // 種類で並べると重複が隣り合って目で分かる
  const sorted = [...genes].sort((a, b) => a.kind - b.kind || b.value - a.value)

  const strip = sorted.map((g) => {
    const L = GENE_LABELS[GENE_KINDS[g.kind]]
    const homo = (shared.get(g.origin) ?? 0) > 1
    const title = `${L?.ja ?? GENE_KINDS[g.kind]} ${g.value.toFixed(0)}`
      + `（${homo ? "相同" : "発明"} #${g.origin}）`
      + (L ? ` — ${L.what}` : "")
    return `<i class="gm-b${homo ? "" : " novo"}" title="${esc(title)}"`
      + ` style="flex:${Math.max(8, g.value).toFixed(0)};background:${geneColor(g.kind)}"></i>`
  }).join("")

  // 種類ごとにまとめる（96 個並ぶと読めない）
  const byKind = new Map<number, Gene[]>()
  for (const g of sorted) {
    const a = byKind.get(g.kind) ?? []
    a.push(g)
    byKind.set(g.kind, a)
  }
  const rows = [...byKind.entries()].map(([kind, gs]) => {
    const L = GENE_LABELS[GENE_KINDS[kind]]
    const total = gs.reduce((a, g) => a + g.value, 0)
    const origins = [...new Set(gs.map((g) => g.origin))]
    const marks = origins.map((o) => {
      const homo = (shared.get(o) ?? 0) > 1
      return `<span class="g-org ${homo ? "homo" : "novo"}">${homo ? "相同" : "発明"} #${o}</span>`
    }).join("")
    return `<div class="gm-row" title="${esc(L?.what ?? "")}">`
      + `<i style="background:${geneColor(kind)}"></i>`
      + `<span class="gm-name">${esc(L?.ja ?? GENE_KINDS[kind])}</span>`
      + `<span class="gm-n">${gs.length > 1 ? `×${gs.length}` : ""}</span>`
      + `<span class="gm-v">${total.toFixed(0)}</span>`
      + `<span class="gm-org">${marks}</span></div>`
  }).join("")

  const dup = [...byKind.values()].filter((g) => g.length > 1).length
  return `<div class="gm-strip">${strip}</div>`
    + `<div class="lg-note">${genes.length} 遺伝子・${byKind.size} 種類`
    + (dup > 0 ? `・<b>重複している種類 ${dup}</b>（新機能化の材料）` : "")
    + `</div>${rows}`
}

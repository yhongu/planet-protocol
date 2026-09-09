/**
 * 文明タブ。**この惑星の文明が何を持っていて、何を失ったか**（M6）。
 *
 * ★**作った理由はプレイヤーの言葉そのまま**（2026-09-09）——
 * 「技術とかなにを獲得しているかも分からんよね」「文明の一覧ビューもほしい」。
 * それまで文明は**地図の色と人口の数字しか出ていなかった**ので、
 * 40 個の技術ツリーも、失伝も、独立発明と伝播の違いも、
 * **回っているのに一度も画面に出ていなかった**（罠 46 の UI 版 ——
 * 「機構がある」と「機構が見えている」は別）。
 *
 * ★**系譜タブと同じ作りにする。** 生命の系譜が
 * 「誰から分かれ、いつ絶滅したか」を見せるのに対し、
 * ここは「どこで生まれ、何を発明し、何を失伝したか」を見せる。
 * `docs/02` の「機能は収斂する、系統は収斂しない」が文明でも成り立つので、
 * ★**技術の由来 id を出して、独立発明（★）と伝播（→）を描き分ける。**
 */

import type { CivInfo, CivSummary } from "../worker/protocol"
import { TECHS, eraOf } from "../sim/tech"
import { cladeColor } from "../render/layers"
import { settlementImageUrl } from "../render/settlements"
import { settlementOfIndices, SETTLEMENT_LABEL } from "./settlementGrade"

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;")
const rgb = (c: readonly [number, number, number]) =>
  `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`

/** 文明の色。★**地図の領域の色と同じ式**（別々に書くと画面が食い違う。罠 82） */
export const civColor = (id: number) => cladeColor(id * 7)

/** 人口を読める形に。★桁が 4 つ動くので、単位を切り替える */
function pop(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 億人`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万人`
  return `${Math.round(n)} 人`
}

/** 技術の分類（表示をまとめるためだけ。機構には無い） */
const GROUPS: [string, string[]][] = [
  ["素材と道具", ["stoneTools", "fire", "pottery", "copper", "bronze", "iron",
    "steel", "steam", "electricity", "semiconductor"]],
  ["食料", ["agriculture", "irrigation", "rainfed", "plough", "draft",
    "rotation", "breeding", "fertilizer"]],
  ["記録と学び", ["ritual", "religion", "writing", "oralTradition", "printing",
    "school", "science"]],
  ["結束", ["law", "money", "bureaucracy", "trade"]],
  ["移動", ["boats", "sail", "ocean", "wheel", "railway"]],
  ["軍事と医療", ["bow", "gunpowder", "herbs", "sanitation", "medicine", "fossilFuel"]],
]

export class CivPanel {
  private readonly root: HTMLElement
  private data: CivSummary | null = null
  private selected = -1
  /** 惑星の経過年（★「何年前に建国したか」を出すのに要る） */
  private years = 0

  /**
   * ★**降りているか**（`setCivFocus`）。
   * 降りると速度の段が人間の尺度になる（×1 = 10 年/秒 … ×20 = 20 万年/秒）。
   */
  private focused = false
  /** 降りる / 惑星に戻る を切り替える。main が worker へ送る */
  onSetFocus: ((focused: boolean) => void) | null = null

  constructor(root: HTMLElement) {
    this.root = root
    root.innerHTML =
      `<div class="row title">文明` +
      `<button id="civFocus" class="mini wide"></button>` +
      `<button id="civClose" class="mini">✕</button></div>` +
      `<div class="civ-body"></div>`
    root.querySelector("#civClose")!.addEventListener("click", () => this.close())
    // ★★**戻る道を必ず作る。** 「降りる」しか無いと、
    //   一度降りたプレイヤーは 200 年/秒に取り残される（45 億年は進めない）
    root.querySelector("#civFocus")!.addEventListener("click", () => {
      this.setFocused(!this.focused)
      this.onSetFocus?.(this.focused)
    })
    root.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-civ]")
      if (!el) return
      const id = Number((el as HTMLElement).dataset.civ)
      this.selected = this.selected === id ? -1 : id
      this.render()
    })
  }

  /** 外から降下の状態を合わせる（モーダルで降りたときなど） */
  setFocused(v: boolean): void {
    this.focused = v
    const b = this.root.querySelector("#civFocus") as HTMLButtonElement | null
    if (b) {
      b.textContent = v ? "惑星に戻る（100 万年/秒）" : "降りる（10 年〜20 万年/秒）"
      b.classList.toggle("on", v)
    }
  }

  get open(): boolean { return !this.root.hidden }
  close(): void { this.root.hidden = true }
  toggle(): void { this.root.hidden = !this.root.hidden; if (this.open) this.render() }

  /** 毎ティック呼ばれる。★開いていなければ描かない（40 技術 × 8 文明は重い） */
  setData(civ: CivSummary | null, years: number): void {
    this.data = civ
    this.years = years
    if (this.open) this.render()
  }

  /** ★**知性が生まれるまでボタンを出さない。** 空の表は情報ではない */
  get hasCivilization(): boolean { return this.data !== null }

  private render(): void {
    const body = this.root.querySelector(".civ-body")!
    const d = this.data
    if (!d) {
      body.innerHTML = `<div class="hint">この惑星にはまだ知性が生まれていません。</div>`
      return
    }
    const emerged = (this.years - d.emergedYear) / 1e6
    let h = `<div class="civ-head">`
      + `<div><b>${pop(d.totalPopulation)}</b><span class="hint"> 全球</span></div>`
      + `<div><b>${d.energyPerCapita.toFixed(0)} W</b><span class="hint"> 1 人あたり</span></div>`
      + `<div><b>${d.civs.length}</b><span class="hint"> の文明</span></div>`
      + `</div>`
      + `<div class="hint">知性の誕生から ${emerged.toFixed(1)} 百万年　`
      + `発明 ${d.invented} ・ <b>失伝 ${d.lost}</b> ・ 伝播 ${d.transferred} ・ 征服 ${d.conquered}`
      + `　開墾で出した CO₂ ${d.landClearCo2Ppm.toFixed(0)} ppm</div>`

    if (d.civs.length === 0) {
      h += `<div class="hint">★いま文明はありません（滅びたか、まだ建国されていない）。`
        + `知性種がいる限り、また生まれます。</div>`
    }
    // ★**大きい順**。滅びかけの文明を上に置かない
    const civs = [...d.civs].sort((a, b) => b.population - a.population)
    for (const c of civs) h += this.rowHtml(c)
    body.innerHTML = h
  }

  private rowHtml(c: CivInfo): string {
    const col = rgb(civColor(c.id))
    const has = new Array<boolean>(TECHS.length).fill(false)
    for (const k of c.tech) has[k] = true
    const era = eraOf(has, c.energyPerCapita)
    const age = (this.years - c.foundedYear) / 1e6
    // ★**最盛期からどれだけ落ちたか**が崩壊の実体（Tainter）。
    //   人口だけ出すと「小さい文明」と「崩壊中の文明」が区別できない（罠 110）
    const decline = c.peakPopulation > 0 ? c.population / c.peakPopulation : 1
    const dying = decline < 0.7
    const sel = this.selected === c.id
    // ★**その文明の集落の絵**（地図に置いているものと同じ）。
    //   ★塗り替えないまま `<img src="icons/town-*.png">` を出すと
    //   **ピンクの塊**になる（塗り替える場所をマゼンタで置いているため）
    const stage = settlementOfIndices(c.tech)
    const icon = settlementImageUrl(stage, c.id)
    let h = `<div class="civ-row${sel ? " sel" : ""}" data-civ="${c.id}">`
      + `<div class="civ-name">`
      + (icon
        ? `<img class="civ-town" src="${icon}" alt="" title="${esc(SETTLEMENT_LABEL[stage])}">`
        : `<span class="civ-dot" style="background:${col}"></span>`)
      + `<b>文明 #${c.id}</b> <span class="civ-era">${esc(era.material)}・${esc(era.society)}</span></div>`
      + `<div class="civ-nums">`
      + `<span>${pop(c.population)}</span>`
      + `<span>${c.energyPerCapita.toFixed(0)} W/人</span>`
      + `<span>${c.tech.length} 技術</span>`
      + `<span>${(c.areaKm2 / 1e6).toFixed(1)} 百万km²</span>`
      + `</div>`
      + `<div class="civ-sub hint">${esc(era.energy)}　建国 ${age.toFixed(1)} 百万年前　`
      + `農地 ${(100 * c.landUse).toFixed(0)}%　失伝 ${c.lostCount} 回`
      + (dying
        ? `　<b class="civ-dying">衰退中（最盛期の ${(100 * decline).toFixed(0)}%）</b>`
        : "")
      + `</div>`
    if (sel) h += this.detailHtml(c, has)
    h += `</div>`
    return h
  }

  /** 技術ツリーの中身。★**持っていないものも薄く出す**（何が足りないかが要る） */
  private detailHtml(c: CivInfo, has: boolean[]): string {
    const origin = new Map<number, number>()
    for (let i = 0; i < c.tech.length; i++) origin.set(c.tech[i]!, c.techOrigin[i] ?? -1)
    let h = `<div class="civ-tech">`
    for (const [label, names] of GROUPS) {
      h += `<div class="civ-group"><span class="civ-gname">${esc(label)}</span>`
      for (const n of names) {
        const k = TECHS.findIndex((t) => t.name === n)
        if (k < 0) continue
        const t = TECHS[k]!
        const own = has[k]
        const gate = t.gate ? `　惑星の条件: ${t.gate.kind} ≥ ${t.gate.min}` : ""
        const title = `${t.what}（${t.name}）　複雑さ ${t.complexity.toFixed(2)}`
          + (t.energyW > 0 ? `　+${t.energyW}W/人` : "")
          + (t.yieldGain > 0 ? `　収量 +${t.yieldGain}` : "")
          + (own ? `　由来 #${origin.get(k)}` : "　まだ持っていない")
          + gate
        h += `<span class="civ-t${own ? " own" : ""}" title="${esc(title)}">${esc(t.what)}</span>`
      }
      h += `</div>`
    }
    h += `</div>`
    return h
  }
}

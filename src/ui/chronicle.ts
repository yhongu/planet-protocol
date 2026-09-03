/**
 * **惑星の年代記。**
 *
 * ★これまで出来事は、右パネルの数字 14 行と診断の**下**に畳まれていた。
 * 45.4 億年を眺めるゲームで、**起きたことのログが画面で一番奥にあった**。
 * 独立した部品にして、状態の表と同じ大きさで出す。
 *
 * ## 分類は `code` で決める。本文では決めない
 *
 * ★本文の日本語で分けると、文言を直した瞬間に分類が壊れる
 * （`docs/07-art-spec.md` が絵について言っているのと同じ理由）。
 * 出す側が付けた機械可読な `code` の前置きで分ける。
 *
 * ## 新しい順に出す
 *
 * 年代記としては古い順が自然だが、**プレイ中に読みたいのは「いま何が起きたか」**
 * なので新しい順にする。全史を通しで読みたいときは下のタイムラインがある。
 */

export interface Ev {
  year: number
  kind: string
  text: string
  code?: string
}

/** 出来事の分類。★`code` の前置きで決める（本文では決めない） */
export type Cat = "all" | "life" | "earth" | "climate" | "hand"

const CATS: { id: Cat; label: string }[] = [
  { id: "all", label: "すべて" },
  { id: "life", label: "生命" },
  { id: "earth", label: "地質" },
  { id: "climate", label: "気候" },
  { id: "hand", label: "介入" },
]

/** どの分類か。★ここだけを見れば分類の規則が全部分かるようにする */
export function categorize(e: Ev): Exclude<Cat, "all"> {
  const c = e.code ?? ""
  if (e.text.startsWith("介入")) return "hand"
  if (c.startsWith("cap-") || c === "ev-luca" || c === "ev-origin"
    || c === "ev-goe" || c === "ev-extinction" || c === "ev-speciation") return "life"
  if (c === "ev-icehouse" || c === "ev-greenhouse"
    || c === "ev-transgression" || c === "ev-regression") return "climate"
  return "earth"
}

const PLANET_AGE = 4.54e9

/** 「4.17Ga」「980Ma」。★Ga と Ma を混ぜない —— 桁が読めなくなる */
function when(year: number): string {
  const ago = PLANET_AGE - year
  return ago >= 1e7 ? `${(ago / 1e9).toFixed(2)}Ga` : `${(ago / 1e6).toFixed(0)}Ma`
}

export class Chronicle {
  private root: HTMLElement
  private body: HTMLElement
  private cat: Cat = "all"
  private events: Ev[] = []

  constructor(root: HTMLElement) {
    this.root = root
    root.innerHTML =
      `<div class="section">年代記 <span class="hint" id="chCount"></span></div>`
      + `<div class="ch-tabs">${CATS.map((c) =>
        `<button class="ch-tab${c.id === "all" ? " on" : ""}" data-cat="${c.id}">${c.label}</button>`
      ).join("")}</div>`
      + `<div class="ch-body" id="chBody">—</div>`
    this.body = root.querySelector<HTMLElement>("#chBody")!
    for (const b of root.querySelectorAll<HTMLButtonElement>(".ch-tab")) {
      b.addEventListener("click", () => {
        this.cat = b.dataset.cat as Cat
        for (const o of root.querySelectorAll(".ch-tab")) o.classList.remove("on")
        b.classList.add("on")
        this.render()
      })
    }
  }

  set(events: Ev[]): void {
    this.events = events
    this.render()
  }

  private render(): void {
    const list = this.cat === "all"
      ? this.events : this.events.filter((e) => categorize(e) === this.cat)
    const count = this.root.querySelector<HTMLElement>("#chCount")
    if (count) count.textContent = `${list.length} 件`
    if (!list.length) { this.body.textContent = "まだ何も起きていない"; return }
    // ★新しい順。件数は 120 で切る（全史 60 件前後なので通常は全部入る）
    const recent = list.slice(-120).reverse()
    this.body.innerHTML = recent.map((e) => {
      const cat = categorize(e)
      // 絵が無い出来事は img を出さない（`docs/07-art-spec.md` のフォールバック）
      const ico = e.code
        ? `<img class="ch-ico" src="icons/${e.code}.png" alt="" onerror="this.remove()" />`
        : `<i class="ch-dot"></i>`
      return `<div class="ch-ev" data-cat="${cat}">${ico}`
        + `<div class="ch-tx"><span class="ch-yr">${when(e.year)}</span>${e.text}</div></div>`
    }).join("")
  }
}

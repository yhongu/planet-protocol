/**
 * **レイヤの選択。**
 *
 * ★25 枚を `<select>` 1 個に入れていた。開くまで中身が見えず、
 * 開いても 25 行の文字列なので、**知らないレイヤは一生選ばれない**。
 * 探索できないことが、そのまま「そのレイヤは無いのと同じ」になる。
 *
 * タイルにして、**分類と色見本を一緒に出す**。
 * 色見本はそのレイヤの凡例（`LayerDef.legend`）から作るので、
 * ★**新しいレイヤを足しても、ここには何も書かなくてよい**。
 */
import type { LayerDef } from "../render/layers"

/**
 * 分類。★**id で書く。ラベルの日本語では書かない**
 * （文言を直した瞬間に分類が壊れる。`chronicle.ts` と同じ理由）。
 * ここに載っていない id は「その他」に落ちるので、
 * レイヤを足したときに黙って消えることはない
 */
const GROUPS: { label: string; ids: string[] }[] = [
  { label: "惑星", ids: ["natural", "elevation"] },
  { label: "気候", ids: ["temperature", "surfaceTemp", "ice", "albedo"] },
  { label: "水と風化", ids: ["regime", "regolith", "erosion", "precip", "runoff", "discharge"] },
  { label: "固体地球", ids: ["plates", "crustAge", "crustThickness", "felsic"] },
  { label: "海洋", ids: ["ventFlux", "upwelling", "phosphateSupply", "dic"] },
  { label: "生命", ids: ["biomass", "dominantClade", "diversity",
    "prebioticFavor", "prebioticOligomer"] },
]

/** 凡例から 1 本の色帯を作る。★無いレイヤは無地で出す（穴を開けない） */
function swatchCss(l: LayerDef): string {
  const lg = l.legend
  if (lg?.stops?.length) return `linear-gradient(90deg, ${lg.stops.join(",")})`
  if (lg?.swatches?.length) {
    return `linear-gradient(90deg, ${lg.swatches.map((s) => s.color).join(",")})`
  }
  return "linear-gradient(90deg, #2a3644, #46586c)"
}

export class LayerPicker {
  private root: HTMLElement
  private onPick: (id: string) => void
  open = false

  constructor(root: HTMLElement, layers: readonly LayerDef[], onPick: (id: string) => void) {
    this.root = root
    this.onPick = onPick
    const seen = new Set<string>()
    const groups = GROUPS.map((g) => ({
      label: g.label,
      items: g.ids.map((id) => layers.find((l) => l.id === id)).filter((l): l is LayerDef => {
        if (!l) return false
        seen.add(l.id)
        return true
      }),
    }))
    const rest = layers.filter((l) => !seen.has(l.id))
    if (rest.length) groups.push({ label: "その他", items: [...rest] })
    root.innerHTML =
      `<div class="row title">レイヤ <button id="lpClose" class="mini">✕</button></div>`
      + groups.map((g) =>
        `<div class="section">${g.label}</div><div class="lp-grid">`
        + g.items.map((l) =>
          `<button class="lp-tile" data-id="${l.id}">`
          + `<i style="background:${swatchCss(l)}"></i>`
          + `<span>${l.label}</span></button>`).join("")
        + `</div>`).join("")
    root.querySelector("#lpClose")?.addEventListener("click", () => this.close())
    for (const b of root.querySelectorAll<HTMLButtonElement>(".lp-tile")) {
      b.addEventListener("click", () => { this.onPick(b.dataset.id!); this.close() })
    }
  }

  /** ★選ばれているタイルに印を付ける。開くたびに更新する */
  show(current: string): void {
    for (const b of this.root.querySelectorAll<HTMLButtonElement>(".lp-tile")) {
      b.classList.toggle("on", b.dataset.id === current)
    }
    this.root.hidden = false
    this.open = true
  }

  close(): void { this.root.hidden = true; this.open = false }
  toggle(current: string): void { this.open ? this.close() : this.show(current) }
}

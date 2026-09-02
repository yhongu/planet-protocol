/**
 * 系譜タブ。**どんな生命が、誰から分かれ、いつ絶滅したか**（`docs/02` §1.6）。
 *
 * ★**このシムの中心的な設計判断がここで初めて画面に出る。**
 * 同じ「光合成」でも、遺伝子の**由来 id が同じなら相同**（親から受け継いだ）、
 * **違えば収斂**（別々に発明した）。§1.6「機能は収斂する、系統は収斂しない」は、
 * これを見せないと確かめようがない。
 *
 * 横軸は 45.4 億年。**下のタイムラインと同じ時間軸**に揃えてあるので、
 * 「氷期のときに何が絶滅したか」を目で対応させられる。
 */

import type { PhyloNode } from "../worker/protocol"
import { GENE_KINDS, FIRST_CAPABILITY } from "../sim/genome"
import { cladeColor } from "../render/layers"
import { earthAnalog } from "./earthAnalog"
import { describePlan, AXES } from "../sim/bodyPlan"
import { GENE_LABELS, geneJa } from "./geneLabels"

const PLANET_AGE = 4.54e9

/** 能力ビットの見出しと絵 */
const CAP: Record<string, { ja: string; icon: string }> = {
  capMotility: { ja: "運動性", icon: "cap-motility" },
  capPredation: { ja: "捕食", icon: "cap-predation" },
  capSkeleton: { ja: "骨格", icon: "cap-skeleton" },
  capMulticellular: { ja: "多細胞", icon: "cap-multicellular" },
  capOxygenicPhotosynthesis: { ja: "酸素発生型光合成", icon: "cap-oxygenic-photo" },
  capEukaryotic: { ja: "真核", icon: "cap-eukaryotic" },
  capNitrogenFixation: { ja: "窒素固定", icon: "cap-nitrogen-fixation" },
  capLandTolerance: { ja: "陸への耐性", icon: "cap-land-tolerance" },
  capSymbolic: { ja: "象徴", icon: "cap-symbolic" },
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;")
const rgb = (c: readonly [number, number, number]) =>
  `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`

function whenLabel(year: number): string {
  const ga = (PLANET_AGE - year) / 1e9
  return ga >= 0.01 ? `${ga.toFixed(2)}Ga` : `${((PLANET_AGE - year) / 1e6).toFixed(0)}Ma`
}

export class Phylogeny {
  private readonly root: HTMLElement
  private readonly treeEl: HTMLElement
  private readonly detailEl: HTMLElement
  private nodes: PhyloNode[] = []
  private originSite = ""
  private selected = -1
  /** タブを開いたときに系譜を要求する */
  onRequest: (() => void) | null = null

  constructor(root: HTMLElement) {
    this.root = root
    root.innerHTML =
      `<div class="row title">生命の系譜` +
      `<button id="phyloReload" class="mini" title="最新にする">⟳</button>` +
      `<button id="phyloClose" class="mini">✕</button></div>` +
      `<div id="phyloHead" class="lg-note"></div>` +
      `<div id="phyloTree" class="phylo-tree"></div>` +
      `<div id="phyloDetail" class="phylo-detail"></div>`
    this.treeEl = root.querySelector("#phyloTree") as HTMLElement
    this.detailEl = root.querySelector("#phyloDetail") as HTMLElement
    ;(root.querySelector("#phyloClose") as HTMLElement)
      .addEventListener("click", () => { this.root.hidden = true })
    ;(root.querySelector("#phyloReload") as HTMLElement)
      .addEventListener("click", () => this.onRequest?.())
    this.treeEl.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-id]") as HTMLElement | null
      if (!el) return
      this.selected = Number(el.dataset.id)
      this.render()
    })
  }

  get open(): boolean { return !this.root.hidden }

  toggle(): void {
    this.root.hidden = !this.root.hidden
    if (!this.root.hidden) this.onRequest?.()
  }

  setData(nodes: PhyloNode[], originYear: number, originSite: string): void {
    this.nodes = nodes
    this.originSite = originSite
    const head = this.root.querySelector("#phyloHead") as HTMLElement
    head.textContent = originYear < 0
      ? "まだ生命が生まれていません"
      : `起源 ${whenLabel(originYear)}・${originSite}　全 ${nodes.length} 系統` +
        `（生存 ${nodes.filter((n) => n.extinctYear < 0).length}）`
    if (this.selected < 0 && nodes.length > 0) this.selected = nodes[0].id
    this.render()
  }

  /** 由来 id → それを持つ系統の数。**相同か収斂かの判定に使う** */
  private originCounts(): Map<number, number> {
    const m = new Map<number, number>()
    for (const n of this.nodes) {
      const seen = new Set<number>()
      for (const g of n.genes) {
        if (seen.has(g.origin)) continue
        seen.add(g.origin)
        m.set(g.origin, (m.get(g.origin) ?? 0) + 1)
      }
    }
    return m
  }

  private render(): void {
    this.renderTree()
    this.renderDetail()
  }

  /**
   * 帯の図。**横が時間、縦が系統**。
   * ★親からの分岐は「親の行から下へ落ちる線」で示す。
   * 本格的な樹形図は場所を食うので、**時間軸を優先**した（下のタイムラインと揃う）。
   */
  private renderTree(): void {
    if (this.nodes.length === 0) { this.treeEl.innerHTML = ""; return }
    // ★**親の下に子を並べる（深さ優先）。** 生まれた順に並べると
    // 親子が離れてしまい、誰から分かれたのかが読めない
    const kids = new Map<number, PhyloNode[]>()
    for (const n of this.nodes) {
      const a = kids.get(n.parent) ?? []
      a.push(n)
      kids.set(n.parent, a)
    }
    for (const a of kids.values()) a.sort((x, y) => x.bornYear - y.bornYear || x.id - y.id)
    const order: { n: PhyloNode; depth: number }[] = []
    const rowOf = new Map<number, number>()
    const walk = (n: PhyloNode, depth: number): void => {
      rowOf.set(n.id, order.length)
      order.push({ n, depth })
      for (const c of kids.get(n.id) ?? []) walk(c, depth + 1)
    }
    // 親が居ないもの（LUCA、および親が history から失われたもの）が根
    const ids = new Set(this.nodes.map((n) => n.id))
    for (const n of this.nodes) {
      if (n.parent < 0 || !ids.has(n.parent)) walk(n, 0)
    }

    const rows = order.map(({ n, depth }) => {
      const x0 = 100 * n.bornYear / PLANET_AGE
      const end = n.extinctYear >= 0 ? n.extinctYear : PLANET_AGE
      const w = Math.max(0.6, 100 * (end - n.bornYear) / PLANET_AGE)
      const col = rgb(cladeColor(n.id))
      const alive = n.extinctYear < 0
      const sel = n.id === this.selected ? " sel" : ""
      // 深さは字下げで示す（枝の入れ子が目で追える）
      return `<div class="ph-row${sel}" data-id="${n.id}" title="クレード ${n.id}">` +
        `<span class="ph-id" style="color:${col};padding-left:${Math.min(depth, 6) * 4}px">` +
        `${n.id}</span>` +
        `<span class="ph-track">` +
        `<i class="ph-bar${alive ? " alive" : ""}" style="left:${x0}%;width:${w}%;background:${col}"></i>` +
        `</span></div>`
    }).join("")

    // ★**分岐の線**。親の帯から、子が生まれた時刻で真下へ降ろす。
    // これが無いと「帯の一覧」であって系統樹ではない
    const H = 15                                   // 1 行の高さ（`.ph-row` と対）
    const links = order.map(({ n }) => {
      if (n.parent < 0) return ""
      const pr = rowOf.get(n.parent)
      const cr = rowOf.get(n.id)
      if (pr === undefined || cr === undefined) return ""
      const x = 100 * n.bornYear / PLANET_AGE
      const top = Math.min(pr, cr) * H + H / 2
      const h = Math.abs(cr - pr) * H
      return `<i class="ph-link" style="left:${x}%;top:${top}px;height:${h}px;` +
        `background:${rgb(cladeColor(n.id))}"></i>`
    }).join("")

    // 時代の目盛り（下のタイムラインと同じ 4/3/2/1 Ga）
    const ticks = [4, 3, 2, 1].map((ga) => {
      const x = 100 * (PLANET_AGE - ga * 1e9) / PLANET_AGE
      return `<i class="ph-tick" style="left:${x}%"><b>${ga}Ga</b></i>`
    }).join("")
    this.treeEl.innerHTML = `<div class="ph-axis">${ticks}</div>` +
      `<div class="ph-rows">${rows}<div class="ph-links">${links}</div></div>`
  }

  private renderDetail(): void {
    const n = this.nodes.find((v) => v.id === this.selected)
    if (!n) { this.detailEl.innerHTML = ""; return }
    const counts = this.originCounts()
    const stat = (k: string, v: string) =>
      `<div class="row stat"><span>${k}</span><span class="num">${esc(v)}</span></div>`

    const parent = n.parent >= 0 ? `クレード ${n.parent}` : `LUCA（${this.originSite}）`
    const kids = this.nodes.filter((v) => v.parent === n.id).map((v) => v.id)
    const isPred = (n.capabilities
      & (1 << (GENE_KINDS.indexOf("capPredation") - FIRST_CAPABILITY))) !== 0
    let html = `<div class="section" style="color:${rgb(cladeColor(n.id))}">`
      + `クレード ${n.id}　`
      + `<span class="cl-role${isPred ? " eat" : ""}">${isPred ? "捕食者" : "生産者"}</span></div>`
      + `<div class="cl-analog${(() => {
        const a = earthAnalog(n.capabilities, n.traits); return a.novel ? " novel" : ""
      })()}">${(() => {
        const a = earthAnalog(n.capabilities, n.traits)
        return esc(a.name) + (a.novel ? "" : `<span class="an-m">一致 ${(100 * a.match).toFixed(0)}%</span>`)
          + `<span class="an-era">${esc(a.era)}</span>`
      })()}</div>`
      + stat("親", parent)
      + stat("子", kids.length ? kids.join(", ") : "なし")
      + stat("生まれた", whenLabel(n.bornYear))
      + stat("絶滅", n.extinctYear >= 0 ? whenLabel(n.extinctYear) : "生存中")
      + stat("続いた", `${((( n.extinctYear >= 0 ? n.extinctYear : PLANET_AGE) - n.bornYear) / 1e6).toFixed(0)} Myr`)

    // ★体制。**能力ビットと違って収斂しない** = 系統の個性
    html += `<div class="section">体制 <span class="hint">分岐でしか変わらない</span></div>`
      + `<div class="cl-plan">${esc(describePlan(Uint8Array.from(n.bodyPlan)))}</div>`
      + AXES.map((a, i) =>
        `<div class="ph-tr"><span>${a.name}</span>`
        + `<i><b style="width:${(100 * (n.bodyPlan[i] ?? 0) / Math.max(1, a.values.length - 1)).toFixed(0)}%"></b></i>`
        + `<span class="num">${esc(a.values[n.bodyPlan[i] ?? 0] ?? "?")}</span></div>`).join("")

    // 能力
    const caps: string[] = []
    for (let k = FIRST_CAPABILITY; k < GENE_KINDS.length; k++) {
      if (!(n.capabilities & (1 << (k - FIRST_CAPABILITY)))) continue
      const meta = CAP[GENE_KINDS[k]]
      if (!meta) continue
      caps.push(`<img class="ico" src="icons/${meta.icon}.png" alt="" title="${meta.ja}" onerror="this.remove()" />`)
    }
    const capNames: string[] = []
    for (let k = FIRST_CAPABILITY; k < GENE_KINDS.length; k++) {
      if (!(n.capabilities & (1 << (k - FIRST_CAPABILITY)))) continue
      const L = GENE_LABELS[GENE_KINDS[k]]
      capNames.push(`<div class="cap-row" title="${esc(L?.what ?? "")}">`
        + `<b>${esc(L?.ja ?? GENE_KINDS[k])}</b>${L?.hard ? `<span class="hard">★ハードステップ</span>` : ""}`
        + `<span class="cap-what">${esc(L?.what ?? "")}</span></div>`)
    }
    html += `<div class="section">能力</div>`
      + (caps.length ? `<div class="cl-caps">${caps.join("")}</div>` : `<div class="lg-note">なし</div>`)
      + capNames.join("")

    // 形質（16 個すべて）
    html += `<div class="section">形質</div>`
    for (let k = 0; k < FIRST_CAPABILITY; k++) {
      const v = n.traits[k] ?? 0
      const L = GENE_LABELS[GENE_KINDS[k]]
      html += `<div class="ph-tr${L?.unused ? " unused" : ""}"`
        + ` title="${esc(L ? L.what : GENE_KINDS[k])}">`
        + `<span>${esc(L?.ja ?? GENE_KINDS[k])}${L?.unused ? "（未使用）" : ""}</span>`
        + `<i><b style="width:${(100 * v).toFixed(0)}%"></b></i>`
        + `<span class="num">${v.toFixed(2)}</span></div>`
    }

    // 遺伝子。★由来 id が他系統と共有なら【相同】、単独なら【この系統の発明】
    html += `<div class="section">遺伝子 <span class="hint">由来 id で相同と収斂を分ける</span></div>`
    const genes = [...n.genes].sort((a, b) => a.kind - b.kind || b.value - a.value)
    html += genes.map((g) => {
      const shared = (counts.get(g.origin) ?? 0) > 1
      return `<div class="ph-gene">`
        + `<span class="g-kind" title="${esc(GENE_LABELS[GENE_KINDS[g.kind]]?.what ?? "")}">`
        + `${esc(geneJa(GENE_KINDS[g.kind] ?? String(g.kind)))}</span>`
        + `<span class="g-val">${g.value.toFixed(0)}</span>`
        + `<span class="g-org ${shared ? "homo" : "novo"}" title="由来 id ${g.origin}">`
        + `${shared ? `相同 #${g.origin}` : `発明 #${g.origin}`}</span>`
        + `</div>`
    }).join("")
    this.detailEl.innerHTML = html
  }
}

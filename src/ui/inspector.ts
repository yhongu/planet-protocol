/**
 * 虫眼鏡。**そのマスの中身を読む**（`docs/03-5`）。
 *
 * ★**1 マスに 1 種族ではない。** `biomass` の場は「レーン × セル」で、
 * 最大 16 クレードが**連続値の取り分**でセルに同居している
 * （`life.ts` の `allocate`: 埋まり具合 = K × max f、取り分 = f^γ/Σf^γ）。
 * 地図に出るのは優占クレードだけなので、内訳はここで読む。
 *
 * 離散のサブグリッドを足す必要は無い。むしろ粒子で踏んだ 1/√n の
 * 標本ノイズ（`CLAUDE.md` の 35）を生命側に持ち込むことになる。
 */

import type { Grid } from "../core/grid"
import type { FieldStore } from "../core/fields"
import type { CladeInfo } from "../worker/protocol"
import { GENE_KINDS, FIRST_CAPABILITY } from "../sim/genome"
import { cladeColor } from "../render/layers"
import { earthAnalog } from "./earthAnalog"
import { describePlan } from "../sim/bodyPlan"
import { GENE_LABELS } from "./geneLabels"
import { gradeOf, GRADE_LABEL, sizeLevel } from "./creatureGrade"
import { creatureImageUrl } from "../render/creatures"

/** 能力ビットの見出しと絵（`public/icons/cap-*.png`） */
const CAP_ICON: Record<string, string> = {
  capMotility: "cap-motility", capPredation: "cap-predation", capSkeleton: "cap-skeleton",
  capMulticellular: "cap-multicellular", capOxygenicPhotosynthesis: "cap-oxygenic-photo",
  capEukaryotic: "cap-eukaryotic", capNitrogenFixation: "cap-nitrogen-fixation",
  capLandTolerance: "cap-land-tolerance", capSymbolic: "cap-symbolic",
}

/** 見出しに出す形質（全部出すと読めない） */
const SHOW_TRAITS: readonly [string, string][] = [
  ["tempOptimum", "最適温度"],
  ["photosynthesis", "光合成"],
  ["oxygenDemand", "酸素要求"],
  ["bodySize", "体サイズ"],
  ["brain", "脳"],
]

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;")
const rgb = (c: readonly [number, number, number]) =>
  `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`

export interface InspectTarget {
  x: number
  y: number
  lonDeg: number
  latDeg: number
}

export class Inspector {
  private readonly root: HTMLElement
  private readonly body: HTMLElement
  private target: InspectTarget | null = null

  constructor(root: HTMLElement) {
    this.root = root
    root.innerHTML =
      `<div class="row title">虫眼鏡 <button id="inspClose" class="mini">✕</button></div>` +
      `<div id="inspBody"></div>`
    this.body = root.querySelector("#inspBody") as HTMLElement
    ;(root.querySelector("#inspClose") as HTMLElement)
      .addEventListener("click", () => this.close())
  }

  get open(): boolean { return !this.root.hidden }

  close(): void {
    this.root.hidden = true
    this.target = null
  }

  /** クリックされたセルを見る。以後 tick ごとに `refresh` で追従する */
  inspect(t: InspectTarget, grid: Grid, store: FieldStore, roster: readonly CladeInfo[]): void {
    this.target = t
    this.root.hidden = false
    this.refresh(grid, store, roster)
  }

  refresh(grid: Grid, store: FieldStore, roster: readonly CladeInfo[]): void {
    const t = this.target
    if (!t || this.root.hidden) return
    const n = grid.cellCount
    const i = t.y * grid.W + t.x
    const el = store.f32("elevation").read[i]
    const ts = store.f32("surfaceTemp").read[i]
    const ice = store.f32("iceFraction").read[i]
    const lf = store.has("landFraction") ? store.f32("landFraction").read[i] : (el >= 0 ? 1 : 0)
    const soil = store.f32("soilMoisture").read[i]
    const tot = store.has("biomassTotal") ? store.f32("biomassTotal").read[i] : 0
    const bio = store.has("biomass") ? store.f32("biomass").read : null

    const ns = t.latDeg >= 0 ? "N" : "S"
    const ew = t.lonDeg >= 0 ? "E" : "W"
    const stat = (k: string, v: string) =>
      `<div class="row stat"><span>${k}</span><span class="num">${esc(v)}</span></div>`

    let html = stat("位置", `${Math.abs(t.latDeg).toFixed(1)}°${ns} ${Math.abs(t.lonDeg).toFixed(1)}°${ew}`)
      + stat("標高", `${el.toFixed(0)} m`)
      + stat("陸の割合", `${(lf * 100).toFixed(0)} %`)
      + stat("地表温度", `${ts.toFixed(1)} ℃`)
      + stat("氷", ice.toFixed(2))
      + stat("土壌水分", soil.toFixed(2))

    html += `<div class="section">このマスの生命</div>`
    if (!bio || tot <= 0 || roster.length === 0) {
      html += `<div class="lg-note">まだ生命がいません</div>`
      this.body.innerHTML = html
      return
    }
    // 取り分の大きい順。★**種数ではなく有効クレード数**で多様性を言う
    const rows = roster
      .map((c) => ({ c, v: bio[c.lane * n + i] }))
      .filter((r) => r.v > 0)
      .sort((a, b) => b.v - a.v)
    let sum2 = 0
    for (const r of rows) { const p = r.v / tot; sum2 += p * p }
    const eff = sum2 > 0 ? 1 / sum2 : 0
    html += stat("総バイオマス", tot.toFixed(4))
      + stat("有効クレード数", eff.toFixed(2))
      + stat("同居しているクレード", String(rows.length))

    for (const { c, v } of rows) {
      const share = (100 * v / tot)
      // 取り分 0.5% 未満は畳む（16 行出ると読めない）
      if (share < 0.5) continue
      const caps: string[] = []
      for (let k = FIRST_CAPABILITY; k < GENE_KINDS.length; k++) {
        if (!(c.capabilities & (1 << (k - FIRST_CAPABILITY)))) continue
        const icon = CAP_ICON[GENE_KINDS[k]]
        const L = GENE_LABELS[GENE_KINDS[k]]
        if (!icon || !L) continue
        caps.push(`<img class="ico" src="icons/${icon}.png" alt=""`
          + ` title="${esc(L.ja)} — ${esc(L.what)}" onerror="this.remove()" />`)
      }
      const traits = SHOW_TRAITS.map(([kind, ja]) => {
        const idx = GENE_KINDS.indexOf(kind as never)
        const v2 = idx >= 0 ? c.traits[idx] ?? 0 : 0
        const L = GENE_LABELS[kind]
        return `<span class="tr" title="${esc(L?.what ?? "")}"><b>${ja}</b>${v2.toFixed(2)}</span>`
      }).join("")
      // ★**栄養段階を出す。** 「何の生物か」への一番直接の答えで、
      // 捕食の能力ビットがそのまま役割になる（`life.ts` の 2 段の配分）
      const role = (c.capabilities & (1 << (GENE_KINDS.indexOf("capPredation") - FIRST_CAPABILITY)))
        ? `<span class="cl-role eat">捕食者</span>`
        : `<span class="cl-role">生産者</span>`
      // ★**「地球で言えば何に近いか」**（`earthAnalog.ts`）。
      // 種名を引くのではなく、形質と能力から**比較として**出す
      const an = earthAnalog(c.capabilities, c.traits)
      // ★**絵は 1 種類の大きさのまま。** 体サイズは**段**で添える
      //   （拡大すると隣のマスへはみ出して地図が壊れる。`creatureGrade.ts`）
      const grade = gradeOf(c.capabilities, c.traits)
      const bs = c.traits[GENE_KINDS.indexOf("bodySize")] ?? 0
      const sz = sizeLevel(bs)
      const pic = creatureImageUrl(grade, c.id)
      // ★**目盛りは文字で描かない。** ▮/▯ はフォントによって幅も太さも違い、
      //   実測では「▮0000」と数字に見えた（`snapshots/ui-inspect.png`）
      const bars = Array.from({ length: 5 }, (_, k) =>
        `<i class="${k < sz.level ? "on" : ""}"></i>`).join("")
      html += `<div class="cl">`
        + `<div class="cl-head">`
        + `<i style="background:${rgb(cladeColor(c.id))}"></i>`
        + `<span class="cl-id">クレード ${c.id}</span>` + role
        + `<span class="cl-share">${share.toFixed(1)} %</span>`
        + `</div>`
        + `<div class="cl-fig">`
        + (pic ? `<img class="cl-pic" src="${pic}" alt="" />` : `<span class="cl-pic"></span>`)
        + `<div class="cl-fig-t">`
        + `<div class="cl-grade">${esc(GRADE_LABEL[grade])}</div>`
        + `<div class="cl-size" title="体サイズ ${bs.toFixed(2)}">`
        + `<b>大きさ</b><span class="lv">${bars}</span>${esc(sz.ja)}</div>`
        + `</div></div>`
        + `<div class="cl-analog${an.novel ? " novel" : ""}" title="${esc(an.era)}">`
        + `${esc(an.name)}`
        + (an.novel ? "" : `<span class="an-m">一致 ${(100 * an.match).toFixed(0)}%</span>`)
        + `</div>`
        // ★体制（`bodyPlan.ts`）。**これが「どんな姿か」そのもの**
        + `<div class="cl-plan">${esc(describePlan(Uint8Array.from(c.bodyPlan)))}</div>`
        // ★遺伝子の中身はここには出さない。**名簿は毎ティック送るので、
        // ゲノムまで載せると postMessage が重い**（`protocol.ts` の注記）。
        // 遺伝子地図は系譜タブ（要求したときだけ送る）で読む
        + `<div class="cl-genes">遺伝子 ${c.genes} 個　<span>系譜タブで内訳</span></div>`
        + (caps.length ? `<div class="cl-caps">${caps.join("")}</div>` : "")
        + `<div class="cl-traits">${traits}</div>`
        + `</div>`
    }
    this.body.innerHTML = html
  }
}

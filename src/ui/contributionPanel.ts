/**
 * 寄与分解パネル。docs/03-5.3「本作の目玉」。
 *
 *   ΔT = +3.2℃
 *     ├ 温室効果 (CO₂)   +1.8
 *     ├ 氷アルベド        +1.1
 *     └ ...
 *
 * 「なぜそうなったか」を毎ティック読めることが、
 * SimEarth が「霧の中のダイヤル」だった部分を学習可能なシステムに変える。
 */

import { CAUSE_LABEL, type LedgerFrame } from "../core/ledger"

export function renderContributions(
  el: HTMLElement, frame: LedgerFrame | null, unit = "K",
): void {
  if (!frame || frame.contributions.length === 0) {
    el.innerHTML = `<div class="cp-empty">変化がありません</div>`
    return
  }
  const eps = unit === "ppm" ? 1e-4 : 1e-6
  const shown = frame.contributions.filter((c) => Math.abs(c.delta) > eps).slice(0, 8)
  if (shown.length === 0) {
    el.innerHTML = `<div class="cp-empty">変化がありません</div>`
    return
  }
  const max = Math.max(...shown.map((c) => Math.abs(c.delta)), Math.abs(frame.total), 1e-9)
  const sign = (v: number) => (v >= 0 ? "+" : "−")
  const digits = unit === "ppm" ? 2 : 3
  const fmt = (v: number) => `${sign(v)}${Math.abs(v).toFixed(digits)}`

  const rows = shown.map((c) => {
    const w = (Math.abs(c.delta) / max) * 50
    const pos = c.delta >= 0
    // 中央を 0 にした発散バー
    const left = pos ? 50 : 50 - w
    return `<div class="cp-row">
      <span class="cp-label">${CAUSE_LABEL[c.cause] ?? c.cause}</span>
      <span class="cp-bar"><i class="${pos ? "pos" : "neg"}"
        style="left:${left}%;width:${w}%"></i></span>
      <span class="cp-val ${pos ? "pos" : "neg"}">${fmt(c.delta)}</span>
    </div>`
  }).join("")

  el.innerHTML =
    `<div class="cp-total">Δ = <b>${fmt(frame.total)}</b> ${unit}</div>${rows}`
}

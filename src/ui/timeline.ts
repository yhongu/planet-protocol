/**
 * タイムライン。docs/03-5.6。
 *
 * 画面下部に 45 億年の全期間バーを置き、主要な出来事をマーカーで刻む。
 * 「時間の重さを感じさせる」（docs/00-5）ための中心的な UI。
 */

import type { WorldEvent } from "../sim/world"
import { EPOCHS } from "../sim/loop"

const PLANET_AGE = 4.54e9

const EPOCH_COLOR: Record<string, string> = {
  hadean: "#4a3a52",
  archean: "#3f4a63",
  proterozoic: "#3a5a5e",
  phanerozoic: "#4a5c3e",
  anthropocene: "#6b4530",
}

const EVENT_STYLE: Record<WorldEvent["kind"], { color: string; height: number }> = {
  lip: { color: "#e0603c", height: 1.0 },
  tectonicMode: { color: "#6fb3d8", height: 0.8 },
  supercontinent: { color: "#c9a227", height: 0.7 },
  impact: { color: "#d84a4a", height: 1.0 },
  milestone: { color: "#8fd18f", height: 0.9 },
}

export interface TimelineState {
  yearsElapsed: number
  events: readonly WorldEvent[]
}

export class Timeline {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private state: TimelineState = { yearsElapsed: 0, events: [] }
  private hoverX = -1

  /** ホバーしたイベントを外に伝える */
  onHoverEvents: ((events: readonly WorldEvent[]) => void) | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("2d context unavailable")
    this.ctx = ctx
    canvas.addEventListener("pointermove", (e) => {
      this.hoverX = e.clientX - canvas.getBoundingClientRect().left
      this.reportHover()
    })
    canvas.addEventListener("pointerleave", () => {
      this.hoverX = -1
      this.onHoverEvents?.([])
    })
  }

  set(state: TimelineState): void {
    this.state = state
  }

  private yearToX(year: number, width: number): number {
    return (year / PLANET_AGE) * width
  }

  private reportHover(): void {
    const width = this.canvas.clientWidth
    if (this.hoverX < 0 || width <= 0) return
    const tol = 6
    const hit = this.state.events.filter(
      (e) => Math.abs(this.yearToX(e.year, width) - this.hoverX) < tol,
    )
    this.onHoverEvents?.(hit)
  }

  draw(): void {
    const dpr = window.devicePixelRatio || 1
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    if (w <= 0 || h <= 0) return
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr)
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw
      this.canvas.height = ph
    }
    const ctx = this.ctx
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const barTop = 14
    const barH = h - barTop - 12

    // --- エポックの帯 ---
    for (let i = 0; i < EPOCHS.length; i++) {
      const e = EPOCHS[i]
      const startYear = PLANET_AGE - e.startGa * 1e9
      const endYear = i + 1 < EPOCHS.length
        ? PLANET_AGE - EPOCHS[i + 1].startGa * 1e9
        : PLANET_AGE
      const x0 = Math.max(0, this.yearToX(startYear, w))
      const x1 = Math.min(w, this.yearToX(endYear, w))
      if (x1 <= x0) continue
      ctx.fillStyle = EPOCH_COLOR[e.id] ?? "#3a3a3a"
      ctx.fillRect(x0, barTop, x1 - x0, barH)
      // 幅が足りるときだけ名前を書く
      if (x1 - x0 > 46) {
        ctx.fillStyle = "rgba(255,255,255,0.55)"
        ctx.font = "9px ui-monospace, monospace"
        ctx.fillText(e.label, x0 + 4, barTop + 10)
      }
    }

    // --- 10 億年ごとの目盛り ---
    ctx.strokeStyle = "rgba(255,255,255,0.18)"
    ctx.fillStyle = "rgba(255,255,255,0.45)"
    ctx.font = "9px ui-monospace, monospace"
    ctx.lineWidth = 1
    for (let ga = 4; ga >= 0; ga--) {
      const x = this.yearToX(PLANET_AGE - ga * 1e9, w)
      ctx.beginPath()
      ctx.moveTo(x, barTop)
      ctx.lineTo(x, barTop + barH)
      ctx.stroke()
      ctx.fillText(ga === 0 ? "現在" : `${ga} Ga`, Math.min(w - 26, x + 3), barTop - 4)
    }

    // --- 出来事のマーカー ---
    for (const ev of this.state.events) {
      const st = EVENT_STYLE[ev.kind]
      const x = this.yearToX(ev.year, w)
      ctx.strokeStyle = st.color
      ctx.lineWidth = 1.5
      ctx.globalAlpha = 0.9
      ctx.beginPath()
      ctx.moveTo(x, barTop + barH)
      ctx.lineTo(x, barTop + barH * (1 - st.height))
      ctx.stroke()
    }
    ctx.globalAlpha = 1

    // --- 現在位置 ---
    const cx = this.yearToX(this.state.yearsElapsed, w)
    ctx.fillStyle = "#f0f4f8"
    ctx.fillRect(cx - 1, barTop - 3, 2, barH + 6)
    ctx.beginPath()
    ctx.moveTo(cx, barTop - 6)
    ctx.lineTo(cx - 4, barTop - 12)
    ctx.lineTo(cx + 4, barTop - 12)
    ctx.closePath()
    ctx.fill()

    // 未来側を暗くする
    ctx.fillStyle = "rgba(8,10,14,0.55)"
    ctx.fillRect(cx, barTop, w - cx, barH)
  }
}

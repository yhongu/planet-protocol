/**
 * 定量的な場のカラーマップ。
 *
 * docs/03-5.2。知覚均等に近いものを使う。虹色 (jet) は使わない
 * ——明度が単調でなく、存在しない構造を見せてしまうため。
 */
import type { Rgb } from "./palette"

function ramp(stops: readonly (readonly [number, Rgb])[], t: number): Rgb {
  if (t <= stops[0][0]) return stops[0][1]
  const last = stops[stops.length - 1]
  if (t >= last[0]) return last[1]
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [a0, ca] = stops[i - 1]
      const [b0, cb] = stops[i]
      const f = (t - a0) / (b0 - a0)
      return [ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f, ca[2] + (cb[2] - ca[2]) * f]
    }
  }
  return last[1]
}

/** 発散型（寒色 - 白 - 暖色）。0degC を白にして気温に使う */
const DIVERGING: readonly (readonly [number, Rgb])[] = [
  [0.0, [12, 32, 82]], [0.15, [30, 84, 160]], [0.32, [96, 158, 210]],
  [0.5, [244, 244, 240]],
  [0.68, [235, 168, 96]], [0.85, [196, 76, 40]], [1.0, [104, 16, 22]],
]

/** 逐次型（暗 - 明）。アルベドなど 0..1 の量に使う */
const SEQUENTIAL: readonly (readonly [number, Rgb])[] = [
  [0.0, [16, 20, 34]], [0.25, [44, 62, 106]], [0.5, [76, 118, 150]],
  [0.75, [150, 186, 196]], [1.0, [248, 250, 252]],
]

/** 気温 [degC] -> 色。-60..+50 を割り当て、0degC が白になるよう非対称に伸ばす */
export function temperatureColor(c: number): Rgb {
  const t = c < 0 ? 0.5 * (1 - Math.min(1, -c / 60)) : 0.5 + 0.5 * Math.min(1, c / 50)
  return ramp(DIVERGING, t)
}

export function sequentialColor(t: number): Rgb {
  return ramp(SEQUENTIAL, Math.max(0, Math.min(1, t)))
}

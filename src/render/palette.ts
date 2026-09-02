/**
 * カラーマップ。
 *
 * docs/03-5.2 のレイヤ表示で使う。標高は hypsometric tint（地図の標準的な段彩）。
 * 定量的な場（気温・降水など）には M1 以降で知覚均等なカラーマップを足す。
 */

export type Rgb = readonly [number, number, number]

interface Stop {
  readonly at: number
  readonly color: Rgb
}

function rampLookup(stops: readonly Stop[], t: number): Rgb {
  if (t <= stops[0].at) return stops[0].color
  const last = stops[stops.length - 1]
  if (t >= last.at) return last.color
  for (let i = 1; i < stops.length; i++) {
    const b = stops[i]
    if (t <= b.at) {
      const a = stops[i - 1]
      const f = (t - a.at) / (b.at - a.at)
      return [
        a.color[0] + (b.color[0] - a.color[0]) * f,
        a.color[1] + (b.color[1] - a.color[1]) * f,
        a.color[2] + (b.color[2] - a.color[2]) * f,
      ]
    }
  }
  return last.color
}

/** 海底の段彩（-6000m 〜 0m） */
const OCEAN: readonly Stop[] = [
  { at: -6000, color: [8, 24, 58] },
  { at: -4000, color: [14, 44, 92] },
  { at: -2000, color: [24, 72, 132] },
  { at: -500, color: [40, 108, 170] },
  { at: -120, color: [72, 148, 200] },
  { at: 0, color: [122, 186, 220] },
]

/** 陸地の段彩（0m 〜 5500m） */
const LAND: readonly Stop[] = [
  { at: 0, color: [72, 122, 78] },
  { at: 250, color: [104, 148, 84] },
  { at: 700, color: [156, 172, 96] },
  { at: 1400, color: [186, 158, 104] },
  { at: 2300, color: [156, 122, 92] },
  { at: 3400, color: [138, 122, 118] },
  { at: 4300, color: [190, 190, 194] },
  { at: 5500, color: [246, 248, 252] },
]

export function elevationColor(m: number): Rgb {
  return m >= 0 ? rampLookup(LAND, m) : rampLookup(OCEAN, m)
}

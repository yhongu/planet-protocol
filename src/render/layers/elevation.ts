import type { Grid } from "../../core/grid"
import type { FieldStore } from "../../core/fields"
import { elevationColor } from "../palette"
import { sampleBilinear } from "./index"
import type { LayerEnv } from "../planetView"

/**
 * 標高レイヤ。
 *
 * 陰影（hillshade）を薄く重ねて地形の起伏を読めるようにする。
 * 東西方向の勾配計算はラップさせること（そうしないと x=0 の列に縦線が出る）。
 *
 * ★**液体の海が無いときに青く塗ってはいけない。**
 * 冥王代のマグマオーシャン期は水がすべて水蒸気として大気にあるので
 * （`HADEAN_START.steamFraction = 1`）、海抜 0m 以下は「海」ではなく
 * **溶けた岩**である。`env.oceanWaterFraction` で切り替える。
 */
export function renderElevation(
  grid: Grid, store: FieldStore, out: Uint8ClampedArray, ss: number, env: LayerEnv,
): void {
  const { W, H } = grid
  const e = store.f32("elevation").read
  // 液体の海の割合。0 ならマグマオーシャン（水は全部水蒸気）
  const ocean = Math.max(0, Math.min(1, env.oceanWaterFraction))
  // マントルが熱いほど明るく光る（1350℃ で 0、2250℃ で 1）
  const glow = Math.max(0, Math.min(1, (env.mantleTempC - 1350) / 900))
  const OW = W * ss, OH = H * ss
  const inv = 1 / ss
  // 陰影の勾配は 1 セル分の距離で取る（解像度によらず同じ強さにする）
  const d = 1

  for (let py = 0; py < OH; py++) {
    const fy = (py + 0.5) * inv - 0.5
    let o = py * OW * 4
    for (let px = 0; px < OW; px++) {
      const fx = (px + 0.5) * inv - 0.5
      // 【標高を先に補間してから着色する】。
      // セルごとに色を決めてから拡大すると海岸線がギザギザになるが、
      // 先に補間すれば海岸線は 0 等高線の滑らかな曲線になる。
      const h = sampleBilinear(e, W, H, fx, fy)
      const c = h < 0 && ocean < 1
        ? magmaColor(h, 1 - ocean, glow)
        : elevationColor(h)

      let shade = 1
      if (h >= 0 || ocean < 1) {
        const dzdx = sampleBilinear(e, W, H, fx + d, fy) - sampleBilinear(e, W, H, fx - d, fy)
        const dzdy = sampleBilinear(e, W, H, fx, fy + d) - sampleBilinear(e, W, H, fx, fy - d)
        const s = (-dzdx * 0.6 - dzdy * 0.8) / 900
        shade = 1 + Math.max(-0.45, Math.min(0.45, s))
      }
      out[o] = c[0] * shade
      out[o + 1] = c[1] * shade
      out[o + 2] = c[2] * shade
      out[o + 3] = 255
      o += 4
    }
  }
}

/**
 * 溶けた岩の色。深いほど熱い（＝明るい）ように見せる。
 *
 * `dry` は液体の海がどれだけ無いか（1 = 完全なマグマオーシャン）。
 * 凝結が進むと海の青へ滑らかに戻る。
 * `glow` はマントル温度から作る発光の強さ。
 */
function magmaColor(h: number, dry: number, glow: number): readonly [number, number, number] {
  // 深いところほど熱い。-6000m で最大
  const d = Math.max(0, Math.min(1, -h / 6000))
  const heat = Math.max(0, Math.min(1, 0.25 + 0.75 * d)) * (0.35 + 0.65 * glow)
  // 暗い玄武岩 → 赤熱 → 橙 → 白熱
  const r = 40 + 215 * Math.pow(heat, 0.6)
  const g = 18 + 150 * Math.pow(Math.max(0, heat - 0.25) / 0.75, 1.6)
  const b = 16 + 90 * Math.pow(Math.max(0, heat - 0.7) / 0.3, 2.2)
  // 海が戻ってくると青へ混ぜ戻す
  const sea = elevationColor(h)
  const k = dry
  return [
    sea[0] + (r - sea[0]) * k,
    sea[1] + (g - sea[1]) * k,
    sea[2] + (b - sea[2]) * k,
  ] as const
}

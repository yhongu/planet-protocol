/**
 * 厚さ分布そのものを監査する。
 *
 * 時系列で分かったこと:
 *   大陸体積は ±8% しか動かないのに、陸% は 3.2 倍動く。
 *   厚さ P90 が 31→67km と 2 倍振れる（上限は maxThickness=75km）。
 * 体積が保存されているのに分布形が暴れている、というのが本当の症状。
 * どこに厚さが溜まり、どこが空になっているのかを見る。
 */
import { World, PLANET_AGE_YEARS } from "../src/sim/world"

const W = 64, H = 32
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const STEP = 4e6
const LAND_THICK = 4.8 / 0.1515       // 31.7km

const w = new World({ width: W, height: H, seed: "hadean-01", shared: false, startEpoch: "hadean" })
const BINS = [0, 1, 5, 10, 15, 20, 25, 31.7, 40, 50, 60, 70, 75.1]
console.log("厚さ分布の時間変化 [面積%]   陸海閾値 31.7km / 上限 75km")
console.log("Ga前  陸%  " + BINS.slice(0, -1).map((b, i) =>
  `${b}-${BINS[i+1]}`.padStart(8)).join("") + "   上限張付%")

const marks = [4.5, 4.0, 3.5, 3.0, 2.5, 2.0, 1.5, 1.0, 0.5, 0.0]
let mi = 0
while (w.globals.yearsElapsed < PLANET_AGE_YEARS && mi < marks.length) {
  const ga = (PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9
  if (ga <= marks[mi]) {
    const th = w.store.f32("crustThickness").read
    const el = w.store.f32("elevation").read
    const acc = new Array(BINS.length - 1).fill(0)
    let pinned = 0
    for (let y = 0; y < H; y++) {
      const aw = w.grid.areaWeight[y]
      for (let x = 0; x < W; x++) {
        const v = th[y * W + x]
        let b = 0
        while (b < BINS.length - 2 && v >= BINS[b + 1]) b++
        acc[b] += aw
        if (v >= 74.9) pinned += aw
      }
    }
    const land = 100 * w.grid.areaFractionWhere(el, (v) => v >= w.globals.seaLevel)
    console.log(`${ga.toFixed(2).padStart(5)} ${land.toFixed(1).padStart(4)}  ` +
      acc.map((v) => (v * 100).toFixed(1).padStart(8)).join("") +
      `   ${(pinned * 100).toFixed(1).padStart(8)}`)
    mi++
  }
  w.advance(STEP, OPT)
}
console.log(`\n陸になるには厚さ ${LAND_THICK.toFixed(1)}km が必要。`)
console.log("参考: 地球の大陸地殻は平均 35-40km、チベットで約 70km（ごく一部）")

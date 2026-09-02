/**
 * 高度分布（ヒプソメトリー）を時代ごとに測る。
 *
 * 陸%が 8.8% と 29.3% の間を往復するのに、陸の平均標高はほとんど動かない。
 * 海面(0m)付近にセルが溜まっていると、わずかな上下で大面積が海陸を行き来する。
 * 実際の地球の高度分布は【二峰性】（大陸棚 0〜1000m と深海平原 −4000m）で、
 * 海面付近の面積は小さい。そこを確かめる。
 */
import { World, PLANET_AGE_YEARS } from "../src/sim/world"

const W = 64, H = 32
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const BINS = [-6000, -5000, -4000, -3000, -2000, -1000, -500, -200, 0,
  200, 500, 1000, 2000, 3000, 5000, 99999]

const w = new World({ width: W, height: H, seed: "hadean-01", shared: false, startEpoch: "hadean" })

function hypsometry(): number[] {
  const e = w.store.f32("elevation").read
  const acc = new Array(BINS.length).fill(0)
  for (let y = 0; y < H; y++) {
    const aw = w.grid.areaWeight[y]
    for (let x = 0; x < W; x++) {
      const v = e[y * W + x]
      let b = 0
      while (b < BINS.length - 1 && v >= BINS[b]) b++
      acc[b] += aw
    }
  }
  return acc.map((v) => 100 * v)
}

const label = (i: number) => i === 0 ? `<${BINS[0]}` : `${BINS[i-1]}`
console.log("高度分布 [面積%]  （64x32）")
console.log("Ga前  陸%  " + BINS.slice(0, -1).map((_, i) => label(i).padStart(6)).join(""))

const marks = [4.54, 4.0, 3.5, 3.0, 2.5, 2.0, 1.5, 1.0, 0.5, 0.0]
let mi = 0
while (w.globals.yearsElapsed < PLANET_AGE_YEARS && mi < marks.length) {
  const ga = (PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9
  if (ga <= marks[mi]) {
    const h = hypsometry()
    const land = 100 * w.grid.areaFractionWhere(w.store.f32("elevation").read, (v) => v >= 0)
    console.log(`${ga.toFixed(2).padStart(5)} ${land.toFixed(1).padStart(5)}  ` +
      h.slice(0, -1).map((v) => v.toFixed(1).padStart(6)).join(""))
    mi++
  }
  w.advance(5e6, OPT)
}
console.log("\n参考: 実際の地球")
console.log("        29.2    2.3   9.5  22.9  17.5   5.9   3.5   2.4   2.5   2.2   4.4   9.0   9.4   4.5   0.3")
console.log("        （深海平原 −4000〜−5000m に集中し、海面(0m)付近は薄い＝二峰性）")

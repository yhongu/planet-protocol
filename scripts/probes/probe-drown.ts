/**
 * 大陸が薄く広がって沈む原因を切り分ける。
 *
 * 20 億年走らせて、機構を 1 つずつ止めたときに何が変わるかを見る。
 * パラメータを当てずに、原因を消して確かめる。
 */
import { World } from "../src/sim/world"

const W = 64, H = 32
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const YEARS = 2.0e9, STEP = 5e6

const CASES: Array<[string, Record<string, number>]> = [
  ["基準", {}],
  ["造山なし", { orogenyRate: 0 }],
  ["リフトなし", { riftRate: 0, riftThreshold: 1e9 }],
  ["侵食なし", { denudationRate: 0 }],
  ["弧成長なし", { crustGrowthRate: 0 }],
  ["プレート静止", { plateSpeed: 0 }],
]

console.log(`大陸沈没の原因切り分け  ${W}x${H}  ${YEARS/1e9}Gyr`)
console.log("条件            陸%   厚>30km%  厚20-30km%  平均厚[km]  地殻体積比  最高m")
for (const [name, patch] of CASES) {
  const w = new World({
    width: W, height: H, seed: "hadean-01", shared: false, startEpoch: "hadean",
    tectonics: patch,
  })
  const thick0 = Float32Array.from(w.store.f32("crustThickness").read)
  let v0 = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) v0 += thick0[y*W+x] * w.grid.areaWeight[y]

  while (w.globals.yearsElapsed < YEARS) w.advance(STEP, OPT)

  const th = w.store.f32("crustThickness").read
  const el = w.store.f32("elevation").read
  let thick30 = 0, thick20 = 0, vol = 0, maxE = -Infinity
  for (let y = 0; y < H; y++) {
    const aw = w.grid.areaWeight[y]
    for (let x = 0; x < W; x++) {
      const i = y*W+x
      vol += th[i] * aw
      if (th[i] >= 30) thick30 += aw
      else if (th[i] >= 20) thick20 += aw
      if (el[i] > maxE) maxE = el[i]
    }
  }
  const land = 100 * w.grid.areaFractionWhere(el, (v) => v >= 0)
  console.log(`${name.padEnd(14)} ${land.toFixed(1).padStart(5)} ${(thick30*100).toFixed(1).padStart(9)} ` +
    `${(thick20*100).toFixed(1).padStart(11)} ${vol.toFixed(1).padStart(11)} ` +
    `${(vol/v0).toFixed(3).padStart(11)} ${maxE.toFixed(0).padStart(7)}`)
}
console.log("\n初期状態の参考値は「基準」の行の直前と比べること（陸 29%、厚>30km は約 29%）")

/**
 * 堆積の受け皿の定義を変えて、大陸が保たれるかを測る。
 *
 * 仮説: 受け皿が厚さ 4.5km 以上（＝海洋地殻を含む）なので、
 * 削れた大陸地殻が海洋地殻の上に載って「厚さ 20-30km の沈んだ大陸」を作る。
 * 実際には海洋地殻上の堆積物は沈み込んで戻らない。
 */
import { World } from "../src/sim/world"

const W = 64, H = 32
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const YEARS = 2.0e9, STEP = 5e6

const CASES: Array<[string, Record<string, number>]> = [
  ["基準 (0.45, 無制限)", {}],
  ["受け皿 0.8", { shelfMinFactor: 0.8 }],
  ["受け皿 1.0 (大陸のみ)", { shelfMinFactor: 1.0 }],
  ["受け皿 1.3", { shelfMinFactor: 1.3 }],
  ["収容限界 0.2km", { shelfAccommodationKm: 0.2 }],
  ["1.0 + 収容 0.2km", { shelfMinFactor: 1.0, shelfAccommodationKm: 0.2 }],
]

console.log(`堆積の受け皿の検証  ${W}x${H}  ${YEARS/1e9}Gyr   （地球: 陸 29%、大陸地殻は全体の約 40%）`)
console.log("条件                    陸%  厚>30km% 厚20-30km%  体積比  最高m  平均陸標高m")
for (const [name, patch] of CASES) {
  const w = new World({
    width: W, height: H, seed: "hadean-01", shared: false, startEpoch: "hadean",
    tectonics: patch,
  })
  let v0 = 0
  { const t = w.store.f32("crustThickness").read
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) v0 += t[y*W+x] * w.grid.areaWeight[y] }
  while (w.globals.yearsElapsed < YEARS) w.advance(STEP, OPT)
  const th = w.store.f32("crustThickness").read
  const el = w.store.f32("elevation").read
  let t30 = 0, t20 = 0, vol = 0, maxE = -Infinity, lsum = 0, ln = 0
  for (let y = 0; y < H; y++) {
    const aw = w.grid.areaWeight[y]
    for (let x = 0; x < W; x++) {
      const i = y*W+x
      vol += th[i] * aw
      if (th[i] >= 30) t30 += aw; else if (th[i] >= 20) t20 += aw
      if (el[i] > maxE) maxE = el[i]
      if (el[i] >= 0) { lsum += el[i]; ln++ }
    }
  }
  const land = 100 * w.grid.areaFractionWhere(el, (v) => v >= 0)
  console.log(`${name.padEnd(22)} ${land.toFixed(1).padStart(5)} ${(t30*100).toFixed(1).padStart(8)} ` +
    `${(t20*100).toFixed(1).padStart(10)} ${(vol/v0).toFixed(3).padStart(7)} ${maxE.toFixed(0).padStart(6)} ` +
    `${(ln?lsum/ln:0).toFixed(0).padStart(11)}`)
}

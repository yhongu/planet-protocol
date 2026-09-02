/**
 * 体積クランプが陸地の振動源かを確かめる。
 *
 * クランプは厚さ分布を RIFT_FLOOR(13km) に向かって一律に圧縮する。
 * さらに saturation = 1 - 大陸体積/目標体積 が島弧成長をオン/オフするので、
 * 「成長 → 目標到達 → 成長停止 → クランプで圧縮 → 体積低下 → 成長再開」
 * という緩和振動になりうる。侵食と無関係なので、侵食を切っても残る説明がつく。
 */
import { World, PLANET_AGE_YEARS } from "../src/sim/world"

const W = 64, H = 32
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const STEP = 4e6

const CASES: Array<[string, Record<string, number>]> = [
  ["基準", {}],
  ["クランプなし", { volumeClamp: 0 }],
  ["目標体積3倍(飽和させない)", { targetCrustVolume: 21.6e9 }],
  ["クランプなし+受け皿1.0", { volumeClamp: 0, shelfMinFactor: 1.0 }],
]
console.log(`体積クランプの検証  ${W}x${H}  全史  seed hadean-01`)
console.log("条件                     陸%   CO2    T   体積比 | 平均  最小-最大 (振れ幅)")
for (const [name, patch] of CASES) {
  const w = new World({
    width: W, height: H, seed: "hadean-01", shared: false, startEpoch: "hadean",
    tectonics: patch,
  })
  let v0 = 0
  { const t = w.store.f32("crustThickness").read
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) v0 += t[y*W+x] * w.grid.areaWeight[y] }
  const hist: number[] = []
  while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
    w.advance(STEP, OPT)
    if (w.globals.yearsElapsed > PLANET_AGE_YEARS - 2e9) {
      hist.push(100 * w.grid.areaFractionWhere(
        w.store.f32("elevation").read, (v) => v >= w.globals.seaLevel))
    }
  }
  let v1 = 0
  { const t = w.store.f32("crustThickness").read
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) v1 += t[y*W+x] * w.grid.areaWeight[y] }
  const land = 100 * w.grid.areaFractionWhere(
    w.store.f32("elevation").read, (v) => v >= w.globals.seaLevel)
  const mn = Math.min(...hist), mx = Math.max(...hist)
  const mean = hist.reduce((a,b)=>a+b,0)/hist.length
  console.log(`${name.padEnd(24)} ${land.toFixed(1).padStart(5)} ${w.globals.co2.toFixed(0).padStart(6)} ` +
    `${w.stats!.meanT.toFixed(1).padStart(5)} ${(v1/v0).toFixed(2).padStart(6)} | ${mean.toFixed(1).padStart(5)} ` +
    `${mn.toFixed(1).padStart(5)}-${mx.toFixed(1).padStart(5)} (${(mx-mn).toFixed(1).padStart(5)})`)
}

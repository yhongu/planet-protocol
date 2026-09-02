/**
 * 受け皿の閾値を決める。全史 4.54 Gyr を回し、
 * 【現在の地球に着地するか】と【陸の振動が収まるか】で評価する。
 */
import { World, PLANET_AGE_YEARS } from "../src/sim/world"

const W = 64, H = 32
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const STEP = 4e6

const CASES = [0.45, 0.8, 1.0, 1.2]
const SEEDS = ["hadean-01", "gaia-77"]

console.log(`受け皿の閾値と全史の着地  ${W}x${H}`)
console.log("地球の値: 陸 29.2%  CO2 280ppm  T 15C  最高 8848m  平均陸標高 840m\n")
console.log("係数 seed       陸%   CO2    T    最高m 平均陸m | 直近2Gyrの陸% 最小-最大(振れ幅)")
for (const f of CASES) {
  for (const seed of SEEDS) {
    const w = new World({
      width: W, height: H, seed, shared: false, startEpoch: "hadean",
      tectonics: { shelfMinFactor: f },
    })
    const hist: number[] = []
    while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
      w.advance(STEP, OPT)
      if (w.globals.yearsElapsed > PLANET_AGE_YEARS - 2e9) {
        hist.push(100 * w.grid.areaFractionWhere(w.store.f32("elevation").read, (v) => v >= 0))
      }
    }
    const el = w.store.f32("elevation").read
    let maxE = -Infinity, lsum = 0, ln = 0
    for (let i = 0; i < el.length; i++) {
      if (el[i] > maxE) maxE = el[i]
      if (el[i] >= 0) { lsum += el[i]; ln++ }
    }
    const land = 100 * w.grid.areaFractionWhere(el, (v) => v >= 0)
    const mn = Math.min(...hist), mx = Math.max(...hist)
    console.log(`${f.toFixed(2)} ${seed.padEnd(10)} ${land.toFixed(1).padStart(5)} ` +
      `${w.globals.co2.toFixed(0).padStart(6)} ${w.stats!.meanT.toFixed(1).padStart(5)} ` +
      `${maxE.toFixed(0).padStart(6)} ${(ln?lsum/ln:0).toFixed(0).padStart(7)} | ` +
      `${mn.toFixed(1).padStart(5)} -${mx.toFixed(1).padStart(6)} (${(mx-mn).toFixed(1).padStart(5)})`)
  }
}

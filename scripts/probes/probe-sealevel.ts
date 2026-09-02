/**
 * 海面を海水量から決めるようにした効果を測る。
 * 陸地の振れ幅が縮むかどうかが判定基準。
 */
import { World, PLANET_AGE_YEARS } from "../src/sim/world"

const W = 64, H = 32
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const STEP = 4e6

for (const seed of ["hadean-01", "gaia-77"]) {
  for (const f of [0.45, 1.0]) {
    const w = new World({
      width: W, height: H, seed, shared: false, startEpoch: "hadean",
      tectonics: { shelfMinFactor: f },
    })
    const hist: number[] = [], sea: number[] = []
    while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
      w.advance(STEP, OPT)
      if (w.globals.yearsElapsed > PLANET_AGE_YEARS - 2e9) {
        hist.push(100 * w.grid.areaFractionWhere(
          w.store.f32("elevation").read, (v) => v >= w.globals.seaLevel))
        sea.push(w.globals.seaLevel)
      }
    }
    const land = 100 * w.grid.areaFractionWhere(
      w.store.f32("elevation").read, (v) => v >= w.globals.seaLevel)
    const mn = Math.min(...hist), mx = Math.max(...hist)
    const mean = hist.reduce((a, b) => a + b, 0) / hist.length
    console.log(`${seed.padEnd(10)} 受け皿${f.toFixed(2)}  陸 ${land.toFixed(1).padStart(5)}%  ` +
      `CO2 ${w.globals.co2.toFixed(0).padStart(6)}  T ${w.stats!.meanT.toFixed(1).padStart(5)}  ` +
      `海面 ${w.globals.seaLevel.toFixed(0).padStart(6)}m | 平均 ${mean.toFixed(1).padStart(5)} ` +
      `${mn.toFixed(1).padStart(5)}-${mx.toFixed(1).padStart(5)} (振れ幅 ${(mx-mn).toFixed(1).padStart(5)})`)
  }
}

import { Grid } from "../src/core/grid"
import { FieldStore } from "../src/core/fields"
import { generateTerrain, DEFAULT_TERRAIN } from "../src/worldgen/terrain"
import { Climate, M1_FIELDS } from "../src/sim/climate"
import { EARTH_PARAMS, earthGlobals } from "../src/sim/state"

const grid = new Grid(128, 64)
const store = new FieldStore(grid, M1_FIELDS, { shared: false })
generateTerrain(grid, store, "hadean-01", DEFAULT_TERRAIN)
const clim = new Climate(grid)
const g = earthGlobals()
store.f32("temperature").read.fill(15)
store.f32("albedo").read.fill(0.3)
console.log("冷間開始からの擬似時間発展:")
const s = clim.solve(store, EARTH_PARAMS, g, {
  dtYears: null, cgTol: 1e-2, maxOuter: 60,
  onNewtonStep: (i, r, cg, un) => {
    if (i < 25 || i % 10 === 0)
      console.log(`  N${String(i).padStart(2)}  residK ${r.toExponential(3).padStart(10)}  cg ${String(cg).padStart(4)}  unstable ${un}`)
  },
})
console.log(`\n結果: mean ${s.meanT.toFixed(3)}  ice ${s.iceFraction.toFixed(3)}  imbal ${s.imbalance.toExponential(2)}  conv ${s.converged}  step ${s.lastStep}  resid ${s.residual.toExponential(2)}`)

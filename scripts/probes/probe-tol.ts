import { Grid } from "../src/core/grid"
import { FieldStore } from "../src/core/fields"
import { generateTerrain, DEFAULT_TERRAIN } from "../src/worldgen/terrain"
import { Climate, M1_FIELDS } from "../src/sim/climate"
import { EARTH_PARAMS, earthGlobals } from "../src/sim/state"

const W = 256, H = 128
const grid = new Grid(W, H)
const store = new FieldStore(grid, M1_FIELDS, { shared: false })
generateTerrain(grid, store, "hadean-01", DEFAULT_TERRAIN)
const clim = new Climate(grid)
const g = earthGlobals()

console.log("cgTol   outer    cg     ms | meanT     ice    imbalance")
for (const cgTol of [1e-8, 1e-6, 1e-4, 1e-3, 1e-2]) {
  store.f32("temperature").read.fill(15)
  store.f32("albedo").read.fill(0.3)
  const t0 = performance.now()
  const s = clim.solve(store, EARTH_PARAMS, g, { dtYears: null, cgTol })
  const ms = performance.now() - t0
  console.log(
    `${cgTol.toExponential(0).padStart(6)} ${String(s.iterations).padStart(6)} ${String(s.cgIterations).padStart(6)} ` +
    `${ms.toFixed(0).padStart(5)} | ${s.meanT.toFixed(4).padStart(8)} ${s.iceFraction.toFixed(4)} ${s.imbalance.toExponential(1).padStart(9)}`,
  )
}

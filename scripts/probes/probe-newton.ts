import { Grid } from "../src/core/grid"
import { FieldStore } from "../src/core/fields"
import { generateTerrain, DEFAULT_TERRAIN } from "../src/worldgen/terrain"
import { Climate, M1_FIELDS } from "../src/sim/climate"
import { EARTH_PARAMS, earthGlobals } from "../src/sim/state"

const grid = new Grid(256, 128)
const store = new FieldStore(grid, M1_FIELDS, { shared: false })
generateTerrain(grid, store, "hadean-01", DEFAULT_TERRAIN)
const clim = new Climate(grid)
const g = earthGlobals()
store.f32("temperature").read.fill(15)
store.f32("albedo").read.fill(0.3)
clim.solve(store, EARTH_PARAMS, g, { dtYears: null, cgTol: 1e-2 })

console.log("CO2 280 -> 300 ppm の Newton 収束:")
clim.solve(store, EARTH_PARAMS, { ...g, co2: 300 }, {
  dtYears: null, cgTol: 1e-2,
  onNewtonStep: (i, r, cg, un) =>
    console.log(`  N${String(i).padStart(2)}  residK ${r.toExponential(2).padStart(9)}  cg ${String(cg).padStart(4)}  unstable ${un}`),
})
console.log("\ncgTol を 1e-4 に絞った場合:")
store.f32("temperature").read.fill(15); store.f32("albedo").read.fill(0.3)
clim.solve(store, EARTH_PARAMS, g, { dtYears: null, cgTol: 1e-2 })
clim.solve(store, EARTH_PARAMS, { ...g, co2: 300 }, {
  dtYears: null, cgTol: 1e-4,
  onNewtonStep: (i, r, cg) => console.log(`  N${String(i).padStart(2)}  residK ${r.toExponential(2).padStart(9)}  cg ${String(cg).padStart(4)}`),
})

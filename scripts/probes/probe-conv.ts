import { Grid } from "../src/core/grid"
import { FieldStore } from "../src/core/fields"
import { generateTerrain, DEFAULT_TERRAIN } from "../src/worldgen/terrain"
import { Climate, M1_FIELDS } from "../src/sim/climate"
import { EARTH_PARAMS, earthGlobals } from "../src/sim/state"

const W = 128, H = 64
const grid = new Grid(W, H)
const store = new FieldStore(grid, M1_FIELDS, { shared: false })
generateTerrain(grid, store, "hadean-01", DEFAULT_TERRAIN)
const clim = new Climate(grid)
const g = earthGlobals()

// 1 outer ずつ回して収束の様子を見る
store.f32("temperature").read.fill(15)
store.f32("albedo").read.fill(0.3)
console.log("outer  meanT    imbalance   ice     alb")
for (let k = 1; k <= 40; k++) {
  const s = clim.solve(store, EARTH_PARAMS, g, { dtYears: null, maxOuter: 1, innerSweeps: 2, tol: 0 })
  if (k <= 10 || k % 5 === 0)
    console.log(`${String(k).padStart(5)}  ${s.meanT.toFixed(3).padStart(7)}  ${s.imbalance.toFixed(4).padStart(9)}  ${s.iceFraction.toFixed(3)}  ${s.planetaryAlbedo.toFixed(3)}`)
}

// 幾何係数の確認
console.log("\n幾何係数 (H=64):")
const geo = (clim as unknown as { geo: { cN: Float64Array; cS: Float64Array; cZ: Float64Array } }).geo
for (const y of [0, 1, 2, 8, 16, 31, 32]) {
  console.log(`  y=${String(y).padStart(2)} lat ${grid.latDeg[y].toFixed(1).padStart(6)}°  cN ${geo.cN[y].toExponential(2)}  cS ${geo.cS[y].toExponential(2)}  cZ ${geo.cZ[y].toExponential(2)}`)
}

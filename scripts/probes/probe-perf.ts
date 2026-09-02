import { Grid } from "../src/core/grid"
import { FieldStore } from "../src/core/fields"
import { generateTerrain, DEFAULT_TERRAIN } from "../src/worldgen/terrain"
import { Climate, M1_FIELDS } from "../src/sim/climate"
import { EARTH_PARAMS, earthGlobals } from "../src/sim/state"

console.log("             cold solve            | warm (無変化)  | CO2 +20ppm     | CO2 x2")
for (const [W, H] of [[128, 64], [256, 128], [512, 256]] as const) {
  const grid = new Grid(W, H)
  const store = new FieldStore(grid, M1_FIELDS, { shared: false })
  generateTerrain(grid, store, "hadean-01", DEFAULT_TERRAIN)
  const clim = new Climate(grid)
  const g = earthGlobals()
  const opt = { dtYears: null, cgTol: 1e-2 } as const
  store.f32("temperature").read.fill(15)
  store.f32("albedo").read.fill(0.3)
  let t0 = performance.now()
  const s = Climate.solveNested(grid, store, EARTH_PARAMS, g, opt,
    (gr) => new FieldStore(gr, M1_FIELDS, { shared: false }))
  const cold = performance.now() - t0
  t0 = performance.now()
  const s2 = clim.solve(store, EARTH_PARAMS, g, opt)
  const warm = performance.now() - t0
  t0 = performance.now()
  const s3 = clim.solve(store, EARTH_PARAMS, { ...g, co2: 300 }, opt)
  const nudge = performance.now() - t0
  t0 = performance.now()
  const s4 = clim.solve(store, EARTH_PARAMS, { ...g, co2: 560 }, opt)
  const dbl = performance.now() - t0
  console.log(
    `${String(W).padStart(4)}x${String(H).padEnd(4)} ${cold.toFixed(0).padStart(5)}ms (N${String(s.iterations).padStart(3)} cg${String(s.cgIterations).padStart(5)}) | ` +
    `${warm.toFixed(1).padStart(6)}ms (N${s2.iterations} cg${String(s2.cgIterations).padStart(3)}) | ` +
    `${nudge.toFixed(1).padStart(6)}ms (N${s3.iterations} cg${String(s3.cgIterations).padStart(4)}) | ` +
    `${dbl.toFixed(1).padStart(6)}ms (N${s4.iterations} cg${String(s4.cgIterations).padStart(4)})  mean ${s.meanT.toFixed(3)}`,
  )
}

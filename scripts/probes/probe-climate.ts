import { Grid } from "../src/core/grid"
import { FieldStore } from "../src/core/fields"
import { generateTerrain, DEFAULT_TERRAIN } from "../src/worldgen/terrain"
import { Climate, M1_FIELDS } from "../src/sim/climate"
import { EARTH_PARAMS, earthGlobals } from "../src/sim/state"

const W = 256, H = 128
const grid = new Grid(W, H)
const store = new FieldStore(grid, M1_FIELDS, { shared: false })
generateTerrain(grid, store, "hadean-01", DEFAULT_TERRAIN)
store.f32("temperature").read.fill(15)
store.f32("albedo").read.fill(0.3)

const clim = new Climate(grid)
const g = earthGlobals()

for (const [label, sweeps, maxOuter] of [["sweeps=1", 1, 800], ["sweeps=2", 2, 800], ["sweeps=4", 4, 800]] as const) {
  store.f32("temperature").read.fill(15)
  store.f32("albedo").read.fill(0.3)
  const t0 = performance.now()
  const s = clim.solve(store, EARTH_PARAMS, g, { dtYears: null, innerSweeps: sweeps, maxOuter })
  const ms = performance.now() - t0
  console.log(
    `${label.padEnd(10)} iter ${String(s.iterations).padStart(4)} conv ${s.converged ? "yes" : "NO "} ` +
    `${ms.toFixed(0).padStart(5)}ms | mean ${s.meanT.toFixed(2).padStart(7)} ` +
    `min ${s.minT.toFixed(1).padStart(7)} max ${s.maxT.toFixed(1).padStart(6)} ` +
    `ice ${s.iceFraction.toFixed(3)} alb ${s.planetaryAlbedo.toFixed(3)} ` +
    `imbal ${s.imbalance.toFixed(4)}`,
  )
}

const zm = clim.zonalMean(store)
console.log("\n帯状平均気温:")
for (const lat of [88, 60, 30, 10, 0, -30, -60, -88]) {
  let best = 0
  for (let y = 0; y < H; y++) if (Math.abs(grid.latDeg[y] - lat) < Math.abs(grid.latDeg[best] - lat)) best = y
  console.log(`  lat ${String(lat).padStart(4)}°: ${zm[best].toFixed(1).padStart(7)} degC`)
}
console.log(`  陸地面積比 ${grid.areaFractionWhere(store.f32("elevation").read, v => v >= 0).toFixed(3)}`)

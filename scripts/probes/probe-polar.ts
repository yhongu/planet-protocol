import { Grid } from "../src/core/grid"
import { FieldStore } from "../src/core/fields"
import { generateTerrain, DEFAULT_TERRAIN } from "../src/worldgen/terrain"
import { Climate, M1_FIELDS } from "../src/sim/climate"
import { EARTH_PARAMS, earthGlobals } from "../src/sim/state"

const W = 256, H = 128
const grid = new Grid(W, H)
const store = new FieldStore(grid, M1_FIELDS, { shared: false })
generateTerrain(grid, store, "hadean-01", DEFAULT_TERRAIN)
const g = earthGlobals()
const row = (lat: number) => { let b = 0; for (let y = 0; y < H; y++) if (Math.abs(grid.latDeg[y]-lat) < Math.abs(grid.latDeg[b]-lat)) b = y; return b }
const rEq = row(0), r30 = row(30), r60 = row(60), r80 = row(80), rPole = 0

console.log("cap   iter conv    ms | mean     eq    30N    60N    80N   pole   ice   alb   imbal")
for (const cap of [2, 4, 8, 16, 32, 64, 200]) {
  const clim = new Climate(grid, cap)
  store.f32("temperature").read.fill(15)
  store.f32("albedo").read.fill(0.3)
  const t0 = performance.now()
  const s = clim.solve(store, EARTH_PARAMS, g, { dtYears: null, maxOuter: 600, innerSweeps: 1, tol: 1e-5 })
  const ms = performance.now() - t0
  const zm = clim.zonalMean(store)
  console.log(
    `${String(cap).padStart(3)} ${String(s.iterations).padStart(6)} ${s.converged?"yes":"NO "} ${ms.toFixed(0).padStart(5)} | ` +
    `${s.meanT.toFixed(2).padStart(6)} ${zm[rEq].toFixed(1).padStart(6)} ${zm[r30].toFixed(1).padStart(6)} ` +
    `${zm[r60].toFixed(1).padStart(6)} ${zm[r80].toFixed(1).padStart(6)} ${zm[rPole].toFixed(1).padStart(6)} ` +
    `${s.iceFraction.toFixed(3)} ${s.planetaryAlbedo.toFixed(3)} ${s.imbalance.toFixed(4).padStart(8)}`,
  )
}

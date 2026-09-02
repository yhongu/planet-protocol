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
const T = store.f32("temperature").read
const TEMPERATE = new Float32Array(grid.cellCount)
for (let y = 0; y < H; y++) { const sl = grid.sinLat[y]
  for (let x = 0; x < W; x++) TEMPERATE[y * W + x] = 28 - 50 * sl * sl }
const OPT = { dtYears: null, cgTol: 1e-2, maxOuter: 400, tol: 1e-5 } as const

console.log(" B      A0    | 280ppm: mean conv N  ice clamp | 560ppm: mean conv N  ice clamp | ECS")
for (const [B, A0] of [[2.86, 199.57], [2.70, 201.2], [2.60, 202.3], [2.49, 203.16], [2.40, 204.0], [2.22, 205.8]] as const) {
  const p = { ...EARTH_PARAMS, B, A0 }
  T.set(TEMPERATE)
  const s1 = clim.solve(store, p, { ...earthGlobals(), co2: 280 }, OPT)
  const base = T.slice()
  const s2 = clim.solve(store, p, { ...earthGlobals(), co2: 560 }, OPT)
  console.log(
    `${B.toFixed(2)} ${A0.toFixed(2).padStart(7)} | ${s1.meanT.toFixed(2).padStart(7)} ${s1.converged?"yes":"NO "} ${String(s1.iterations).padStart(3)} ${s1.iceFraction.toFixed(3)} ${String(s1.clampedCells).padStart(5)} ` +
    `| ${s2.meanT.toFixed(2).padStart(7)} ${s2.converged?"yes":"NO "} ${String(s2.iterations).padStart(3)} ${s2.iceFraction.toFixed(3)} ${String(s2.clampedCells).padStart(5)} ` +
    `| ${(s2.meanT - s1.meanT).toFixed(3)}`,
  )
}

/**
 * M1 / M1.5 の合格条件の検証（docs/05-roadmap.md）。
 * proto/experiments.py の 2 次元版。
 *
 *   npx vite-node scripts/validate-m1.ts
 */
import { Grid } from "../src/core/grid"
import { FieldStore } from "../src/core/fields"
import { generateTerrain, DEFAULT_TERRAIN } from "../src/worldgen/terrain"
import { Climate, M1_FIELDS } from "../src/sim/climate"
import { EARTH_PARAMS, earthGlobals } from "../src/sim/state"

const W = Number(process.env.VAL_W ?? 128)
const H = Number(process.env.VAL_H ?? 64)
const grid = new Grid(W, H)
const store = new FieldStore(grid, M1_FIELDS, { shared: false })
generateTerrain(grid, store, "hadean-01", DEFAULT_TERRAIN)
const clim = new Climate(grid)
const T = store.f32("temperature").read
const OPT = { dtYears: null, cgTol: 1e-2, maxOuter: 300, tol: 1e-5 } as const

const TEMPERATE = new Float32Array(grid.cellCount)
const FROZEN = new Float32Array(grid.cellCount)
for (let y = 0; y < H; y++) { const sl = grid.sinLat[y]
  for (let x = 0; x < W; x++) { TEMPERATE[y * W + x] = 28 - 50 * sl * sl; FROZEN[y * W + x] = -45 } }

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail: string) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + " :: " + detail)
  ok ? pass++ : fail++
}
const solve = (co2: number, init?: Float32Array, S0 = 1361, ch4 = 0.7) => {
  if (init) T.set(init)
  return clim.solve(store, EARTH_PARAMS, { ...earthGlobals(), co2, ch4, solarConstant: S0 }, OPT)
}
const rowAt = (lat: number) => { let b = 0; for (let y = 0; y < H; y++) if (Math.abs(grid.latDeg[y]-lat) < Math.abs(grid.latDeg[b]-lat)) b = y; return b }

// --- T1 現在の地球 ---
console.log(`\n[T1] 現在の地球の平衡 (${W}x${H})`)
const base = solve(280, TEMPERATE)
const zm = clim.zonalMean(store)
const baseT = T.slice()
check("T1a 全球平均 13-17C", base.meanT >= 13 && base.meanT <= 17, `${base.meanT.toFixed(2)} C`)
check("T1b 赤道 24-30C", zm[rowAt(0)] >= 24 && zm[rowAt(0)] <= 30, `${zm[rowAt(0)].toFixed(1)} C`)
check("T1c 極 -30..-15C", zm[rowAt(-89)] >= -30 && zm[rowAt(-89)] <= -15, `${zm[rowAt(-89)].toFixed(1)} C`)
check("T1d 氷被覆率 0.05-0.18", base.iceFraction >= 0.05 && base.iceFraction <= 0.18, `${base.iceFraction.toFixed(3)} (現実 ~0.11)`)
check("T1e 惑星アルベド 0.27-0.34", base.planetaryAlbedo >= 0.27 && base.planetaryAlbedo <= 0.34, `${base.planetaryAlbedo.toFixed(3)} (現実 0.29)`)
check("T1f 収支が閉じている", Math.abs(base.imbalance) < 1e-3, `不平衡 ${base.imbalance.toExponential(1)} W/m2`)
check("T1g 南北傾度が単調", (() => { let ok = true
  for (let y = rowAt(0); y < H - 1; y++) if (zm[y + 1] > zm[y] + 0.5) ok = false
  return ok })(), "赤道から南極まで単調に低下")

// --- T2 気候感度 ---
console.log("\n[T2] 気候感度")
const c2 = solve(560, baseT), m2 = c2.meanT
const t2 = T.slice()
const c4 = solve(1120, t2), m4 = c4.meanT
const ecs = m2 - base.meanT
check("T2a ECS(2xCO2) 2.5-4.0C", ecs >= 2.5 && ecs <= 4.0, `${ecs.toFixed(2)} C (IPCC AR6: 3.0)`)
check("T2b 氷が減ると感度が下がる", m4 - m2 < ecs, `1回目 ${ecs.toFixed(2)} -> 2回目 ${(m4 - m2).toFixed(2)} C/doubling`)

// --- T3 分岐とヒステリシス ---
console.log("\n[T3] 太陽定数の分岐とヒステリシス")
let Sfall: number | null = null, Sesc: number | null = null, Srun: number | null = null
{
  T.set(baseT)
  for (let r = 1.0; r >= 0.70; r -= 0.01) {
    const s = clim.solve(store, EARTH_PARAMS, { ...earthGlobals(), solarConstant: 1361 * r }, OPT)
    if (s.iceFraction > 0.95) { Sfall = r; break }
  }
  T.set(FROZEN)
  for (let r = 0.75; r <= 1.60; r += 0.01) {
    const s = clim.solve(store, EARTH_PARAMS, { ...earthGlobals(), solarConstant: 1361 * r }, OPT)
    if (s.iceFraction < 0.05) { Sesc = r; break }
  }
  T.set(baseT)
  for (let r = 1.0; r <= 1.40; r += 0.01) {
    const s = clim.solve(store, EARTH_PARAMS, { ...earthGlobals(), solarConstant: 1361 * r }, OPT)
    if (s.meanT > 60 || s.clampedCells > 0) { Srun = r; break }
  }
}
check("T3a スノーボール分岐が存在する", Sfall !== null, Sfall ? `S/S0 = ${Sfall.toFixed(2)} で全球凍結 (1D: 0.854)` : "未検出")
check("T3b ヒステリシスが存在する", Sfall !== null && Sesc !== null && Sesc > Sfall + 0.02,
  Sfall && Sesc ? `落下 ${Sfall.toFixed(2)} -> 脱出 ${Sesc.toFixed(2)} (幅 ${(Sesc - Sfall).toFixed(2)})` : "未検出")
check("T3c 暴走温室が存在する", Srun !== null, Srun ? `S/S0 = ${Srun.toFixed(2)} (1D: 1.082、文献 ~1.1)` : "未検出")
check("T3d 現在の地球が両側の分岐から離れている",
  Sfall !== null && Srun !== null && Sfall < 0.97 && Srun > 1.03,
  Sfall && Srun ? `凍結 ${Sfall.toFixed(2)} <- 現在 1.00 -> 暴走 ${Srun.toFixed(2)}` : "-")

// --- T4 有機ヘイズの反温室効果 (M1.5) ---
console.log("\n[T4] 有機ヘイズの反温室効果")
{
  const S = 1361 * 0.78, co2 = 20000
  let peak = -Infinity, peakCh4 = 0, last = 0
  T.set(TEMPERATE)
  for (const ch4 of [1, 10, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800]) {
    const s = clim.solve(store, EARTH_PARAMS, { ...earthGlobals(), co2, ch4, solarConstant: S }, OPT)
    if (s.meanT > peak) { peak = s.meanT; peakCh4 = ch4 }
    last = s.meanT
  }
  check("T4a CH4 を増やすと昇温が反転する", peak - last > 1.0,
    `ピーク ${peak.toFixed(1)}C @ CH4=${peakCh4}ppm -> 最終 ${last.toFixed(1)}C (低下 ${(peak - last).toFixed(1)}C)`)
}

console.log(`\n${"=".repeat(64)}\n合格 ${pass} / ${pass + fail}\n${"=".repeat(64)}`)

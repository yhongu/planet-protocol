/**
 * 2 次元 EBM の較正。
 *
 *   npx vite-node scripts/calibrate2d.ts
 *
 * proto/calibrate.py の 1 次元較正を 2 次元でやり直す。
 * 2 次元で新たに入るのは陸海コントラスト（アルベドと熱容量が陸と海で違う）。
 *
 * 拘束は 1 次元と同じ 4 点【同時】:
 *   全球平均 14.5degC / 南北傾度 / 氷被覆率 ~0.11 / ECS 3.0degC
 * 1 つずつ合わせると必ず他が壊れる（proto/RESULTS.md 7 節）。
 *
 * A0 が全球平均を、B が気候感度を主に決めるので、この 2 つを入れ子の割線法で解く。
 */
import { Grid } from "../src/core/grid"
import { FieldStore } from "../src/core/fields"
import { generateTerrain, DEFAULT_TERRAIN } from "../src/worldgen/terrain"
import { Climate, M1_FIELDS, type ClimateStats } from "../src/sim/climate"
import { EARTH_PARAMS, earthGlobals, type PlanetParams } from "../src/sim/state"

const W = Number(process.env.CAL_W ?? 128)
const H = Number(process.env.CAL_H ?? 64)
const TARGET_MEAN = 14.5
const TARGET_ECS = 3.0
const OPT = { dtYears: null, cgTol: 1e-2, maxOuter: 200, tol: 1e-5 } as const

const grid = new Grid(W, H)
const store = new FieldStore(grid, M1_FIELDS, { shared: false })
generateTerrain(grid, store, "hadean-01", DEFAULT_TERRAIN)
const clim = new Climate(grid)
const T = store.f32("temperature").read

/**
 * 温帯の初期プロファイル。
 *
 * 較正の解探索は【必ずここから】始める。
 * 前回の解をキャッシュして使い回すと、探索の途中で一度スノーボールに落ちたとき、
 * ヒステリシス（docs/01-3.7）によって以降すべての解が凍結分枝に張り付く。
 * これは物理的には正しい挙動だが、較正には使えない。
 */
const TEMPERATE = new Float32Array(grid.cellCount)
for (let y = 0; y < H; y++) {
  const sl = grid.sinLat[y]
  for (let x = 0; x < W; x++) TEMPERATE[y * W + x] = 28 - 50 * sl * sl
}

function solveAt(p: PlanetParams, co2: number, init?: Float32Array): ClimateStats {
  T.set(init ?? TEMPERATE)
  return clim.solve(store, p, { ...earthGlobals(), co2 }, OPT)
}

function meanAt(p: PlanetParams): number {
  return solveAt(p, 280).meanT
}

/**
 * A0 について減衰不動点反復。
 *
 * 二分法は使えない。全球平均は A0 に対して【不連続】だから
 * （スノーボール分岐でジャンプする）。不連続関数に二分法をかけると
 * 目標値ではなく不連続点に収束する。実際にこれで mean=13.27 に落ちた。
 *
 * 平均は A0 に対してほぼ線形（dT/dA0 = -1/lambda）なので、
 * lambda を仮定した不動点反復が安定かつ高速。
 */
function calA0(B: number, guess: number): number {
  let A0 = guess
  const lambdaGuess = 1.3
  for (let i = 0; i < 25; i++) {
    const m = meanAt({ ...EARTH_PARAMS, B, A0 })
    const err = m - TARGET_MEAN
    if (Math.abs(err) < 5e-4) break
    A0 += lambdaGuess * Math.max(-25, Math.min(25, err))
  }
  return A0
}

function ecsAt(B: number, A0: number): number {
  const p = { ...EARTH_PARAMS, B, A0 }
  const s1 = solveAt(p, 280)
  if (!s1.converged) return NaN
  const base = T.slice()
  const s2 = solveAt(p, 560, base)
  return s2.converged ? s2.meanT - s1.meanT : NaN
}

console.log(`格子 ${W}x${H} で較正`)
// ECS は B に対して概ね反比例。B について減衰不動点反復。
let B = EARTH_PARAMS.B
let A0 = EARTH_PARAMS.A0
for (let i = 0; i < 14; i++) {
  A0 = calA0(B, A0)
  const e = ecsAt(B, A0)
  console.log(`  反復${String(i).padStart(2)}  B=${B.toFixed(4)}  A0=${A0.toFixed(4)}  ECS=${Number.isFinite(e) ? e.toFixed(4) : "発散"}`)
  if (!Number.isFinite(e)) { B *= 1.15; continue }
  if (Math.abs(e - TARGET_ECS) < 3e-3) break
  // ECS ~ k/B なので B <- B * (ECS/target)。振動を防ぐため半分だけ動かす。
  B *= 1 + 0.5 * (e / TARGET_ECS - 1)
  B = Math.max(1.0, Math.min(5, B))
}

// --- 最終診断 ---
const p = { ...EARTH_PARAMS, B, A0 }
const s = solveAt(p, 280)
const zm = clim.zonalMean(store)
const rowAt = (lat: number) => { let b = 0; for (let y = 0; y < H; y++) if (Math.abs(grid.latDeg[y]-lat) < Math.abs(grid.latDeg[b]-lat)) b = y; return b }
const base = T.slice()
const ecs = solveAt(p, 560, base).meanT - s.meanT
T.set(base)
solveAt(p, 280, base)

console.log(`\n=== 較正結果 (${W}x${H}) ===`)
console.log(`A0      = ${A0.toFixed(5)}`)
console.log(`B       = ${B.toFixed(5)}`)
console.log()
const line = (label: string, v: string, target: string) =>
  console.log(`${label.padEnd(16)}${v.padStart(9)}   ${target}`)
line("全球平均", `${s.meanT.toFixed(2)} C`, "(目標 13-17)")
line("赤道", `${zm[rowAt(0)].toFixed(1)} C`, "(目標 ~27)")
line("緯度30", `${zm[rowAt(30)].toFixed(1)} C`, "")
line("緯度60", `${zm[rowAt(60)].toFixed(1)} C`, "")
line("極", `${zm[rowAt(-89)].toFixed(1)} C`, "(目標 ~-25)")
line("氷被覆率", s.iceFraction.toFixed(3), "(現実 ~0.11)")
line("陸地面積比", s.landFraction.toFixed(3), "(0.29)")
line("惑星アルベド", s.planetaryAlbedo.toFixed(3), "(現実 0.29)")
line("ECS (2xCO2)", `${ecs.toFixed(2)} C`, "(IPCC AR6: 3.0, 2.5-4.0)")
line("収支の不平衡", s.imbalance.toExponential(1), "(平衡なら ~0)")

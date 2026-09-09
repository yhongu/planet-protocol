/**
 * ★**介入で知性を生ませられるか**を測る（ユーザの問い・2026-09-09）。
 *
 * 知性（`capSymbolic`）の前提は 3 つ:
 *   大気の酸素 8% 以上 ／ 脳の遺伝子 ≥ 64 ／ 多細胞
 * 神の手にあるのは「埋没（`recalcitrance`）」「脳」「光合成」「好気呼吸」。
 * ★埋没を押すと酸素が上がる（実測: 乏しい惑星 7.7% → 26.5%）。
 */
import { World, PLANET_AGE_YEARS } from "/home/peko/Nilklops/gaia-protocol/src/sim/world"
import { GENE_KINDS, hasCapability } from "/home/peko/Nilklops/gaia-protocol/src/sim/genome"
const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1]! : d
}
const SEED = arg("seed", "g01")
const MODE = arg("mode", "both")   // none / o2 / brain / both
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const T_RECAL = GENE_KINDS.indexOf("recalcitrance")
const T_BRAIN = GENE_KINDS.indexOf("brain")
const C_SYM = GENE_KINDS.indexOf("capSymbolic")
const C_MULTI = GENE_KINDS.indexOf("capMulticellular")
const w = new World({ width: 64, height: 32, seed: SEED, shared: false,
  startEpoch: "hadean", climateCouplingYears: 200_000 })

/** いちばん生命の多いセル（★添字順に最大。決定論） */
function richest(): number {
  const tot = w.store.f32("biomassTotal").read
  let best = -1, bv = 0
  for (let i = 0; i < w.grid.cellCount; i++) if (tot[i]! > bv) { bv = tot[i]!; best = i }
  return best
}
let pushO2 = 0, pushBrain = 0, next = 2e7
while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
  w.advance(400_000, OPT)
  if (w.globals.yearsElapsed < next) continue
  next += 2e7
  const c = richest()
  if (c < 0) continue
  // ★酸素が門（8%）に足りなければ埋没を押す
  if ((MODE === "o2" || MODE === "both") && w.globals.o2 < 12) {
    w.intervene("nudgeTrait", 1, c, T_RECAL); pushO2++
  }
  // ★多細胞の系統がいるセルで脳を押す（前提の 2 つ目）
  if (MODE === "brain" || MODE === "both") {
    const multi = w.life.clades.some((cl) => hasCapability(cl.phenotype, C_MULTI))
    if (multi) { w.intervene("nudgeTrait", 1, c, T_BRAIN); pushBrain++ }
  }
}
const y = w.life.firstSeen.get(C_SYM)
console.log(`seed ${SEED}  介入 ${MODE}  埋没 ${pushO2} 回 / 脳 ${pushBrain} 回`
  + `  → ★知性 ${y === undefined ? "生まれず" : ((PLANET_AGE_YEARS - y) / 1e9).toFixed(2) + " Ga"}`
  + `  O2 ${w.globals.o2.toFixed(1)}%  文明 ${w.civ.state.civs.length}`
  + `  人口 ${w.civ.state.totalPopulation.toExponential(2)}`)

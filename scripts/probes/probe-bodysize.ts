/**
 * **`bodySize` が全史で消える理由を追う。**
 *
 * 顕生代の章での採算は **+4.1%** なのに、全史 4 seed の終端では
 * **平均 0.000・SD 0.000**（2026-09-05 実測）。どこで消えるかを時代で追う。
 *
 * ★仮説を書かずに、**数える**:
 *   - `bodySize` を持つ系統の数と最大値
 *   - **捕食者の数**（防御の見返りは捕食者がいて初めて生まれる）
 *   - 遺伝子として存在するか（形質値 0 は「遺伝子が無い」かもしれない）
 *
 * ★設定は `probe-traits.ts` と同じ（罠 20）。★カナリアに日射（罠 13）。
 *
 *   npx vite-node scripts/probes/probe-bodysize.ts --seed g02
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"
import { GENE_KINDS, hasCapability } from "../../src/sim/genome"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1]! : d
}
const W = Number(arg("width", "64")), H = W >> 1
const SEED = arg("seed", "g02")
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const T_BODY = GENE_KINDS.indexOf("bodySize")
const C_PRED = GENE_KINDS.indexOf("capPredation")

const w = new World({
  width: W, height: H, seed: SEED, shared: false, startEpoch: "hadean",
  climateCouplingYears: 200_000,
})
console.log(`bodySize の追跡  ${W}x${H}  seed ${SEED}`)
console.log("Ga    系統  持つ  最大値  遺伝子を持つ  捕食者  日射")

let next = PLANET_AGE_YEARS - 3.5e9
while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
  w.advance(400_000, OPT)
  if (w.globals.yearsElapsed < next) continue
  next += 0.25e9
  const cl = w.life.clades
  const has = cl.filter((c) => (c.phenotype.traits[T_BODY] ?? 0) > 0.01)
  const max = cl.length ? Math.max(...cl.map((c) => c.phenotype.traits[T_BODY] ?? 0)) : 0
  // ★形質値 0 でも遺伝子は在るかもしれない。**両方数える**
  let withGene = 0
  for (const c of cl) {
    for (let i = 0; i < c.genome.length; i++) {
      if (c.genome.kind[i] === T_BODY) { withGene++; break }
    }
  }
  const pred = cl.filter((c) => hasCapability(c.phenotype, C_PRED)).length
  console.log(
    `${((PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9).toFixed(2)}  `
    + `${String(cl.length).padStart(2)}    ${String(has.length).padStart(2)}   `
    + `${max.toFixed(2)}    ${String(withGene).padStart(2)}          `
    + `${String(pred).padStart(2)}    `
    + `${(w.globals.solarConstant * w.globals.solarMultiplier).toFixed(0)}`)
}

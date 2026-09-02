/**
 * 系統樹の見た目を確かめるためのデータを吐く。
 *
 * ★**smoke は冥王代までしか進まない**ので、生命がいる状態の系譜タブを
 * 一度も目で見られていなかった。全史を回して `public/phylo.json` に落とし、
 * `phylo-test.html` で本物の `Phylogeny` に食わせて撮る。
 *
 *   npx vite-node scripts/probes/probe-phylo.ts [--seed gaia-6] [--gyr 3.5]
 */
import { writeFileSync } from "node:fs"
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const SEED = arg("seed", "gaia-6")
const UNTIL = Number(arg("gyr", "4.54")) * 1e9
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

const w = new World({
  width: 64, height: 32, seed: SEED, shared: false,
  startEpoch: "hadean", climateCouplingYears: 200_000,
})
while (w.globals.yearsElapsed < Math.min(UNTIL, PLANET_AGE_YEARS)) w.advance(400_000, OPT)

// `simWorker.ts` の requestPhylogeny と同じ形にすること（組み直さない）
const nodes = w.life.history.map((c) => {
  const g = c.genome
  const genes: { kind: number; value: number; origin: number }[] = []
  for (let i = 0; i < g.length; i++) {
    genes.push({ kind: g.kind[i], value: g.value[i], origin: g.origin[i] })
  }
  return {
    id: c.id, parent: c.parent, bornYear: c.bornYear, extinctYear: c.extinctYear,
    capabilities: c.phenotype.capabilities, traits: Array.from(c.phenotype.traits),
    genes, biomass: c.biomass, bodyPlan: Array.from(c.bodyPlan),
  }
})
writeFileSync("public/phylo.json", JSON.stringify({
  nodes, originYear: w.prebiotic.state.originYear,
  originSite: w.prebiotic.state.originSite ?? "",
}))
console.log(`系統樹のデータ  seed ${SEED}  ${(w.globals.yearsElapsed / 1e9).toFixed(2)}Gyr  ` +
  `全 ${nodes.length} 系統（生存 ${nodes.filter((n) => n.extinctYear < 0).length}）` +
  ` -> public/phylo.json`)

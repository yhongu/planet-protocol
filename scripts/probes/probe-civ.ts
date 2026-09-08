/**
 * **文明が動くかを見る**（M6 の実装 ②③ の確認。2026-09-08）。
 *
 * ★配っている章（顕生代・31 系統）から回す。全史を待たなくてよい。
 * ★**知性が出ていない惑星では何も起きないのが正しい** ——
 * 「動かない」を「壊れている」と読まないために、知性種の数を隣に出す（罠 110）。
 *
 *   npx vite-node scripts/probes/probe-civ.ts [--gyr 0.5] [--enabled 1]
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { loadWorld } from "../../src/sim/snapshot"
import { GENE_KINDS, hasCapability } from "../../src/sim/genome"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1]! : d
}
const GYR = Number(arg("gyr", "0.5"))
const ENABLED = Number(arg("enabled", "1"))
const STEP = Number(arg("step", "1e6"))
const CH = arg("chapter", "phanerozoic")
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const C_SYMBOLIC = GENE_KINDS.indexOf("capSymbolic")

const w = loadWorld(new Uint8Array(gunzipSync(
  readFileSync(`public/chapters/${CH}.gaia`))))
w.civ.params.enabled = ENABLED
// ★知性種がいない章では何も起きない。**押して確かめる**ために、
//   いちばん豊かなセルの優占クレードに象徴の遺伝子を投入する（神の手）
if (arg("seedIntelligence", "1") === "1") {
  const tot = w.store.f32("biomassTotal").read
  let best = -1, bv = 0
  for (let i = 0; i < w.grid.cellCount; i++) if (tot[i]! > bv) { bv = tot[i]!; best = i }
  if (best >= 0) w.intervene("injectGene", 1, best, C_SYMBOLIC)
}

const smart = () => w.life.clades.filter((c) => hasCapability(c.phenotype, C_SYMBOLIC)).length
console.log(`文明  章 ${CH}  ${(w.globals.yearsElapsed / 1e9).toFixed(2)}Gyr から `
  + `${GYR}Gyr  刻み ${(STEP / 1e6).toFixed(2)}Myr  enabled ${ENABLED}`)
console.log("経過[Myr]  知性種  人口          土地利用%  1人あたりW  CO2    生物圏")

const end = w.globals.yearsElapsed + GYR * 1e9
let next = w.globals.yearsElapsed
const report = () => {
  const use = w.store.f32("landUse").read
  const lf = w.store.f32("landFraction").read
  let u = 0, land = 0
  for (let y = 0; y < w.grid.H; y++) {
    const a = w.grid.areaWeight[y]!
    for (let x = 0; x < w.grid.W; x++) {
      const i = y * w.grid.W + x
      const f = lf[i] ?? 0
      u += (use[i] ?? 0) * f * a; land += f * a
    }
  }
  console.log(
    `${((w.globals.yearsElapsed - (end - GYR * 1e9)) / 1e6).toFixed(0).padStart(8)}  `
    + `${String(smart()).padStart(6)}  ${w.civ.state.totalPopulation.toExponential(3)}  `
    + `${(land > 0 ? 100 * u / land : 0).toFixed(2).padStart(8)}  `
    + `${w.civ.state.energyPerCapita.toFixed(0).padStart(9)}  `
    + `${w.globals.co2.toFixed(0).padStart(5)}  ${w.globals.biosphereProxy.toFixed(2)}`)
}
report()
while (w.globals.yearsElapsed < end) {
  w.advance(STEP, OPT)
  if (w.globals.yearsElapsed >= next) { report(); next += GYR * 1e9 / 10 }
}
console.log(`終端  人口 ${w.civ.state.totalPopulation.toExponential(3)} 人`
  + `  知性の誕生 ${w.civ.state.emergedYear < 0 ? "まだ"
    : ((w.civ.state.emergedYear) / 1e6).toFixed(0) + "Myr"}`)

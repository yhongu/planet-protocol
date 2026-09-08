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
import { TECHS } from "../../src/sim/tech"

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
console.log("経過[Myr] 知性種 文明  人口         土地%  1人W    CO2   技術（発明/失伝）")

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
    `${((w.globals.yearsElapsed - (end - GYR * 1e9)) / 1e6).toFixed(0).padStart(8)} `
    + `${String(smart()).padStart(5)} ${String(w.civ.state.civs.length).padStart(4)}  `
    + `${w.civ.state.totalPopulation.toExponential(3)}  `
    + `${(land > 0 ? 100 * u / land : 0).toFixed(1).padStart(5)}  `
    + `${w.civ.state.energyPerCapita.toFixed(0).padStart(6)}  `
    + `${w.globals.co2.toFixed(0).padStart(5)}  `
    // ★**文明ごとに技術を出す**（どこが違う道を通ったかを見る）
    + w.civ.state.civs.map((c) =>
      `#${c.id}[${TECHS.filter((_, i) => c.tech[i]).length}]`).join(" ")
    + ` 発明${w.civ.state.invented}/失伝${w.civ.state.lost}`
    + `/伝播${w.civ.state.transferred}/征服${w.civ.state.conquered}`)
}
report()
while (w.globals.yearsElapsed < end) {
  w.advance(STEP, OPT)
  if (w.globals.yearsElapsed >= next) { report(); next += GYR * 1e9 / 10 }
}
// ★**文明ごとの技術の中身**。同じ役割を別の技術で満たしているかを見る
for (const c of w.civ.state.civs) {
  console.log(`  文明 #${c.id}  人口 ${c.population.toExponential(2)}`
    + `（最盛 ${c.peakPopulation.toExponential(2)} = ${(100 * c.population / c.peakPopulation).toFixed(0)}%）`
    + `  失伝 ${c.lostCount}  1人 ${c.energyPerCapita.toFixed(0)}W  `
    + TECHS.filter((_, i) => c.tech[i]).map((t) => t.what).join(""))
}
// ★★**同じ技術を、独立に発明したのか伝わったのか**（由来 id で分かる）
{
  const civs = w.civ.state.civs
  const rows: string[] = []
  for (let t = 0; t < TECHS.length; t++) {
    const holders = civs.filter((c) => c.tech[t])
    if (holders.length < 2) continue
    const origins = new Set(holders.map((c) => c.techOrigin[t]))
    rows.push(`  ${TECHS[t]!.what.padEnd(6)} ${holders.length} 文明が保有`
      + `  由来 ${origins.size} 種類`
      + (origins.size === 1 ? "  ← ★伝播（同じ由来）" : "  ← 独立発明が混在"))
  }
  if (rows.length > 0) {
    console.log("\n★技術の由来（同じ技術を持つ文明が 2 つ以上あるもの）")
    console.log(rows.slice(0, 12).join("\n"))
  }
}
console.log(`終端  人口 ${w.civ.state.totalPopulation.toExponential(3)} 人`
  + `  知性の誕生 ${w.civ.state.emergedYear < 0 ? "まだ"
    : ((w.civ.state.emergedYear) / 1e6).toFixed(0) + "Myr"}`)

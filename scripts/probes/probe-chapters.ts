/**
 * **章に何がいるか**を数える（数秒）。★計器の前提を確かめるため（罠 85）。
 *
 * `probe-margin.ts` は配っている章で測るので、**章にいない役者の効果は
 * 必ず 0.0% と出る**。「効いていない」と読む前にここを見ること。
 *
 *   npx vite-node scripts/probes/probe-chapters.ts
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { loadWorld } from "../../src/sim/snapshot"
import { GENE_KINDS, hasCapability } from "../../src/sim/genome"

const CHAPTERS = ["archean", "proterozoic", "phanerozoic"] as const
const T_RECAL = GENE_KINDS.indexOf("recalcitrance")
const T_BODY = GENE_KINDS.indexOf("bodySize")
const C_PRED = GENE_KINDS.indexOf("capPredation")

console.log("章            Gyr   系統  捕食者  recal平均  recal_SD  body平均  O2%")
for (const ch of CHAPTERS) {
  const w = loadWorld(new Uint8Array(gunzipSync(
    readFileSync(`public/chapters/${ch}.gaia`))))
  const cl = w.life.clades
  const preds = cl.filter((c) => hasCapability(c.phenotype, C_PRED)).length
  const v = cl.map((c) => c.phenotype.traits[T_RECAL] ?? 0)
  const m = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0
  const sd = v.length > 1
    ? Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length) : 0
  const bodyM = cl.length
    ? cl.reduce((a, c) => a + (c.phenotype.traits[T_BODY] ?? 0), 0) / cl.length : 0
  console.log(`${ch.padEnd(13)} ${(w.globals.yearsElapsed / 1e9).toFixed(2)}  `
    + `${String(cl.length).padStart(4)}  ${String(preds).padStart(6)}  `
    + `${m.toFixed(3).padStart(8)}  ${sd.toFixed(3).padStart(8)}  `
    + `${bodyM.toFixed(3).padStart(7)}  ${w.globals.o2.toFixed(1)}`)
}

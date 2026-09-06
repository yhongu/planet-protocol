/**
 * **その形質は割に合うか**を数秒で測る（`CLAUDE.md` の 34: 輪を短くする）。
 *
 * 全史 1 本は 64x32 で 10 分、4 seed の A/B は 30 分かかる。
 * それを 2 周してから「輪が長い」と気づいた（2026-09-05）。
 * 配っている章を読めば、**同じ問いに数秒で答えられる**。
 *
 * ★**時代分解で見ること**（罠 17）。効きが時代で変わる量を 1 時点で
 * 検定すると外す。3 つの章（太古代・原生代・顕生代）で測る。
 *
 * ★**計器の限界**: `traitMargin` は `fitness()` の差だけを見る。
 * **`reach`（配分の段階）で効く見返りは見えない** —— それはつまり
 * **選択も見えていない**ということで、そこが `dispersal` の問題だった。
 *
 *   npx vite-node scripts/probes/probe-margin.ts
 *   npx vite-node scripts/probes/probe-margin.ts --set weatheringNutrient=0.5,weatheringCost=0.05
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { loadWorld } from "../../src/sim/snapshot"
import { GENE_KINDS, FIRST_CAPABILITY } from "../../src/sim/genome"
import type { World } from "../../src/sim/world"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1]! : d
}
const SET = arg("set", "")
/** 始点。★既に高い形質は「いまの値から +0.25」では飽和して 0 に見える */
const FROM = argv.includes("--from0") ? 0 : null
const CHAPTERS = ["archean", "proterozoic", "phanerozoic"] as const
const WATCH = ["weatheringBoost", "sociality", "ccnProduction", "albedoEffect",
  "dispersal", "bodySize", "brain", "recalcitrance", "nutrientP"] as const

const over: Record<string, number> = {}
for (const kv of SET.split(",").filter(Boolean)) {
  const [k, v] = kv.split("=")
  over[k!] = Number(v)
}
console.log(`形質の余白（適応度が何 % 変わるか。形質を +0.25 したとき）`)
console.log(`  設定: ${SET || "既定"}${FROM === 0 ? "  【0 から獲得する価値】" : ""}`)
console.log(`  ★「中央値/最大」。一部の系統にしか効かない形質は中央値では消える`)

const q = (a: number[], t: number) => {
  if (!a.length) return NaN
  const s = [...a].sort((u, v) => u - v)
  return s[Math.min(s.length - 1, Math.floor(t * s.length))]!
}

/** ★能力も測る。形質だけ見ていると「その能力が損になった」を見逃す */
const CAPS = ["capOxygenicPhotosynthesis", "capPredation", "capMulticellular",
  "capEukaryotic", "capLandTolerance", "capSymbolic"] as const

const header = "形質".padEnd(18) + CHAPTERS.map((c) => c.padStart(14)).join("")
const rows: string[][] = []
const worlds: World[] = []
for (const ch of CHAPTERS) {
  const w = loadWorld(new Uint8Array(gunzipSync(
    readFileSync(`public/chapters/${ch}.gaia`))))
  Object.assign(w.life.params, over)
  worlds.push(w)
}
console.log(`  クレード数: ` + worlds.map((w, i) =>
  `${CHAPTERS[i]} ${w.life.clades.length}`).join(" / "))
console.log(header)
for (const t of WATCH) {
  const idx = GENE_KINDS.indexOf(t as never)
  if (idx < 0) throw new Error(`知らない形質: ${t}`)
  const cells: string[] = []
  for (const w of worlds) {
    const m = w.life.traitMargin(w, idx, 0.25, FROM)
    // ★**中央値だけ出さない。** 一部の系統にしか効かない形質は
    //   中央値では消える（脳は捕食者にしか効かない。罠 104）
    cells.push(m.length
      ? `${(100 * q(m, 0.5)).toFixed(1)}/${(100 * q(m, 1)).toFixed(1)}%`.padStart(14)
      : "（該当なし）".padStart(14))
  }
  rows.push([t, ...cells])
  console.log(t.padEnd(18) + cells.join(""))
}
console.log("--- 能力（獲得したときの余白） ---")
for (const c of CAPS) {
  const k = GENE_KINDS.indexOf(c as never)
  if (k < 0) throw new Error(`知らない能力: ${c}`)
  const bit = 1 << (k - FIRST_CAPABILITY)
  const cells: string[] = []
  for (const w of worlds) {
    const m = w.life.capabilityMargin(w, bit)
    cells.push(m.length
      ? `${(100 * q(m, 0.5)).toFixed(1)}%`.padStart(14)
      : "（全部持つ）".padStart(14))
  }
  console.log(c.padEnd(18) + cells.join(""))
}

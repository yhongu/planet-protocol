/**
 * ★**知性の誕生から、最初の文明が建つまで何年か**（2026-09-09）。
 *
 * ★プレイして「降下したまま何秒待っても文明が 0」と報告された。
 * 降りると時計が人間の尺度になるので、**建国までの年数がそのまま待ち時間になる**。
 * ★年/秒は直書きせず `CIV_SPEED_STEPS` から引く（段を変えたら追随させる。罠 65）。
 * 憶測でなく測る（罠 16: 数字を出している行を読むのが先）。
 *
 *   npx vite-node scripts/probes/probe-founding.ts [--reals 5]
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { loadWorld } from "../../src/sim/snapshot"
import { GENE_KINDS } from "../../src/sim/genome"
import { EPOCHS, resolveSpeed } from "../../src/sim/loop"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1]! : d
}
const REALS = Number(arg("reals", "5"))
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const C_SYMBOLIC = GENE_KINDS.indexOf("capSymbolic")
/** ★降下中のいちばん速い段 [年/秒] */
const TOP = resolveSpeed(EPOCHS.find((e) => e.id === "phanerozoic")!, 20, true)

console.log("知性の誕生 → 最初の建国 → 2 つ目 の年数（★降下中の待ち時間の正体）")
console.log("実現  建国まで[Myr]  ×20 で降下中の待ち[秒]  住める陸のセル数")
const waits: number[] = []
for (let r = 0; r < REALS; r++) {
  const w = loadWorld(new Uint8Array(gunzipSync(
    readFileSync("public/chapters/phanerozoic.gaia"))))
  w.civ.params.enabled = 1
  const tot = w.store.f32("biomassTotal").read
  const order = Array.from({ length: w.grid.cellCount }, (_, i) => i)
    .sort((a, b) => (tot[b] ?? 0) - (tot[a] ?? 0))
  const best = order[r] ?? -1
  if (best >= 0) w.intervene("injectGene", 1, best, C_SYMBOLIC)
  const t0 = w.globals.yearsElapsed
  let founded = -1
  for (let k = 0; k < 200 && founded < 0; k++) {
    w.advance(1e6, OPT)
    if (w.civ.state.civs.length > 0) founded = w.globals.yearsElapsed - t0
  }
  // ★**住める陸のセル数**を隣に出す（建国の確率はこれに比例する。罠 110）
  const lf = w.store.f32("landFraction").read
  let land = 0
  for (let i = 0; i < w.grid.cellCount; i++) if ((lf[i] ?? 0) >= 0.5) land++
  const sec = founded > 0 ? founded / TOP : NaN
  if (founded > 0) waits.push(sec)
  console.log(`${String(r + 1).padStart(4)}  ${(founded / 1e6).toFixed(1).padStart(13)}`
    + `  ${sec.toFixed(0).padStart(21)}  ${String(land).padStart(16)}`)
}
waits.sort((a, b) => a - b)
const med = waits.length ? waits[(waits.length / 2) | 0]! : NaN
console.log(`\n★中央値 ${med.toFixed(0)} 秒 = ${(med / 60).toFixed(1)} 分（×20 で降下したまま待つ場合）`)
console.log(`  惑星の段（×20 = 200 万年/秒）なら ${(med * 200 / 2e6).toFixed(3)} 秒`)
console.log("★地球は解剖学的現生人類 30 万年 → 定住・農耕。桁が合っているかを見ること")

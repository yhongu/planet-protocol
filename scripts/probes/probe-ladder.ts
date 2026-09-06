/**
 * **「進化しない」を 3 つに切り分ける**（`CLAUDE.md` の 52）。
 *
 * 2026-09-06 のユーザ報告「2 億年前でもシアノバクテリアしかいない」。
 * 顕生代の採算は十分にある（真核 +77.7%・陸 +78.4%・多細胞 +34.2%、
 * `probe-margin.ts`）。**見返りが無いのではなく、獲得できていない。**
 *
 *   1. **引けていない**（`proposed` が 0）      → 抽選の設計の問題
 *   2. **引いたが採られない**（`adopted` が 0）  → 採算の問題（罠 41）
 *   3. **得たが失われる**（時系列で消える）      → 生態の問題
 *
 * ★時代ごとに「その能力を持つ系統の数」も出す。合計だけでは 3 を見逃す。
 * ★設定は `probe-traits.ts` と同じ（罠 20）。カナリアに日射（罠 13）。
 *
 *   npx vite-node scripts/probes/probe-ladder.ts --seed g02
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"
import { GENE_KINDS, FIRST_CAPABILITY, hasCapability } from "../../src/sim/genome"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1]! : d
}
const W = Number(arg("width", "64")), H = W >> 1
const SEED = arg("seed", "g02")
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

const CAPS = ["capOxygenicPhotosynthesis", "capEukaryotic", "capMulticellular",
  "capPredation", "capSkeleton", "capMotility", "capLandTolerance",
  "capNitrogenFixation", "capSymbolic"] as const
const IDX = CAPS.map((c) => {
  const i = GENE_KINDS.indexOf(c as never)
  if (i < FIRST_CAPABILITY) throw new Error(`能力ではない: ${c}`)
  return i
})
const SHORT = ["酸素光合成", "真核", "多細胞", "捕食", "骨格", "運動", "陸", "窒素固定", "象徴"]

const w = new World({
  width: W, height: H, seed: SEED, shared: false, startEpoch: "hadean",
  climateCouplingYears: 200_000,
})
console.log(`進化の梯子  ${W}x${H}  seed ${SEED}`)
console.log("Ga   系統 " + SHORT.map((s) => s.padStart(6)).join("") + "   日射")

let next = PLANET_AGE_YEARS - 3.0e9
while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
  w.advance(400_000, OPT)
  if (w.globals.yearsElapsed < next) continue
  next += 0.5e9
  const cl = w.life.clades
  // ★`hasCapability` は**ビットではなく遺伝子の種類の添字**を取る
  //   （内部で `1 << (kind - FIRST_CAPABILITY)` する）。ビットを渡して
  //   全部 0 と出た —— 採用回数と食い違ったので気づけた
  const cells = IDX.map((k) =>
    String(cl.filter((c) => hasCapability(c.phenotype, k)).length).padStart(6))
  console.log(`${((PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9).toFixed(2)} ${String(cl.length).padStart(3)} `
    + cells.join("") + `   ${(w.globals.solarConstant * w.globals.solarMultiplier).toFixed(0)}`)
}
console.log("\n★引けたか（proposed）／採られたか（adopted）")
for (let i = 0; i < CAPS.length; i++) {
  const k = IDX[i]!
  console.log(`  ${SHORT[i]!.padEnd(6)} 提案 ${String(w.life.diag.proposed[k]).padStart(5)}`
    + `  採用 ${String(w.life.diag.adopted[k]).padStart(4)}`)
}

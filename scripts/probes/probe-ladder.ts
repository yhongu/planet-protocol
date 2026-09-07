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
import { gradeOf, GRADE_LABEL, GRADES } from "../../src/ui/creatureGrade"
import { earthAnalog } from "../../src/ui/earthAnalog"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1]! : d
}
const W = Number(arg("width", "64")), H = W >> 1
const SEED = arg("seed", "g02")
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
/** ★A/B 用。既定を変えずに条件を試す（罠 39: 対照が本当に対照か） */
const SET = arg("set", "")

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
// ★**どのサブシステムのパラメータかを探して当てる。**
//   `life.params` にだけ書いていたので、酸素のつまみが**黙って無視され**、
//   2 水準の結果が 1 桁まで一致した（罠 39 で気づけた）
for (const kv of SET.split(",").filter(Boolean)) {
  const [k, v] = kv.split("=")
  const targets: Record<string, unknown>[] = [
    w.life.params as unknown as Record<string, unknown>,
    // ★変異のつまみ（`pLadder` など）は `life.mutation` にある。
    //   ここを足すまで `--set pLadder=...` は「知らないパラメータ」で落ちていた
    w.life.mutation as unknown as Record<string, unknown>,
    w.oxygen.params as unknown as Record<string, unknown>,
    w.carbon.params as unknown as Record<string, unknown>,
  ]
  const hit = targets.find((t) => k! in t)
  if (!hit) throw new Error(`知らないパラメータ: ${k}`)
  hit[k!] = Number(v)
}
console.log(`進化の梯子  ${W}x${H}  seed ${SEED}  ${SET || "既定"}`)
console.log("Ga   系統 " + SHORT.map((s) => s.padStart(6)).join("")
  + "   生物圏   O2%   日射")

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
    + cells.join("")
    // ★C の診断: **分岐はバイオマスに比例する**ので、貧しい惑星は
    //   永久に系統が増えない（`speciationRate × min(1, biomass×10)`）。
    //   O2 は B の環境の門（言語は 8% 以上でしか引けない）のカナリア
    + `   ${w.globals.biosphereProxy.toFixed(2)}  ${w.globals.o2.toFixed(1)}  `
    + `${(w.globals.solarConstant * w.globals.solarMultiplier).toFixed(0)}`)
}
// ★**初めて現れた年**（`detectFirsts` が年代記に刻むもの）。
//   「進化しない」の正体が「起きていない」のか「見えていない」のかを分ける
console.log("\n★初めて現れた年 [Ga]")
for (let i = 0; i < CAPS.length; i++) {
  const y = w.life.firstSeen.get(IDX[i]!)
  console.log(`  ${SHORT[i]!.padEnd(6)} `
    + (y === undefined ? "—（一度も現れず）"
      : `${((PLANET_AGE_YEARS - y) / 1e9).toFixed(2)} Ga`))
}
// ★**「陸上多細胞（＝陸上植物）が出ない」を切り分ける**（2026-09-07）。
//   陸の有機炭素の埋没は `capLandTolerance && capMulticellular` の系統だけが担う
//   （リグニン。微生物マットは石炭を作らない）。ところが全史 4 seed で
//   **終端の woody が 0〜3 本**しかなく、O2 が 4〜7% で止まっていた。
//   ★仮説: 前提の `aridityTolerance` は**陸でしか効かない＝ほぼ中立**なので浮動し
//   （罠 100）、「多細胞になった系統」と「乾燥耐性を持った系統」が別になる。
//   ★**系統ごとに 3 つ並べて突き合わせること**（罠 110）
{
  const T_ARID = GENE_KINDS.indexOf("aridityTolerance")
  const iLand = GENE_KINDS.indexOf("capLandTolerance")
  const iMulti = GENE_KINDS.indexOf("capMulticellular")
  let both = 0, arid = 0
  console.log("\n★終端の系統ごと（多細胞 / 陸 / 乾燥耐性 / バイオマス）")
  for (const c of w.life.clades) {
    const m = hasCapability(c.phenotype, iMulti), l = hasCapability(c.phenotype, iLand)
    const a = c.phenotype.traits[T_ARID] ?? 0
    if (m && l) both++
    if (a > 0.01) arid++
    console.log(`  #${String(c.id).padStart(3)}  ${m ? "多細胞" : "　　　"}`
      + `  ${l ? "陸" : "　"}  乾燥 ${a.toFixed(2)}  bio ${c.biomass.toFixed(3)}`)
  }
  console.log(`  → 陸上多細胞 ${both} 本 / 乾燥耐性を持つ ${arid} 本`
    + ` / 全 ${w.life.clades.length} 本`)
}
// ★**画面に出る段階の内訳。** 中身が多様でも、段階が偏れば単調に見える
console.log("\n★終端の見た目（絵の段階）")
const cnt = new Map<string, number>()
for (const c of w.life.clades) {
  const g = gradeOf(c.phenotype.capabilities, Array.from(c.phenotype.traits))
  cnt.set(g, (cnt.get(g) ?? 0) + 1)
}
for (const g of GRADES) {
  const n = cnt.get(g) ?? 0
  if (n > 0) console.log(`  ${GRADE_LABEL[g].padEnd(18)} ${n}`)
}
// ★**地球で言えば何に近いか**の内訳。魚類・爬虫類・昆虫にあたるものが
//   出ているかは、ここでしか分からない
console.log("\n★終端の地球との対応")
const an = new Map<string, number>()
for (const c of w.life.clades) {
  const a = earthAnalog(c.phenotype.capabilities, Array.from(c.phenotype.traits))
  an.set(a.name, (an.get(a.name) ?? 0) + 1)
}
for (const [k, v] of [...an.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(2)}  ${k}`)
}
console.log("\n★引けたか（proposed）／採られたか（adopted）")
for (let i = 0; i < CAPS.length; i++) {
  const k = IDX[i]!
  console.log(`  ${SHORT[i]!.padEnd(6)} 提案 ${String(w.life.diag.proposed[k]).padStart(5)}`
    + `  採用 ${String(w.life.diag.adopted[k]).padStart(4)}`)
}

/**
 * **終端の O2 が seed で 6〜26% に散る理由を、収支の項で追う**（2026-09-07）。
 *
 * `probe-o2budget.ts`（数秒）で分かったこと:
 *   - 吸い込み側は地球どおり（還元剤 2.0e12 + 酸化的風化 8.0e12 = 1.0e13）
 *   - 顕生代の章は埋没 1.05e13 で **O2 27.8%**（地球より高い）
 *   - なのに全史 4 seed の終端は 6.0 / 26.4 / 8.9 / 7.9%
 *   → **一様な偏りではなく、seed 間のばらつき**。どの項が抜けるかを追う。
 *
 * ★**平衡 O2 は埋没の 2 乗で効く**（`probe-o2budget.ts` の式）。
 *   埋没が 0.84 倍 → O2 は 0.6 倍。**負のフィードバックが 1 本しか無い**（罠 95）。
 *
 * ★突き合わせ（罠 110）: 陸の埋没が 0 のときは「陸に上がった多細胞」の数を隣に出す。
 *   係数の問題か、系統が出ていないのかが、その場で分かれる。
 * ★カナリア（罠 13）: 日射。★時代分解で見ること（罠 17）。
 * ★設定は `probe-traits.ts` と同じ（罠 20）: 64x32 / hadean / 結合 200kyr / 刻み 400kyr
 *
 *   for s in g01 g02 g08 g11; do
 *     npx vite-node scripts/probes/probe-o2history.ts --seed $s > /tmp/O2-$s.log 2>&1 &
 *   done; wait
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"
import { GENE_KINDS, hasCapability } from "../../src/sim/genome"
import type { LifeParams } from "../../src/sim/life"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1]! : d
}
const W = Number(arg("width", "64")), H = W >> 1
const SEED = arg("seed", "g01")
const CASE = Number(arg("case", "0"))
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

/**
 * ★**`recalcitrance` を浮動から選択に置き換える A/B**（2026-09-07）。
 *
 * 見返り = 食われにくさ（`defenceGuard`）、コスト = 作る投資（常時）。
 * ★`probe-margin.ts` では測れない —— **章に捕食者が 1 匹もいない**ので、
 *   防御形質の見返りは構造的に 0.0% としか出ない（罠 85 で踏んだ）。
 * ★対照（case 0）は**何も渡さない**こと（罠 39）。
 */
const CASES: readonly [string, Partial<LifeParams>][] = [
  ["対照（既定・浮動のまま）", {}],
  ["防御 0.5 / コスト 0.02", { recalcitranceDefence: 0.5, recalcitranceCost: 0.02 }],
  ["防御 0.5 / コスト 0.05", { recalcitranceDefence: 0.5, recalcitranceCost: 0.05 }],
  ["防御 0.8 / コスト 0.02", { recalcitranceDefence: 0.8, recalcitranceCost: 0.02 }],
]
const [label, over] = CASES[CASE] ?? CASES[0]!
const C_LAND = GENE_KINDS.indexOf("capLandTolerance")
const C_MULTI = GENE_KINDS.indexOf("capMulticellular")
const C_OXY = GENE_KINDS.indexOf("capOxygenicPhotosynthesis")
const C_PRED = GENE_KINDS.indexOf("capPredation")
/** mol C → Gt C（12 g/mol、1 Gt = 1e15 g） */
const GT = 1e15 / 12

const w = new World({
  width: W, height: H, seed: SEED, shared: false, startEpoch: "hadean",
  climateCouplingYears: 200_000,
})
Object.assign(w.life.params, over)
const T_RECAL = GENE_KINDS.indexOf("recalcitrance")

console.log(`酸素の収支の全史  ${W}x${H}  seed ${SEED}  case ${CASE} ${label}`
  + `  ${JSON.stringify(over)}`)
console.log("  ★地球: 埋没 1.0e13（海 ~7e12 / 陸 ~3e12）  NPP 50 Gt C/yr  O2 20.9%")
console.log("Ga    O2%  平衡%  NPP    埋没      海       陸       還元剤   酸化風化 火災 "
  + "陸系統/全  陸%  recal±SD    捕食  日射")

let next = PLANET_AGE_YEARS - 3.5e9
while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
  w.advance(400_000, OPT)
  if (w.globals.yearsElapsed < next) continue
  // ★**機構が効く窓に標本を集めること。** 捕食者が出るのは最後の 1 Gyr で、
  //   0.5 Gyr 刻みでは**そこに 2 点しか無い**（実際に判定できなかった）。
  //   しかも O2 は 0.5 Gyr の周期で振れているので、終端 1 点では読めない（罠 2・40）
  next += w.globals.yearsElapsed > PLANET_AGE_YEARS - 1.5e9 ? 0.1e9 : 0.5e9
  const st = w.oxygen.state
  const p = w.oxygen.params
  const eq = st.burial > st.reductant
    ? 20.9 * Math.pow((st.burial - st.reductant) / p.oxidativeWeatheringPresent, 2)
    : 0
  const cl = w.life.clades
  const woody = cl.filter((c) => hasCapability(c.phenotype, C_OXY)
    && !hasCapability(c.phenotype, C_PRED)
    && hasCapability(c.phenotype, C_LAND) && hasCapability(c.phenotype, C_MULTI)).length
  const rv = cl.map((c) => c.phenotype.traits[T_RECAL] ?? 0)
  const recalMean = rv.length ? rv.reduce((a, b) => a + b, 0) / rv.length : 0
  const recalSd = rv.length > 1
    ? Math.sqrt(rv.reduce((a, b) => a + (b - recalMean) * (b - recalMean), 0) / rv.length)
    : 0
  const preds = cl.filter((c) => hasCapability(c.phenotype, C_PRED)).length
  // ★陸の割合は**物理が食べている量**（`landFraction`）で出すこと（罠 83）
  const lf = w.store.f32("landFraction").read
  let land = 0, wsum = 0
  for (let y = 0; y < H; y++) {
    const aw = w.grid.areaWeight[y]!
    for (let x = 0; x < W; x++) { land += lf[y * W + x]! * aw; wsum += aw }
  }
  console.log(
    `${((PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9).toFixed(2)} `
    + `${w.globals.o2.toFixed(1).padStart(5)} ${eq.toFixed(1).padStart(6)} `
    + `${(st.primaryProduction / GT).toFixed(1).padStart(5)}  `
    + `${st.burial.toExponential(2)} ${st.burialMarine.toExponential(1)} `
    + `${st.burialLand.toExponential(1)} ${st.reductant.toExponential(1)} `
    + `${st.oxidativeWeathering.toExponential(1)} ${st.fireLoss.toFixed(2)} `
    + `${String(woody).padStart(4)}/${String(cl.length).padStart(2)}   `
    + `${(100 * land / wsum).toFixed(1).padStart(4)}  `
    // ★**判定量**: 浮動なら SD が大きいまま散る。選択が効けば揃うはず
    + `${recalMean.toFixed(2)}±${recalSd.toFixed(2)}  `
    // ★突き合わせ（罠 110）: 見返りは捕食者がいて初めて生まれる。
    //   捕食者 0 の時代に recal が動いていたら、それは選択ではない
    + `${String(preds).padStart(4)}  `
    + `${(w.globals.solarConstant * w.globals.solarMultiplier).toFixed(0)}`)
}

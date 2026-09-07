/**
 * **酸素の収支を、地球の実測値と突き合わせる**（2026-09-07。数秒）。
 *
 * ★課題「終端の O2 が 10.1%（地球 21%）」の輪を短くする（罠 34）。
 * 全史 1 本は 10 分、4 seed の A/B は 30 分。配っている章を読めば数秒で済む。
 *
 * ★**まず基準状態を測る**（罠 12）。「パラメータが悪い」と
 * 「時間発展で壊れる」を一撃で分ける。
 *
 * ★**「収支が閉じているか」ではなく「地球と比べて妥当か」を見る**（罠 94）。
 * 吸い込み側（`reductantPresent` 2.0e12 + `oxidativeWeatheringPresent` 8.0e12）は
 * 地球の値そのままで置いてあるのに、**供給側（埋没）には見張りが無い**。
 *
 * 【地球の値】
 *   有機炭素の埋没  ~1.0e13 mol C/yr（= 0.12 Gt C/yr。Holland 2002 ほか）
 *   海洋の一次生産  ~4e15 mol C/yr（50 Gt C/yr）／ 陸上 ~5e15（60 Gt C/yr）
 *   埋没の割合      一次生産の 0.1〜0.2%
 *
 * ★**平衡 O2 は埋没から解析的に出る**（`reductant` は O2 に依らないので）:
 *     src = sink → 埋没 = 還元剤 + 8.0e12 ×(O2/20.9)^0.5
 *     O2 = 20.9 × ((埋没 − 還元剤) / 8.0e12)²
 *   **2 乗**なので、埋没が 0.84 倍でも O2 は 0.6 倍になる（罠 95 の増幅）。
 *
 *   npx vite-node scripts/probes/probe-o2budget.ts
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { loadWorld } from "../../src/sim/snapshot"
import { GENE_KINDS, hasCapability } from "../../src/sim/genome"
import type { World } from "../../src/sim/world"

const CHAPTERS = ["archean", "proterozoic", "phanerozoic"] as const
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const C_LAND = GENE_KINDS.indexOf("capLandTolerance")
const C_MULTI = GENE_KINDS.indexOf("capMulticellular")
const C_OXY = GENE_KINDS.indexOf("capOxygenicPhotosynthesis")
const C_PRED = GENE_KINDS.indexOf("capPredation")

/** 地球の有機炭素の埋没 [mol C/yr]。吸い込み側の較正と釣り合う値 */
const EARTH_BURIAL = 1.0e13
/** 地球の海洋一次生産 [mol C/yr]（50 Gt C/yr ÷ 12 g/mol） */
const EARTH_NPP_SEA = 4.2e15
/** mol C → Gt C（炭素は 12 g/mol、1 Gt = 1e15 g） */
const GT = 1e15 / 12

console.log("酸素の収支（章ごと。★地球: 埋没 1.0e13 mol C/yr = 0.12 Gt C/yr）")
console.log("  ★平衡 O2 = 20.9 × ((埋没 − 還元剤)/8.0e12)²  —— **2 乗で効く**")
console.log("")
console.log("章            Gyr   O2%   平衡O2%  NPP[Gt C/yr]  埋没[mol/yr]  海    陸"
  + "     還元剤   酸化風化  火災  陸系統/全")

for (const ch of CHAPTERS) {
  const w: World = loadWorld(new Uint8Array(gunzipSync(
    readFileSync(`public/chapters/${ch}.gaia`))))
  // ★**酸素は 1 Myr 刻み**（`preferredStepYears`）。100kyr で進めると
  //   `update` が一度も走らず、章に保存された古い `burial` を印字して
  //   内訳だけ 0 になる（実際そう出た。罠 110 の突き合わせで気づけた）
  w.advance(2_000_000, OPT)
  const st = w.oxygen.state
  const p = w.oxygen.params
  const eq = st.burial > st.reductant
    ? 20.9 * Math.pow((st.burial - st.reductant) / p.oxidativeWeatheringPresent, 2)
    : 0
  const cl = w.life.clades
  // ★カナリア（罠 13・110）: 陸の埋没が 0 なら「陸に上がった多細胞」が
  //   何本いるかを見れば、係数の話か系統の話かがその場で分かる
  const woody = cl.filter((c) => hasCapability(c.phenotype, C_OXY)
    && !hasCapability(c.phenotype, C_PRED)
    && hasCapability(c.phenotype, C_LAND) && hasCapability(c.phenotype, C_MULTI)).length
  console.log(
    `${ch.padEnd(13)} ${(w.globals.yearsElapsed / 1e9).toFixed(2)}  `
    + `${w.globals.o2.toFixed(1).padStart(5)}  ${eq.toFixed(1).padStart(6)}   `
    + `${(st.primaryProduction / GT).toFixed(2).padStart(10)}  `
    + `${st.burial.toExponential(2)}  ${st.burialMarine.toExponential(1)}  `
    + `${st.burialLand.toExponential(1)}  ${st.reductant.toExponential(1)}  `
    + `${st.oxidativeWeathering.toExponential(1)}  ${st.fireLoss.toFixed(2)}  `
    + `${woody}/${cl.length}`)
}
console.log("")
console.log(`地球          0.00   20.9    20.9        ${(EARTH_NPP_SEA / GT).toFixed(2)}`
  + `  ${EARTH_BURIAL.toExponential(2)}  （海 ~7e12 / 陸 ~3e12）  2.0e+12  8.0e+12`)

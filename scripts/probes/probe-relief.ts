/**
 * 起伏の収支を測る。**M4 の陸地面積の代わりに使う主指標。**
 *
 *   npx vite-node scripts/probes/probe-relief.ts [--seed s2] [--gyr 2] [--width 96]
 *
 * 【なぜ陸地面積で判定しないか】陸地面積は seed 間 SD 3.8 ポイント、しかも
 * **数学的に等価な式の書き換え（最終桁の差）でも 3 ポイント動く**
 * （WORK-IN-PROGRESS.md の「最終桁でカオス的に分岐する」）。
 * 4 seed の対応のある比較でも SE が 4 ポイントあり、機構の良し悪しを
 * 判定できる分解能が無い。
 *
 * 【代わりに何を見るか】
 *
 *   1. **厚さの分散の時間中央値** —— 1 ラン内の全ステップから取るので標本が多い。
 *      地球の値は **218 km²**（大陸 37km×41% + 海洋 7km×59% から計算）
 *   2. **分散の台帳（機構別の Δ分散の積算）** —— 数千ステップの和なので安定
 *   3. **体積あたりの分散効率** —— 「どの機構が起伏を作り、どれが潰しているか」
 *
 * 終端値は使わない（docs/01-6.5c の「単一ランの終端値で判断しない」）。
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"
import { felsicVolume } from "../../src/sim/tectonics"

const arg = (k: string, d: number) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? Number(process.argv[i + 1]) : d
}
const argS = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? process.argv[i + 1] : d
}
const W = arg("width", 96), H = W >> 1
const GYR = arg("gyr", 2)
const SEED = argS("seed", "audit")
const LABEL = argS("label", "基準")
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

/** 地球の地殻の厚さ分散 [km²]。大陸 37km×41% + 海洋 7km×59% */
const EARTH_VARIANCE = 218
/** 地球の陸地面積 [%] */
const EARTH_LAND = 29.2

const tec: Record<string, number | string> = {}
for (const k of ["orogenyReach", "orogenyDonor", "crustComposition",
  "accretionBonus", "arcThicknessBias", "orogenyForelandCap",
  "orogenyForelandOnly", "orogenyRate", "divergenceMeridionalSign", "arcFocus", "crustGrowthRate",
  "felsicResistThinKm", "felsicResistThickKm", "crustRecycleRate",
  "plateSpeed", "plateCount", "crustModel", "parcelCount", "arcFluxEfficiency",
  // ★島弧を「既にある大陸の縁」へ偏らせる強さ。既定 0（一様）。
  //   アンデス型の大陸成長を表す量で、0 だと海底全面に薄く塗られる
  "arcContinentBias", "rasterSmoothing", "marginErosionRatio",
  // ★大陸がプレートから引き剥がされにくさ／堆積が大陸を新造しないか（2026-09-07）
  "continentPlateCohesion", "sedimentNeedsFelsic", "coverageHealYears", "ridgeFillFelsicBlock",
  "initialContinentFraction"]) {
  const v = arg(k.toLowerCase(), NaN)
  if (!Number.isNaN(v)) tec[k] = v
}
const denud = arg("denud", NaN)
if (!Number.isNaN(denud)) tec.denudationRate = denud

const MANTLE = arg("mantle", NaN)
const WATER = arg("water", 1)
const w = new World({
  width: W, height: H, seed: SEED, shared: false, startEpoch: "hadean",
  climateCouplingYears: 200_000, tectonics: tec as never,
  ...(Number.isNaN(MANTLE) ? {} : { initialMantleTempC: MANTLE }),
})
// ★**分散の台帳を有効にする。**
//
// 台帳は粒子から毎回ラスタライズし直さないと意味が無い ——
// `crustThickness` の【場】はステップの最後に 1 回しか作られないので、
// 途中でそれを測ると**差が全部 0 になる**（実測でそうなっていた）。
// 費用は掛かるが、この測定の主目的が台帳なので必ず立てる
w.tectonics.varLedgerEnabled = true
// 惑星の水の量を振る。冥王代の開始時は全部が水蒸気なのでそちらを掛ける
if (WATER !== 1) {
  w.globals.steamFraction *= WATER
  w.globals.oceanWaterFraction *= WATER
}

const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
const pct = (a: number[], f: number) => {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.max(0, Math.round(f * (s.length - 1))))]
}

/** 面積重み付きの厚さの分散 [km²]（全球。大陸だけでなく海洋も含む） */
function variance(): number {
  const th = w.store.f32("crustThickness").read
  let m = 0, m2 = 0
  for (let y = 0; y < H; y++) {
    const aw = w.grid.areaWeight[y]
    for (let x = 0; x < W; x++) { const t = th[y * W + x]; m += t * aw; m2 += t * t * aw }
  }
  return m2 - m * m
}
function landPct(): number {
  const el = w.store.f32("elevation").read
  const sea = w.globals.seaLevel
  let a = 0
  for (let y = 0; y < H; y++) {
    const aw = w.grid.areaWeight[y]
    for (let x = 0; x < W; x++) if (el[y * W + x] >= sea) a += aw
  }
  return 100 * a
}

/**
 * ★**まとまった陸**（`landFraction >= 0.75`）の面積割合 [%]。
 *
 * 分散だけでは「集まっているか」が分からない —— 面積が同じでも、
 * **まとまった大陸**と**一面に薄く塗られた陸**では分散も陸地面積も似た値になる。
 * 実測で面積 22.8% に対しまとまった陸は 2.3% しかなかった。
 */
function solidPct(): number {
  const lf = w.store.f32("landFraction").read
  let a = 0, tot = 0
  for (let y = 0; y < H; y++) {
    const aw = w.grid.areaWeight[y]
    for (let x = 0; x < W; x++) { if (lf[y * W + x] >= 0.75) a += aw; tot += aw }
  }
  return tot > 0 ? (100 * a) / tot : 0
}

const vars: number[] = [], lands: number[] = [], solids: number[] = []
const end = Math.min(PLANET_AGE_YEARS, GYR * 1e9)
while (w.globals.yearsElapsed < end) {
  w.advance(400_000, OPT)
  vars.push(variance()); lands.push(landPct()); solids.push(solidPct())
}
// 前半は初期地形の記憶が残るので、後半だけを定常とみなす
const half = vars.length >> 1
const vs = vars.slice(half), ls = lands.slice(half), ss = solids.slice(half)

const vl = w.tectonics.varLedger
const b = w.tectonics.budget
console.log(`\n【${LABEL}】 ${W}x${H}  ${(end / 1e9).toFixed(2)}Gyr  seed ${SEED}  ` +
  `水 x${WATER}${Number.isNaN(MANTLE) ? "" : `  マントル ${MANTLE}℃`}  ` +
  `(${vars.length} ステップ、後半 ${vs.length} 個で統計)`)
console.log(`  ★厚さの分散 [km²]  中央値 ${med(vs).toFixed(1)}  ` +
  `P5 ${pct(vs, 0.05).toFixed(1)}  P95 ${pct(vs, 0.95).toFixed(1)}   ` +
  `（地球 ${EARTH_VARIANCE}）`)
console.log(`  ★まとまった陸 [%]  中央値 ${med(ss).toFixed(1)}  ` +
  `P5 ${pct(ss, 5).toFixed(1)}  P95 ${pct(ss, 95).toFixed(1)}` +
  `   （landFraction>=0.75。地球はほぼ全部）`)
console.log(`   陸地面積 [%]      中央値 ${med(ls).toFixed(1)}  ` +
  `P5 ${pct(ls, 0.05).toFixed(1)}  P95 ${pct(ls, 0.95).toFixed(1)}   ` +
  `（地球 ${EARTH_LAND}。**ノイズが大きいので主指標にしない**）`)
{
  const yrs = end
  console.log(`   粒子 ${w.tectonics.parcels?.count ?? "-"}`)
console.log(`   珪長質の体積 ${(felsicVolume(w) / 1e9).toFixed(2)}e9 km³（地球 7.2）` +
    `\n     島弧の生成 ${(b.arc / yrs).toFixed(2)}` +
    ` / 珪長質の再循環 ${(-b.subduction / yrs).toFixed(2)}` +
    ` / 深海流出 ${(-b.sedimentLoss / yrs).toFixed(2)} km³/yr` +
    `\n     海洋地殻の循環（マントルとの交換。保存量ではない） 生成 ` +
    `${(b.spreading / yrs).toFixed(1)} / 消費 ${(-b.basaltCycle + b.spreading > 0 ? (b.spreading - b.basaltCycle) / yrs : 0).toFixed(1)} km³/yr` +
    `（地球 生成 1〜3 / 再循環 2〜2.8 / 正味 約 1）`)
}

// 機構別の分散の台帳と、動かした体積あたりの効率
const moved: Record<string, number> = {
  // ★粒子モデルの段に合わせる。造山とリフトは【機構として存在しない】ので、
  //   境界のプロセスは沈み込みで測る
  advection: Math.abs(b.advection), boundary: Math.abs(b.subduction),
  arc: Math.abs(b.arc), spreading: Math.abs(b.spreading),
  delamination: Math.abs(b.delamination),
  erosion: Math.abs(b.erosion), clamp: Math.abs(b.clamp),
}
console.log(`  ★分散の台帳（機構別の Δ分散の積算 [km²]）と、体積あたりの効率`)
console.log(`     機構            Δ分散    動かした体積[1e9km³]   効率[km²/e9km³]`)
let net = 0
for (const k of ["advection", "boundary", "arc", "spreading", "delamination",
  "erosion", "clamp"] as const) {
  const dv = vl[k]
  net += dv
  const mv = moved[k] / 1e9
  console.log(`     ${k.padEnd(12)} ${dv.toFixed(0).padStart(8)}  ${mv.toFixed(2).padStart(18)}` +
    `  ${(mv > 1e-6 ? dv / mv : 0).toFixed(0).padStart(16)}`)
}
console.log(`     ${"正味".padEnd(12)} ${net.toFixed(0).padStart(8)}`)

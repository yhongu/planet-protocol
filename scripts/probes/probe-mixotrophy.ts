/**
 * **食性を連続にした（`mixotrophy`）ときの A/B**（2026-09-07）。
 *
 * `probe-margin.ts`（1.8 秒）は「崖が勾配になる」ことまでしか言えない ——
 * `capPredation` の余白が 原生代 −50.9% → −25.2%（mixotrophy 0.5）。
 * ★**「引ける」と「立つ」と「効く」は別**（罠 52）。全史で確かめる。
 *
 * 判定量は **捕食者クレードの `photosynthesis` の SD**。
 * 混合栄養が意味を持つのは「捕食者の中で光合成の度合いが分かれるとき」だけで、
 * SD 0.000 なら**機構はあっても効いていない**（罠 96）。
 *
 * ★**突き合わせられる量を隣に置くこと**（罠 110）:
 *   捕食者の数 / 混合栄養の数（h < 0.95）/ 生物圏 / O2 を必ず一緒に出す。
 *   「捕食者 0 なのに SD が出ている」なら計器が壊れている。
 * ★**生命が弱っていないかを見ること**（罠 51）。生物圏とクレード数が対照。
 * ★カナリア（罠 13）: 日射を出す。
 *
 * ★設定は `probe-traits.ts` と同じ（罠 20。組み直さない）:
 *   64x32 / startEpoch "hadean" / climateCouplingYears 200_000 / 刻み 400kyr
 * ★対照（case 0）は**何も渡さない**こと（罠 39: 既定と「0 を明示」を区別）。
 *
 *   for c in 0 1; do for s in g01 g02 g08 g11; do
 *     npx vite-node scripts/probes/probe-mixotrophy.ts --case $c --seed $s > /tmp/MX-$c-$s.log 2>&1 &
 *   done; wait; done
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
const T_PHOTO = GENE_KINDS.indexOf("photosynthesis")
const T_BODY = GENE_KINDS.indexOf("bodySize")
const C_PRED = GENE_KINDS.indexOf("capPredation")

/** ★対照は**空**。`mixotrophy: 0` と書くと「対照が対照でない」罠 39 を踏む */
const CASES: readonly [string, Partial<LifeParams>][] = [
  ["対照（既定）", {}],
  ["mixotrophy 0.5", { mixotrophy: 0.5 }],
  ["mixotrophy 0.25", { mixotrophy: 0.25 }],
  ["mixotrophy 1.0", { mixotrophy: 1.0 }],
]
const [label, over] = CASES[CASE] ?? CASES[0]!

const w = new World({
  width: W, height: H, seed: SEED, shared: false, startEpoch: "hadean",
  climateCouplingYears: 200_000,
})
Object.assign(w.life.params, over)

console.log(`case ${CASE} ${label}  ${W}x${H}  seed ${SEED}  ${JSON.stringify(over)}`)
console.log("Ga    系統  捕食者  混合  photo平均  photo_SD  捕食者photo_SD  体最大  生物圏  O2%   日射")

/** 従属栄養の割合（`Life.heteroShare` と同じ定義を計器から呼ぶ。罠 65） */
const hetero = (c: (typeof w.life.clades)[number]) => w.life.heteroShare(c.phenotype)

const sd = (v: number[]) => {
  if (v.length < 2) return 0
  const m = v.reduce((a, b) => a + b, 0) / v.length
  return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length)
}

let firstPred = -1
let next = PLANET_AGE_YEARS - 3.5e9
while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
  w.advance(400_000, OPT)
  const cl0 = w.life.clades
  if (firstPred < 0 && cl0.some((c) => hasCapability(c.phenotype, C_PRED))) {
    firstPred = w.globals.yearsElapsed
  }
  if (w.globals.yearsElapsed < next) continue
  next += 0.5e9
  const cl = w.life.clades
  const preds = cl.filter((c) => hasCapability(c.phenotype, C_PRED))
  // ★混合栄養＝「捕食者なのに餌からの取り分が 1 未満」。対照では必ず 0 になる
  const mixed = preds.filter((c) => hetero(c) < 0.95).length
  const photo = cl.map((c) => c.phenotype.traits[T_PHOTO] ?? 0)
  const photoP = preds.map((c) => c.phenotype.traits[T_PHOTO] ?? 0)
  const body = cl.length ? Math.max(...cl.map((c) => c.phenotype.traits[T_BODY] ?? 0)) : 0
  const mean = photo.length ? photo.reduce((a, b) => a + b, 0) / photo.length : 0
  console.log(
    `${((PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9).toFixed(2)}  `
    + `${String(cl.length).padStart(3)}   ${String(preds.length).padStart(4)}  `
    + `${String(mixed).padStart(4)}     ${mean.toFixed(3)}     ${sd(photo).toFixed(3)}`
    + `         ${sd(photoP).toFixed(3)}   ${body.toFixed(2)}    `
    + `${w.globals.biosphereProxy.toFixed(2)}   ${w.globals.o2.toFixed(1)}  `
    + `${(w.globals.solarConstant * w.globals.solarMultiplier).toFixed(0)}`)
}
const cl = w.life.clades
const preds = cl.filter((c) => hasCapability(c.phenotype, C_PRED))
console.log(`終端  系統 ${cl.length}  捕食者 ${preds.length}`
  + `  捕食者の初出 ${firstPred < 0 ? "無し" : (firstPred / 1e9).toFixed(2) + "Gyr"}`
  + `  捕食者photo平均 ${(preds.length
    ? preds.reduce((a, c) => a + (c.phenotype.traits[T_PHOTO] ?? 0), 0) / preds.length
    : 0).toFixed(3)}`
  + `  生物圏 ${w.globals.biosphereProxy.toFixed(2)}`
  + `  O2 ${w.globals.o2.toFixed(1)}%  CO2 ${w.globals.co2.toFixed(0)}ppm`
  + `  気温 ${(w.stats?.meanT ?? NaN).toFixed(1)}C`)

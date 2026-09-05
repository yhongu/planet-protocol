/**
 * **形質を繋いだ 5 つの機構の A/B**（2026-09-05）。
 *
 * 判定量は **クレード間の SD** ——「分化しているか」そのもの。
 * `CLAUDE.md` の 44/45 で繰り返し踏んだ「端に張り付く」「分化しない」を
 * 数字で見る。SD が 0.000 なら**その形質は無いのと同じ**。
 *
 * ★設定は `probe-rebirth.ts` / `probe-landplant.ts` と同じ（罠 20）。
 *   64x32 / startEpoch "hadean" / climateCouplingYears 200_000 / 刻み 400kyr
 * ★カナリア（罠 13）: 日射を必ず出す。
 * ★4 seed 以上・対応のある比較で読むこと（罠 3）。
 *
 *   for c in 0 1 2 3 4 5; do for s in g01 g02 g08 g11; do
 *     npx vite-node scripts/probes/probe-traits.ts --case $c --seed $s > /tmp/TR-$c-$s.log 2>&1 &
 *   done; done; wait
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"
import { GENE_KINDS } from "../../src/sim/genome"
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

/** 条件。★対照（case 0）は**何も渡さない**こと（罠 39: 0 を明示と省略を区別） */
const FULL: Partial<LifeParams> = {
  weatheringNutrient: 0.6, weatheringCost: 0.01,
  socialityCapture: 0.35, socialityDefence: 0.45, socialityCost: 0.03,
  symbolicNeedsSociality: 0.7,
  ccnAntioxidant: 0.8, ccnCost: 0.02, oxygenRosBaseline: 0.35,
  albedoIcePenalty: 1.0, albedoCost: 0.01,
}
/**
 * ★**最終候補**。切り分けの結論:
 *   - 悪化の原因は `oxygenRosBaseline = 0.35`（0.20 に下げて 2 seed とも完全回復）
 *   - 捕食圧は**まったく無関係**だった（2.0 → 0.5 で 1 桁まで同一）——
 *     その 2 seed には捕食者が一度も現れていなかった
 * 残り 4 seed で確認する。**捕食圧 2.0 を捕食者のいる惑星で試す初めての機会**
 */
const CASES: readonly [string, Partial<LifeParams>][] = [
  ["最終候補（ROS 0.20）", { ...FULL, predationPressure: 2.0, oxygenRosBaseline: 0.20 }],
]
const [label, over] = CASES[CASE] ?? CASES[0]!

const w = new World({
  width: W, height: H, seed: SEED, shared: false, startEpoch: "hadean",
  climateCouplingYears: 200_000,
})
Object.assign(w.life.params, over)

/** 見る形質（`GENE_KINDS` の名前） */
const WATCH = ["tempOptimum", "bodySize", "brain", "weatheringBoost",
  "dispersal", "sociality", "ccnProduction", "albedoEffect",
  "aridityTolerance", "nutrientP", "recalcitrance"] as const
const IDX = WATCH.map((k) => {
  const i = GENE_KINDS.indexOf(k as never)
  if (i < 0) throw new Error(`知らない形質: ${k}`)
  return i
})

console.log(`case ${CASE} ${label}  ${W}x${H}  seed ${SEED}`)
console.log(`  ${JSON.stringify(over)}`)

let last = ""
while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
  w.advance(400_000, OPT)
}
// --- 終端の姿 ---
const cl = w.life.clades
const sd = (idx: number) => {
  if (cl.length < 2) return 0
  const v = cl.map((c) => c.phenotype.traits[idx] ?? 0)
  const m = v.reduce((a, b) => a + b, 0) / v.length
  return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length)
}
const mean = (idx: number) => cl.length
  ? cl.reduce((a, c) => a + (c.phenotype.traits[idx] ?? 0), 0) / cl.length : 0

console.log(`  終端 ${(w.globals.yearsElapsed / 1e9).toFixed(2)}Gyr  クレード ${cl.length}`
  + `  生物圏 ${w.globals.biosphereProxy.toFixed(2)}`
  + `  O2 ${w.globals.o2.toFixed(1)}%  CO2 ${w.globals.co2.toFixed(0)}ppm`
  + `  気温 ${(w.stats?.meanT ?? NaN).toFixed(1)}C`
  + `  日射 ${(w.globals.solarConstant * w.globals.solarMultiplier).toFixed(0)}`)
console.log("  形質                平均    SD     ★SD が 0.000 なら分化していない")
for (let k = 0; k < WATCH.length; k++) {
  console.log(`  ${WATCH[k]!.padEnd(18)} ${mean(IDX[k]!).toFixed(3)}  ${sd(IDX[k]!).toFixed(3)}`)
}
void last

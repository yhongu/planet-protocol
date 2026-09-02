/**
 * 大陸を砕いている機構を特定する。
 *
 * 初期地形は有効陸塊数 3.0（地球 2.56）で地球並みにまとまっている。
 * それがスクイッシーリッド -> モバイルリッドの遷移で 2.7 -> 11.4 に砕け、
 * 以後 45 億年回復しない。遷移で変わるのは MODE_TRAITS の 2 つだけ:
 *   造山     0.3 -> 1.0
 *   大陸成長 0.3 -> 1.0（島弧の生成量）
 * どちらが砕いているかを切って確かめる。
 *
 * 【1 条件 1 プロセスで並列に回す】このマシンは 24 論理コアあり、
 * Node は 1 プロセス 1 スレッドなので、条件ごとにプロセスを分ければ
 * 全条件が 1 本分の時間で終わる。
 *
 *   for c in 0 1 2 3; do npx vite-node scripts/probes/probe-shatter.ts --case $c & done; wait
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"
import { MODE_TRAITS } from "../../src/sim/mantle"

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? process.argv[i + 1] : d
}
const W = Number(arg("width", "64")), H = W >> 1
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }

const label = new Int32Array(W * H), stack = new Int32Array(W * H)

/** 有効陸塊数（逆シンプソン）と最大陸塊の占有率。probe-landmetric.ts で選別した指標 */
function clump(w: World): { land: number; biggest: number; effN: number } {
  const el = w.store.f32("elevation").read
  const sea = w.globals.seaLevel
  label.fill(0)
  const areas: number[] = []
  let landArea = 0, cur = 0
  for (let s = 0; s < W * H; s++) {
    if (label[s] !== 0 || el[s] < sea) continue
    cur++
    let top = 0
    stack[top++] = s; label[s] = cur
    let a = 0
    while (top > 0) {
      const i = stack[--top]
      const y = (i / W) | 0, x = i - y * W
      a += w.grid.areaWeight[y]
      const nb = [y * W + (x + 1 === W ? 0 : x + 1), y * W + (x === 0 ? W - 1 : x - 1),
        y > 0 ? i - W : -1, y + 1 < H ? i + W : -1]
      for (const j of nb) {
        if (j < 0 || label[j] !== 0 || el[j] < sea) continue
        label[j] = cur; stack[top++] = j
      }
    }
    areas.push(a); landArea += a
  }
  const sum2 = areas.reduce((s, v) => s + v * v, 0)
  areas.sort((p, q) => q - p)
  return {
    land: 100 * landArea,
    biggest: landArea > 0 ? (100 * areas[0]) / landArea : 0,
    effN: sum2 > 0 ? (landArea * landArea) / sum2 : 0,
  }
}

// MODE_TRAITS は const だがプロパティは書き換えられる。実験のたびに戻すこと
const ORIG = { orogeny: MODE_TRAITS.mobileLid.orogeny,
  continentGrowth: MODE_TRAITS.mobileLid.continentGrowth }

type Case = { name: string; setup: (w: World) => void }
const CASES: Case[] = [
  { name: "基準（そのまま）", setup: () => {} },
  { name: "島弧の生成を止める", setup: (w) => { w.tectonics.params.crustGrowthRate = 0 } },
  { name: "モバイルの造山を 0.3 に", setup: () => { MODE_TRAITS.mobileLid.orogeny = 0.3 } },
  { name: "モバイルの大陸成長を 0.3 に", setup: () => { MODE_TRAITS.mobileLid.continentGrowth = 0.3 } },
  // --- ここから セル規模で効きそうな機構の切り分け ---
  { name: "リフトを止める", setup: (w) => { w.tectonics.params.riftRate = 0 } },
  { name: "侵食を止める", setup: (w) => { w.tectonics.params.denudationRate = 0 } },
  { name: "体積クランプを止める", setup: (w) => { w.tectonics.params.volumeClamp = 0 } },
  { name: "移流の体積補正を止める", setup: (w) => { w.tectonics.params.advectCorrection = 0 } },
  { name: "プレート速度を半分に", setup: (w) => { w.tectonics.params.plateSpeed *= 0.5 } },
  { name: "海面を動かさない", setup: (w) => { w.tectonics.params.waterSubductionRate = 0
    w.tectonics.params.waterDegassingRate = 0 } },
]

// プレート数を振る。プレート境界が大陸を切り刻んでいるなら、
// 刃の数を減らせば有効陸塊数が下がるはず。
// 【プレート数は init で使うので World の生成時に渡す】
const PLATES = [4, 6, 8, 12, 16, 24]

const ONLY = process.argv.indexOf("--case") >= 0
  ? Number(process.argv[process.argv.indexOf("--case") + 1]) : -1
const PLATE = process.argv.indexOf("--plates") >= 0
  ? Number(process.argv[process.argv.indexOf("--plates") + 1]) : -1
const FORE = process.argv.indexOf("--foreland") >= 0
  ? Number(process.argv[process.argv.indexOf("--foreland") + 1]) : -1
const BONUS = process.argv.indexOf("--bonus") >= 0
  ? Number(process.argv[process.argv.indexOf("--bonus") + 1]) : -1
// 発散の南北項の符号（2026-08-28 に見つけた反転バグ）の A/B。1=正しい / 0=旧
const DIVSIGN = process.argv.indexOf("--divsign") >= 0
  ? Number(process.argv[process.argv.indexOf("--divsign") + 1]) : -1
// 指標そのものの seed ノイズを測るため。差を議論する前に誤差を知ること
const SEED = process.argv.indexOf("--seed") >= 0
  ? process.argv[process.argv.indexOf("--seed") + 1] : "audit"

const run = (name: string, opts: Record<string, unknown>, setup: (w: World) => void) => {
  MODE_TRAITS.mobileLid.orogeny = ORIG.orogeny
  MODE_TRAITS.mobileLid.continentGrowth = ORIG.continentGrowth
  const t0 = Date.now()
  const w = new World({ width: W, height: H, seed: SEED, shared: false,
    startEpoch: "hadean", climateCouplingYears: 200_000, ...opts })
  setup(w)
  const land: number[] = [], big: number[] = [], eff: number[] = []
  const push = () => { const m = clump(w); land.push(m.land); big.push(m.biggest); eff.push(m.effN) }
  push()
  while (w.globals.yearsElapsed < PLANET_AGE_YEARS) { w.advance(400_000, OPT); push() }
  console.log(`RESULT\t${name}\t${med(land).toFixed(1)}\t${med(big).toFixed(1)}\t` +
    `${med(eff).toFixed(2)}\t${((Date.now() - t0) / 1000).toFixed(0)}秒`)
  MODE_TRAITS.mobileLid.orogeny = ORIG.orogeny
  MODE_TRAITS.mobileLid.continentGrowth = ORIG.continentGrowth
}

if (DIVSIGN >= 0) {
  run(`発散の南北符号 ${DIVSIGN ? "正(新)" : "反転(旧)"}  ${W}x${H}  seed ${SEED}`,
    { tectonics: { divergenceMeridionalSign: DIVSIGN } }, () => {})
} else if (BONUS >= 0) {
  // 島弧の新生地殻を陸の隣へ寄せる強さ。外洋での島の核形成を減らせるか
  run(`bonus ${BONUS}  ${W}x${H}  seed ${SEED}`, {},
    (w) => { w.tectonics.params.accretionBonus = BONUS })
} else if (FORE >= 0) {
  run(`前縁制限 ${FORE ? "あり(新)" : "なし(旧)"}  ${W}x${H}`, {},
    (w) => { w.tectonics.params.orogenyForelandOnly = FORE })
} else if (PLATE > 0) {
  run(`プレート ${PLATE} 枚`, { tectonics: { plateCount: PLATE } }, () => {})
} else {
  for (const c of (ONLY >= 0 ? [CASES[ONLY]] : CASES)) run(c.name, {}, c.setup)
}
void PLATES

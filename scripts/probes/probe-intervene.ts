/**
 * **介入で惑星の酸素をどれだけ動かせるかを測る**（2026-09-08）。
 *
 * ★アイデア置き場に自分で書いた宿題:
 * 「埋没は酸素に **2 乗**で効くので、少しの介入で 7% → 20% まで動く恐れがある
 * （＝介入が強すぎる）。着手前に測ること」。
 *
 * ★**神の手の作法**（`world.ts` の `intervene`）:
 * 「能力を与えるのではなく勾配を傾ける。押しても不利なら選択が戻す」。
 * だからこの計器は **`nudgeTrait` を繰り返し押した場合**を測る ——
 * 1 回押しただけで惑星が変わるなら強すぎるし、
 * 押し続けても何も変わらないなら弱すぎる。
 *
 * ★設定は `probe-ladder.ts` と同じ（罠 20）。カナリアに日射（罠 13）。
 *
 *   npx vite-node scripts/probes/probe-intervene.ts --seed g01 --gene recalcitrance
 *   npx vite-node scripts/probes/probe-intervene.ts --seed g01 --every 0   # 対照
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"
import { GENE_KINDS } from "../../src/sim/genome"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1]! : d
}
const W = Number(arg("width", "64")), H = W >> 1
const SEED = arg("seed", "g01")
const GENE = arg("gene", "recalcitrance")
/** 介入の間隔 [yr]。0 なら介入しない（★対照は「押さない」であって 0 ではない） */
const EVERY = Number(arg("every", "2e7"))
const MAG = Number(arg("mag", "1"))
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const KIND = GENE_KINDS.indexOf(GENE as never)
if (KIND < 0) throw new Error(`知らない遺伝子: ${GENE}`)

const w = new World({
  width: W, height: H, seed: SEED, shared: false, startEpoch: "hadean",
  climateCouplingYears: 200_000,
})

console.log(`介入の効き目  ${W}x${H}  seed ${SEED}  `
  + (EVERY > 0 ? `${GENE} を ${(EVERY / 1e6).toFixed(0)}Myr ごとに押す（強さ ${MAG}）`
    : "★対照（押さない）"))
console.log("Ga     O2%   生物圏  クレード  押した回数  空振り  日射")

/** 生命がいちばん多いセル（そこに押す。★決定論のため添字順で最大を採る） */
function richestCell(): number {
  const tot = w.store.f32("biomassTotal").read
  let best = -1, bv = 0
  for (let i = 0; i < w.grid.cellCount; i++) {
    if (tot[i]! > bv) { bv = tot[i]!; best = i }
  }
  return best
}

let pushed = 0, missed = 0, nextIv = EVERY, next = PLANET_AGE_YEARS - 3.0e9
while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
  w.advance(400_000, OPT)
  if (EVERY > 0 && w.globals.yearsElapsed >= nextIv) {
    nextIv += EVERY
    const c = richestCell()
    if (c < 0) { missed++ } else {
      const before = w.events.length
      w.intervene("nudgeTrait", MAG, c, KIND)
      // ★空振り（そこに生命がいない）を数える。押した回数だけ数えると嘘になる
      const ev = w.events[before]
      if (ev && ev.text.includes("いない")) missed++
      else pushed++
    }
  }
  if (w.globals.yearsElapsed < next) continue
  next += 0.5e9
  console.log(
    `${((PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9).toFixed(2)}  `
    + `${w.globals.o2.toFixed(2).padStart(6)}  ${w.globals.biosphereProxy.toFixed(2).padStart(5)}  `
    + `${String(w.life.clades.length).padStart(6)}  ${String(pushed).padStart(8)}  `
    + `${String(missed).padStart(6)}  `
    + `${(w.globals.solarConstant * w.globals.solarMultiplier).toFixed(0)}`)
}
// ★**押した形質が実際に上がったか**を出す（罠 52: 引けたと立ったは別）
const v = w.life.clades.map((c) => c.phenotype.traits[KIND] ?? 0)
const mean = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0
console.log(`終端  O2 ${w.globals.o2.toFixed(2)}%  ${GENE} の平均 ${mean.toFixed(3)}`
  + `  最大 ${(v.length ? Math.max(...v) : 0).toFixed(3)}`
  + `  押した ${pushed} 回 / 空振り ${missed} 回`)

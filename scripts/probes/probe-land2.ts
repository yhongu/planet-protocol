/**
 * **陸の測り方が 2 つあって食い違っている件を測る。**
 *
 * ★**物理が食べている量と、測定が見張っている量が違う。**
 *
 * | どこ | 何を使っているか |
 * |---|---|
 * | 気候のアルベド（`climate.ts:312`） | `landFraction`（サブグリッド） |
 * | 炭素の風化（`carbon.ts:264`） | `landFraction` |
 * | ダッシュボードの陸地面積 | `elevation >= 海面` |
 * | **総合監査の契約**（`audit.ts:428`） | **`elevation >= 海面`** |
 *
 * つまり監査が「陸地面積 21.2%、地球は 29.2」と守っている契約は、
 * **どのサブシステムも読んでいない量**である。実測（顕生代の惑星）で
 * `landFraction` 18.6% に対し `elevation >= 海面` は 6.5% と **2.9 倍**違った。
 *
 * `CLAUDE.md` の 23 と同じ形 —— 粒子の厚さ分布が右に裾を引くので、
 * **セル平均は海面を超えるのに過半数の粒子は超えない**（あるいはその逆）。
 *
 * ★**設定は `scripts/audit.ts` の `fullHistory` と同じ**（罠 20）:
 *   seed "audit" / startEpoch "hadean" / climateCouplingYears 200_000 /
 *   OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } / 刻み 400kyr
 *
 *   npx vite-node scripts/probes/probe-land2.ts [--width 96] [--seed audit]
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"
import { epochAt } from "../../src/sim/loop"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const W = Number(arg("width", "96")), H = W >> 1
const SEED = arg("seed", "audit")
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

const w = new World({
  width: W, height: H, seed: SEED, shared: false, startEpoch: "hadean",
  climateCouplingYears: 200_000,
})

/** 面積重み付きの平均。★セルを数えてはいけない（高緯度のセルは狭い） */
function areaMean(f: Float32Array): number {
  let a = 0, tot = 0
  for (let y = 0; y < H; y++) {
    const aw = w.grid.areaWeight[y]
    for (let x = 0; x < W; x++) { a += f[y * W + x] * aw; tot += aw }
  }
  return a / tot
}

/** `elevation >= seaLevel` の面積割合（監査とダッシュボードの測り方） */
function landByElevation(): number {
  const el = w.store.f32("elevation").read
  let a = 0, tot = 0
  for (let y = 0; y < H; y++) {
    const aw = w.grid.areaWeight[y]
    for (let x = 0; x < W; x++) {
      if (el[y * W + x] >= w.globals.seaLevel) a += aw
      tot += aw
    }
  }
  return a / tot
}

/** ★**まとまっているか。** 12/16 を超えるセル＝「ほぼ陸」の面積割合 */
function solidLand(lf: Float32Array): number {
  let a = 0, tot = 0
  for (let y = 0; y < H; y++) {
    const aw = w.grid.areaWeight[y]
    for (let x = 0; x < W; x++) { if (lf[y * W + x] >= 0.75) a += aw; tot += aw }
  }
  return a / tot
}

const rows: { ga: number; epoch: string; elev: number; lf: number; solid: number }[] = []
console.log(`陸の測り方 2 つ  ${W}x${H}  seed ${SEED}  （監査の fullHistory と同じ設定）`)
console.log("   年代   時代      elev>=海面   landFraction   比    ほぼ陸(>=0.75)")
let next = 0
while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
  w.advance(400_000, OPT)
  if (w.globals.yearsElapsed < next) continue
  next = w.globals.yearsElapsed + 1e8
  const lf = w.store.f32("landFraction").read
  const e = landByElevation(), l = areaMean(lf), s = solidLand(lf)
  const ga = (PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9
  rows.push({ ga, epoch: epochAt(w.globals.yearsElapsed, PLANET_AGE_YEARS).label,
    elev: e, lf: l, solid: s })
  console.log(`  ${ga.toFixed(2)}Ga  ${epochAt(w.globals.yearsElapsed, PLANET_AGE_YEARS).label.padEnd(8)}`
    + `${(e * 100).toFixed(1).padStart(9)}%${(l * 100).toFixed(1).padStart(13)}%`
    + `${(l / Math.max(1e-9, e)).toFixed(2).padStart(7)}${(s * 100).toFixed(1).padStart(12)}%`)
}

const med = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y)
  return s[s.length >> 1]
}
const ph = rows.filter((r) => r.ga <= 0.54)
console.log(`\n全史の中央値   elev>=海面 ${(med(rows.map((r) => r.elev)) * 100).toFixed(1)}%`
  + `   landFraction ${(med(rows.map((r) => r.lf)) * 100).toFixed(1)}%`
  + `   ほぼ陸 ${(med(rows.map((r) => r.solid)) * 100).toFixed(1)}%`)
if (ph.length) {
  console.log(`顕生代の中央値 elev>=海面 ${(med(ph.map((r) => r.elev)) * 100).toFixed(1)}%`
    + `   landFraction ${(med(ph.map((r) => r.lf)) * 100).toFixed(1)}%`
    + `   ほぼ陸 ${(med(ph.map((r) => r.solid)) * 100).toFixed(1)}%`)
}
console.log(`★地球は 29.2%。物理（アルベド・風化）が食べているのは landFraction の方`)

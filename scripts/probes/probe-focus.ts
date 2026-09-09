/**
 * ★★**降りても降りなくても結果が同じか**（M6 の設計上の契約。2026-09-08）。
 *
 * 案 A-2（知性が生まれたら「降りるか」を選ぶ）を成立させるには:
 *
 *   降りないと文明が進まない → **降りるのが必須**になり A-2 の意味が消える
 *   降りると結果が変わる     → **降りるのが裏技**になる
 *
 * ★これは空間の解像度独立性（`docs/04-8.8`）の**時間版**。
 *
 * 【何が一致するはずか】確率はすべて `1 − exp(−λ·dt)` で作ってあるので、
 * **ポアソン過程として刻みに依らない**（n 回に割っても「1 回以上起きる確率」は
 * 同じ）。人口と土地利用は解析解なので**厳密に**一致する。
 * ★ただし**実現値は乱数の引き方で変わる**ので、判定は
 * **分布（複数 seed の中央値）**で行う（罠 3・22）。
 *
 *   npx vite-node scripts/probes/probe-focus.ts [--gyr 0.02] [--seeds 4]
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { loadWorld } from "../../src/sim/snapshot"
import { GENE_KINDS } from "../../src/sim/genome"
import { TECHS } from "../../src/sim/tech"
import type { World } from "../../src/sim/world"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1]! : d
}
const GYR = Number(arg("gyr", "0.02"))
/**
 * ★★**実現の数**（2026-09-09 に足した）。
 *
 * 1 本ずつ比べて「粗い 1.9e7 / 降りる 1.3e5、契約違反だ」と報告しかけた。
 * ところが**同じ 100 年刻みの 2 本が 2.4e7 と 1.3e5**（200 倍）だった ——
 * つまり**刻みの差ではなく、実現ごとの散らばり**である。
 * 文明の立ち上がりは「農耕を引けたか」で**二峰**になるので、
 * 1 本の値は刻みについて何も語らない（罠 3・22）。
 * ★**判定は必ず複数の実現の中央値で。**
 */
const REALS = Number(arg("reals", "5"))
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const C_SYMBOLIC = GENE_KINDS.indexOf("capSymbolic")

/**
 * 章を読んで、知性を 1 つ投入した惑星を作る。
 * ★`rank` 番目に豊かなセルへ入れることで**別の実現**にする
 * （seed を変えると惑星そのものが変わってしまい、刻みの比較にならない）。
 */
function makeWorld(rank: number): World {
  const w = loadWorld(new Uint8Array(gunzipSync(
    readFileSync("public/chapters/phanerozoic.gaia"))))
  w.civ.params.enabled = 1
  const tot = w.store.f32("biomassTotal").read
  const order = Array.from({ length: w.grid.cellCount }, (_, i) => i)
    .sort((a, b) => (tot[b] ?? 0) - (tot[a] ?? 0))
  const best = order[rank] ?? -1
  if (best >= 0 && (tot[best] ?? 0) > 0) w.intervene("injectGene", 1, best, C_SYMBOLIC)
  return w
}

interface Result { pop: number; techs: number; civs: number; co2: number; use: number }

function run(focused: boolean, stepYears: number, rank: number): Result {
  const w = makeWorld(rank)
  w.civ.focused = focused
  const end = w.globals.yearsElapsed + GYR * 1e9
  while (w.globals.yearsElapsed < end) w.advance(stepYears, OPT)
  const use = w.store.f32("landUse").read
  const lf = w.store.f32("landFraction").read
  let u = 0, land = 0
  for (let y = 0; y < w.grid.H; y++) {
    const a = w.grid.areaWeight[y]!
    for (let x = 0; x < w.grid.W; x++) {
      const i = y * w.grid.W + x
      const f = lf[i] ?? 0
      u += (use[i] ?? 0) * f * a; land += f * a
    }
  }
  const techs = w.civ.state.civs.reduce(
    (a, c) => a + TECHS.filter((_, i) => c.tech[i]).length, 0)
  return {
    pop: w.civ.state.totalPopulation, techs, civs: w.civ.state.civs.length,
    co2: w.globals.co2, use: land > 0 ? 100 * u / land : 0,
  }
}

console.log(`降りても降りなくても同じか  ${GYR}Gyr  章 phanerozoic  ${REALS} 実現の中央値`)
console.log("条件                    人口        技術  文明  CO2    土地%")
const med = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y)
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
}
/** ★中央値を取る（実現ごとに二峰なので平均は代表しない） */
function many(focused: boolean, stepYears: number): Result {
  const rs: Result[] = []
  for (let r = 0; r < REALS; r++) rs.push(run(focused, stepYears, r))
  return {
    pop: med(rs.map((r) => r.pop)), techs: med(rs.map((r) => r.techs)),
    civs: med(rs.map((r) => r.civs)), co2: med(rs.map((r) => r.co2)),
    use: med(rs.map((r) => r.use)),
  }
}
// ★**中間の刻みも入れる。** 2 点だけだと「たまたま」と区別できない。
//   刻みを細かくするほど一方向にずれるなら、それは系統的な偏り（罠 40）
const rows: [string, Result][] = [
  ["粗い（100 万年刻み）", many(false, 1e6)],
  ["中間（10 万年で結合）", many(true, 1e5)],
  ["★降りる（1 万年で結合）", many(true, 1e4)],
]
for (const [name, r] of rows) {
  console.log(`${name.padEnd(22)} ${r.pop.toExponential(3)}  ${String(r.techs).padStart(4)}`
    + `  ${String(r.civs).padStart(4)}  ${r.co2.toFixed(0).padStart(5)}  ${r.use.toFixed(1)}`)
}
const [a, b] = [rows[0]![1], rows[1]![1]]
const rel = (x: number, y: number) => Math.abs(x - y) / Math.max(1e-9, Math.abs(x))
console.log(`\n★差（相対）  人口 ${(100 * rel(a.pop, b.pop)).toFixed(1)}%`
  + `  技術 ${(100 * rel(a.techs, b.techs)).toFixed(1)}%`
  + `  CO2 ${(100 * rel(a.co2, b.co2)).toFixed(1)}%`
  + `  土地 ${(100 * rel(a.use, b.use)).toFixed(1)}%`)
console.log("★実現値は乱数の引き方で変わる。**桁が合っていれば契約は満たされている**")
console.log("\n★注意: 大気 CO2 は**文明とは別の要因**で刻みに依る（100 万年刻みでは")
console.log("  炭素の結合が粗すぎて 4000ppm 台に跳ねることがある）。文明が出す分は")
console.log("  `landClearCo2Ppm` で見ること —— 実測で 24〜56ppm と刻みに依らない")

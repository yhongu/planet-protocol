/**
 * tests/tectonics.test.ts の「LIP が LLSVP の縁の通過で起きる」の検出力を測る。
 *
 * 発生確率は露出度 frac に比例する（maybeTriggerLip）。
 * だが frac の変動が小さいと、平均の差が標本誤差に埋もれる。
 *
 *   npx vite-node scripts/probes/probe-lip.ts [--seeds 6]
 */
import { World } from "../../src/sim/world"

const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
const N = Number(process.argv[process.argv.indexOf("--seeds") + 1] || 6)
const SEEDS = ["hadean-01", "hadean-02", "hadean-03", "s4", "s5", "s6", "s7", "s8"].slice(0, N)

const sd = (a: number[]) => {
  const m = a.reduce((s, v) => s + v, 0) / a.length
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length)
}

console.log(`LIP テストの検出力  250 ステップ x 1.5Myr  lipRate 3e-8`)
console.log(` seed        LIP数  全体平均   LIP時平均      差      露出のSD  差/SE   判定`)
let pass = 0
const xs: number[] = [], ys: number[] = []
for (const seed of SEEDS) {
  const w = new World({ climateCouplingYears: 500_000, width: 64, height: 32,
    seed, shared: false, tectonics: { lipRate: 3e-8 } })
  const ex: number[] = [], atLip: number[] = []
  let n = 0
  for (let i = 0; i < 250; i++) {
    w.advance(1.5e6, OPT)
    const e = w.tectonics.pgzExposure(w)
    ex.push(e)
    const m = w.events.filter((v) => v.kind === "lip").length
    if (m > n) { atLip.push(e); n = m }
  }
  const mean = ex.reduce((s, v) => s + v, 0) / ex.length
  const mAt = atLip.length ? atLip.reduce((s, v) => s + v, 0) / atLip.length : NaN
  const s = sd(ex)
  const se = s / Math.sqrt(Math.max(1, atLip.length))
  const z = (mAt - mean) / Math.max(1e-30, se)
  const ok = mAt > mean
  if (ok) pass++
  xs.push(mean); ys.push(n)
  console.log(`  ${seed.padEnd(10)} ${String(n).padStart(4)}  ${mean.toFixed(5)}  ` +
    `${mAt.toFixed(5)}  ${(mAt - mean >= 0 ? "+" : "") + (mAt - mean).toFixed(5)}  ` +
    `${s.toFixed(5)}  ${z.toFixed(2).padStart(6)}   ${ok ? "PASS" : "FAIL"}`)
}
console.log(`\n  ${pass}/${SEEDS.length} seed で PASS`)
console.log(`  差/SE が 2 未満なら、そのテストは【偶然で符号が決まる】`)

// seed 間で見る: 露出度が高い惑星ほど LIP が多いか
const mx = xs.reduce((s, v) => s + v, 0) / xs.length
const my = ys.reduce((s, v) => s + v, 0) / ys.length
let sxy = 0, sxx = 0, syy = 0
for (let i = 0; i < xs.length; i++) {
  sxy += (xs[i] - mx) * (ys[i] - my)
  sxx += (xs[i] - mx) ** 2
  syy += (ys[i] - my) ** 2
}
const r = sxy / Math.sqrt(Math.max(1e-30, sxx * syy))
console.log(`\n★ seed 間の相関（露出度の平均 vs LIP 数）: r = ${r.toFixed(3)}  n = ${xs.length}`)
// 露出度の上下半分で LIP 数の平均を比べる
const ord = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b])
const half = Math.floor(xs.length / 2)
const lo = ord.slice(0, half).map((i) => ys[i])
const hi = ord.slice(-half).map((i) => ys[i])
const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length
console.log(`  露出度の低い方 ${half} 個の LIP 数 平均 ${avg(lo).toFixed(1)}`)
console.log(`  露出度の高い方 ${half} 個の LIP 数 平均 ${avg(hi).toFixed(1)}`)
console.log(`  -> 比 ${(avg(hi)/Math.max(1e-30,avg(lo))).toFixed(2)} 倍`)

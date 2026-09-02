/**
 * **全史で出来事が何回・いつ起きるか**を数える（`docs/05` M4.7 #5 の判断材料）。
 *
 * フェーズ1 の合格条件は「生命抜きで 45 億年を眺めて面白いか」。
 * ★**出来事が少なすぎれば「次の出来事まで進める」は空振りになり、
 * 多すぎれば止まってばかりで進まない。** どちらかを数えてから決める。
 *
 *   npx vite-node scripts/probes/probe-events.ts [--width 64] [--seed audit]
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const W = Number(arg("width", "64")), H = W >> 1
const SEED = arg("seed", "audit")
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

const w = new World({
  width: W, height: H, seed: SEED, shared: false,
  startEpoch: "hadean", climateCouplingYears: 200_000,
})
// ★出来事の閾値を当てずっぽうで決めないため、判定に使う量の分布も測る
const disp: number[] = [], ice: number[] = [], sea: number[] = []
while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
  w.advance(400_000, OPT)
  disp.push(w.tectonics.dispersion(w))
  ice.push(w.stats!.iceFraction)
  sea.push(w.globals.seaLevel)
}
const pct = (a: number[], f: number) => {
  const s2 = [...a].sort((x, y) => x - y)
  return s2[Math.min(s2.length - 1, Math.floor(s2.length * f))]
}
const line = (name: string, a: number[], d = 3) =>
  console.log(`  ${name.padEnd(10)} P5 ${pct(a, 0.05).toFixed(d)}  P25 ${pct(a, 0.25).toFixed(d)}` +
    `  中央 ${pct(a, 0.5).toFixed(d)}  P75 ${pct(a, 0.75).toFixed(d)}  P95 ${pct(a, 0.95).toFixed(d)}`)
console.log("判定に使う量の分布（全史）")
line("分散度", disp)
line("氷", ice)
line("海面m", sea, 0)

const byKind = new Map<string, number>()
for (const e of w.events) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1)
// 5 億年ごとの分布（時間軸に均等かどうか）
const BUCKETS = 9
const hist = new Array(BUCKETS).fill(0)
for (const e of w.events) {
  hist[Math.min(BUCKETS - 1, Math.floor(e.year / (PLANET_AGE_YEARS / BUCKETS)))]++
}
console.log(`seed ${SEED}  ${W}x${H}  出来事 ${w.events.length} 件 / 4.54Gyr`)
console.log(`  種類別: ${[...byKind].map(([k, v]) => `${k} ${v}`).join("  ")}`)
console.log(`  0.5Gyr ごと: ${hist.join(" / ")}`)
// 「次の出来事まで」で 1 回に飛ぶ年数（＝待ち時間）の分布
const gaps: number[] = []
let prev = 0
for (const e of w.events) { gaps.push(e.year - prev); prev = e.year }
gaps.sort((a, b) => a - b)
const q = (f: number) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * f))]
console.log(`  出来事の間隔 [Myr]: 中央 ${(q(0.5) / 1e6).toFixed(0)}` +
  `  P90 ${(q(0.9) / 1e6).toFixed(0)}  最大 ${(gaps[gaps.length - 1] / 1e6).toFixed(0)}`)
console.log(`  ×20（2Myr/秒）なら 1 回の待ちは 中央 ${(q(0.5) / 2e6).toFixed(1)} 秒` +
  `  P90 ${(q(0.9) / 2e6).toFixed(1)} 秒  最大 ${(gaps[gaps.length - 1] / 2e6).toFixed(0)} 秒`)
for (const e of w.events.slice(0, 6)) {
  console.log(`    ${(e.year / 1e6).toFixed(0).padStart(5)}Myr [${e.kind}] ${e.text.slice(0, 60)}`)
}

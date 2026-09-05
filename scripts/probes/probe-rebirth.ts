/**
 * **全滅から生命が戻ってくるか**を確かめる。
 *
 * ★それまで前生命化学は `originYear < 0`、つまり**一度でも生命が生まれたら
 * 永久に停止**していた。LUCA の再誕も `history` が空のときだけだったので、
 * **全滅すると 45.4 億年の行き止まり**だった。
 *
 * 止める理由を「一度起きたから」ではなく**「いま生命がいるから」**に直した
 * （ダーウィンの "warm little pond" —— 既にいる生命が有機物を食べてしまう）。
 *
 *   npx vite-node scripts/probes/probe-rebirth.ts [--seed g01] [--kill 2.0]
 *
 * `--kill` の年代（Ga）で全クレードを殺し、その後を追う。
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const W = Number(arg("width", "64")), H = W >> 1
const SEED = arg("seed", "g01")
const KILL_GA = Number(arg("kill", "2.0"))
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

const w = new World({
  width: W, height: H, seed: SEED, shared: false, startEpoch: "hadean",
  climateCouplingYears: 200_000,
})
const killAt = PLANET_AGE_YEARS - KILL_GA * 1e9
let killed = false
let seen = 0
console.log(`全滅からの復帰  ${W}x${H}  seed ${SEED}  ${KILL_GA}Ga で全滅させる`)
while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
  w.advance(400_000, OPT)
  if (!killed && w.globals.yearsElapsed >= killAt && w.life.clades.length > 0) {
    // ★**全クレードを消す。** 介入（隕石を何発も）で起きうる状態を直接作る
    const n = w.grid.cellCount
    const bio = w.store.f32("biomass").read
    for (const c of w.life.clades) bio.fill(0, c.lane * n, c.lane * n + n)
    w.life.clades.length = 0
    killed = true
    console.log(`  ${KILL_GA.toFixed(2)}Ga  ★全クレードを消した`)
  }
  for (const e of w.events.slice(seen)) {
    if (/起源|全滅|大量絶滅/.test(e.text)) {
      const ga = (PLANET_AGE_YEARS - e.year) / 1e9
      console.log(`  ${ga.toFixed(2)}Ga  ${e.text}`)
    }
  }
  seen = w.events.length
}
console.log(`\n終了時  クレード ${w.life.clades.length}  生物圏 ${w.globals.biosphereProxy.toFixed(2)}`
  + `  O2 ${w.globals.o2.toExponential(1)}`)
console.log(killed && w.life.clades.length > 0
  ? "★生命は戻ってきた" : killed ? "★戻らなかった（行き止まりのまま）" : "全滅させられなかった")

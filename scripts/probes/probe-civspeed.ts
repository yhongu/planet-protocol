/**
 * ★**降りたときに、本当に時間が進むか**（2026-09-09）。
 *
 * `simWorker` と同じ式で 1 秒ぶんを回し、**1 秒に何年進むか**を測る。
 * ★止まる罠が 2 つある —— (a) 結合間隔が粗いと `step = max(刻み, 結合)` が
 * 大きくなって年が溜まらない、(b) `SubsystemLoop` が
 * `min(preferredStepYears)` に合わせるので刻みが細かすぎると throttle する。
 *
 *   npx vite-node scripts/probes/probe-civspeed.ts
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { loadWorld } from "../../src/sim/snapshot"
import { couplingForSpeed, tickYears } from "../../src/sim/loop"
import { GENE_KINDS } from "../../src/sim/genome"

const OPT = { cgTol: 1e-2, maxOuter: 8, tol: 1e-4 } as const
const C_SYMBOLIC = GENE_KINDS.indexOf("capSymbolic")

console.log("降りたときに 1 秒で何年進むか（★段の年/秒と一致するはず）")
console.log("降下  倍率  段[年/秒]  結合[yr]  刻み[yr]  実際に進んだ[年]  壁時計[ms]")
for (const focused of [false, true]) {
  for (const mult of [1, 20]) {
    const w = loadWorld(new Uint8Array(gunzipSync(
      readFileSync("public/chapters/phanerozoic.gaia"))))
    w.civ.params.enabled = 1
    // 知性を入れて文明を動かす（降下の意味があるのはこのときだけ）
    const tot = w.store.f32("biomassTotal").read
    let best = -1, bv = 0
    for (let i = 0; i < w.grid.cellCount; i++) if (tot[i]! > bv) { bv = tot[i]!; best = i }
    if (best >= 0) w.intervene("injectGene", 1, best, C_SYMBOLIC)
    w.civ.focused = focused
    const yps = w.yearsPerSecond(mult)
    const coupling = couplingForSpeed(mult, focused)
    w.climateCouplingYears = coupling
    const step = Math.max(tickYears(yps), coupling)
    // ★ワーカーと同じ: 1 秒ぶんの年数を貯めて、step ごとに進める
    const before = w.globals.yearsElapsed
    const t0 = Date.now()
    let bank = yps
    let n = 0
    while (bank >= step && n < 10000) { w.advance(step, OPT); bank -= step; n++ }
    const got = w.globals.yearsElapsed - before
    console.log(`${(focused ? "降りる" : "惑星").padEnd(6)} ×${String(mult).padStart(2)}`
      + `  ${yps.toExponential(1).padStart(9)}  ${String(coupling).padStart(8)}`
      + `  ${String(step).padStart(8)}  ${got.toExponential(2).padStart(15)}`
      + `  ${String(Date.now() - t0).padStart(9)}`)
  }
}
console.log("★実際に進んだ年数が段の年/秒とほぼ一致し、壁時計が 1000ms 未満なら合格")

/**
 * ★★**発明と失伝を、人口を固定して刻みごとに回す**（時間解像度の独立性）。
 *
 * `probe-focus.ts` は惑星ぜんぶが動くので、差が出ても原因を特定できない（罠 59）。
 * ここは**1 変数だけ** —— 人口を固定し、技術の得失だけを刻みを変えて回す。
 *
 * A: 直す前（発明の抽選 → 失伝の抽選。どちらも `1−exp(−λdt)`）
 * B: 直した後（2 状態のマルコフ連鎖を解析で解く）
 */
import { Civilization, techLossLambda } from "../../src/sim/civilization"
import {
  TECHS, TECH_PREREQ, sumTech, techPrereqOk, techGateOk, type PlanetGate,
} from "../../src/sim/tech"
import { Rng } from "../../src/core/rng"

const TOTAL = 3e7
const POP = 1e6
const STEPS = [1e4, 1e5, 1e6]
const TRIALS = 20
const planet: Record<PlanetGate, number> =
  { o2: 21, felsic: 1e10, land: 0.3, river: 1, ocean: 0.7, buriedC: 1e20 }
const P = new Civilization({ enabled: 1 }).params

/** ★A: 直す前の書き方（2 段の抽選）。**この形が刻みに依った** */
function oldStep(has: boolean[], pop: number, dt: number, rng: Rng): void {
  const retain = 1 + sumTech(has).retention
  for (let k = 0; k < TECHS.length; k++) {
    if (has[k] || !techPrereqOk(has, k) || !techGateOk(k, planet)) continue
    if (rng.nextFloat() < 1 - Math.exp(-P.inventionRate * pop * dt)) has[k] = true
  }
  for (let k = 0; k < TECHS.length; k++) {
    if (!has[k]) continue
    let inUse = false
    for (let j = 0; j < TECHS.length && !inUse; j++) {
      if (!has[j]) continue
      for (const g of TECH_PREREQ[j]!) {
        if (!g.includes(k)) continue
        let others = 0
        for (const a of g) if (a !== k && has[a]) others++
        if (others === 0) { inUse = true; break }
      }
    }
    if (inUse) continue
    const l = techLossLambda(TECHS[k]!.complexity, pop, retain, P.lossRate, P.lossPopRef)
    if (rng.nextFloat() < 1 - Math.exp(-l * dt)) has[k] = false
  }
}

function run(scheme: "A" | "B", dt: number): number {
  let sum = 0
  for (let t = 0; t < TRIALS; t++) {
    const c = new Civilization({ enabled: 1 }, `t${t}`)
    const has = new Array<boolean>(TECHS.length).fill(false)
    const civ = {
      id: 1, foundedYear: 0, population: POP, energyPerCapita: 300,
      tech: has, techOrigin: new Array<number>(TECHS.length).fill(-1),
      peakPopulation: POP, lostCount: 0,
    }
    const ev = (c as unknown as {
      evolveTech: (a: unknown, b: unknown, e: unknown, d: number) => void
    }).evolveTech.bind(c)
    const rng = new Rng(`old:${t}`)
    for (let y = 0; y < TOTAL; y += dt) {
      if (scheme === "B") ev(civ, planet, sumTech(has), dt)
      else oldStep(has, POP, dt, rng)
    }
    sum += has.filter(Boolean).length
  }
  return sum / TRIALS
}

console.log(`人口 ${POP.toExponential(0)} を固定して ${(TOTAL / 1e6).toFixed(0)} 百万年`
  + `　${TRIALS} 試行の平均`)
console.log("★刻みを 100 倍変えても【保有技術数】は同じはず（発明の【回数】は違ってよい）")
console.log("刻み[yr]   A 直す前   B 直した後")
for (const dt of STEPS) {
  console.log(`${dt.toExponential(0).padStart(8)}   ${run("A", dt).toFixed(2).padStart(8)}`
    + `   ${run("B", dt).toFixed(2).padStart(10)}`)
}

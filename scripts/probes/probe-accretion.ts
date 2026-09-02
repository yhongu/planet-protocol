/**
 * 付加の強さ（accretionBonus）を振って全史の陸地統計を比べる。
 *
 * bonus = 0 は「偏りなし」= 付加を入れる前のコードと数学的に同一。
 * これを基準に置いて、偏らせることの効果だけを見る。
 *
 *   npx vite-node scripts/probes/probe-accretion.ts [--width 64] [--bonus 0,2]
 *
 * 監査の D 節と同じ測り方をする（面積重み・軌跡の中央値）。
 * 全史 1 本は 64x32 で約 300 秒。並走させないこと。
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? process.argv[i + 1] : d
}
const W = Number(arg("width", "64")), H = W >> 1
const BONUS = arg("bonus", "0,2").split(",").map(Number)
// 気候と炭素の結合間隔 [yr]。監査は 200kyr、既定は 50kyr。
// これで陸地面積が 5 倍変わるので、必ず明示して比べる。
const COUPLING = Number(arg("coupling", "50000"))
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
const pct = (a: number[], f: number) => {
  const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]
}

type Out = { bonus: number; land: number; p95: number; elev: number; co2: number; temp: number
  arc: number; weld: number; rift: number; ero: number }
const rows: Out[] = []

for (const bonus of BONUS) {
  const w = new World({ width: W, height: H, seed: "audit", shared: false,
    startEpoch: "hadean", climateCouplingYears: COUPLING })
  w.tectonics.params.accretionBonus = bonus
  const land: number[] = [], elev: number[] = [], co2: number[] = [], temp: number[] = []
  const t0 = Date.now()
  const sample = () => {
    const el = w.store.f32("elevation").read
    const sea = w.globals.seaLevel
    let a = 0, es = 0
    for (let y = 0; y < H; y++) {
      const aw = w.grid.areaWeight[y]
      for (let x = 0; x < W; x++) {
        const v = el[y * W + x]
        if (v < sea) continue
        a += aw; es += (v - sea) * aw
      }
    }
    land.push(100 * a); elev.push(a > 0 ? es / a : 0)
    co2.push(w.globals.co2); temp.push(w.stats!.meanT)
  }
  sample()
  while (w.globals.yearsElapsed < PLANET_AGE_YEARS) { w.advance(400_000, OPT); sample() }
  const b = w.tectonics.budget
  rows.push({ bonus, land: med(land), p95: pct(land, 0.95), elev: med(elev),
    co2: med(co2), temp: med(temp),
    arc: b.arc / 1e9, weld: b.accretion / 1e9, rift: b.rift / 1e9, ero: b.erosion / 1e9 })
  console.log(`  bonus ${bonus}: 陸 ${med(land).toFixed(1)}%  標高 ${med(elev).toFixed(0)}m  ` +
    `CO2 ${med(co2).toFixed(0)}  (${((Date.now()-t0)/1000).toFixed(0)}秒)`)
}

console.log(`\n全史 ${W}x${H}  seed audit  結合間隔 ${COUPLING/1000}kyr  軌跡の中央値`)
console.log(`  bonus   陸%   陸P95    標高m      CO2   気温C |  島弧  縫合  リフト   侵食 [1e9km³]`)
for (const r of rows) {
  console.log(`  ${String(r.bonus).padStart(5)}  ${r.land.toFixed(1).padStart(4)}  ` +
    `${r.p95.toFixed(1).padStart(5)}  ${r.elev.toFixed(0).padStart(6)}  ` +
    `${r.co2.toFixed(0).padStart(7)}  ${r.temp.toFixed(1).padStart(6)} | ` +
    `${r.arc.toFixed(2).padStart(5)}  ${r.weld.toFixed(2).padStart(5)}  ` +
    `${r.rift.toFixed(2).padStart(6)}  ${r.ero.toFixed(2).padStart(6)}`)
}
console.log(`\n  目標: 陸 25〜35%  標高 600〜1100m  CO2 280前後  気温 12〜18C`)
console.log(`  基準（WORK-IN-PROGRESS の付加なし 64x32）: 陸 20.2%  CO2 4209`)

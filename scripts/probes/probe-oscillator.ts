/**
 * 陸地の振動を起こしている機構を特定する。
 *
 * 堆積の受け皿を直しても振れ幅は 12〜34 ポイントのまま残った。
 * つまり受け皿は「沈んだ大陸の帯」の原因ではあったが、振動の原因ではない。
 * 気候→侵食→地形→風化→気候 の環のどこを切ると振動が止まるかを見る。
 */
import { World, PLANET_AGE_YEARS } from "../src/sim/world"

const W = 64, H = 32
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const STEP = 4e6

type Case = { name: string; tect?: Record<string, number>; hydro?: Record<string, number> }
const CASES: Case[] = [
  { name: "基準(受け皿1.0)", tect: { shelfMinFactor: 1.0 } },
  { name: "氷河侵食なし", tect: { shelfMinFactor: 1.0 }, hydro: { glacialErosion: 0 } },
  { name: "超大陸周期なし", tect: { shelfMinFactor: 1.0, supercontinentHalfPeriod: 1e12 } },
  { name: "侵食なし", tect: { shelfMinFactor: 1.0, denudationRate: 0 } },
  { name: "造山を弱く", tect: { shelfMinFactor: 1.0, orogenyRate: 1 } },
]

console.log(`振動源の切り分け  ${W}x${H}  全史 4.54Gyr  seed hadean-01`)
console.log("条件            最終陸%  CO2    T   | 直近2Gyr 陸% 平均 最小-最大 (振れ幅)")
for (const c of CASES) {
  const w = new World({
    width: W, height: H, seed: "hadean-01", shared: false, startEpoch: "hadean",
    tectonics: c.tect, hydro: c.hydro,
  })
  const hist: number[] = []
  while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
    w.advance(STEP, OPT)
    if (w.globals.yearsElapsed > PLANET_AGE_YEARS - 2e9) {
      hist.push(100 * w.grid.areaFractionWhere(w.store.f32("elevation").read, (v) => v >= 0))
    }
  }
  const land = 100 * w.grid.areaFractionWhere(w.store.f32("elevation").read, (v) => v >= 0)
  const mn = Math.min(...hist), mx = Math.max(...hist)
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length
  console.log(`${c.name.padEnd(15)} ${land.toFixed(1).padStart(5)} ${w.globals.co2.toFixed(0).padStart(6)} ` +
    `${w.stats!.meanT.toFixed(1).padStart(5)} | ${mean.toFixed(1).padStart(5)} ` +
    `${mn.toFixed(1).padStart(5)} -${mx.toFixed(1).padStart(6)} (${(mx-mn).toFixed(1).padStart(5)})`)
}

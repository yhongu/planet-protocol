/**
 * 陸%・大陸体積・厚さ分位の時系列そのものを見る。
 *
 * 統計だけでは「振動」と「ゆっくりしたドリフト」を取り違える。
 * 自己相関に周期のピークが立たなかったので、生の形を確認する。
 */
import { World, PLANET_AGE_YEARS } from "../src/sim/world"
import { writeFileSync } from "node:fs"

const W = 64, H = 32
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const STEP = 4e6
const LAND_THICK = 4.8 / 0.1515

const w = new World({ width: W, height: H, seed: "hadean-01", shared: false, startEpoch: "hadean" })
const rows: number[][] = []
while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
  w.advance(STEP, OPT)
  const el = w.store.f32("elevation").read
  const th = w.store.f32("crustThickness").read
  const s = [...th].sort((a, b) => a - b)
  const q = (f: number) => s[Math.floor(f * s.length)]
  rows.push([
    w.globals.yearsElapsed / 1e6,
    100 * w.grid.areaFractionWhere(el, (v) => v >= w.globals.seaLevel),
    w.tectonics.diag.continentalVolume / 1e9,
    q(0.90), q(0.95), q(0.75),
    w.globals.seaLevel, w.globals.co2, w.stats!.meanT,
  ])
}
writeFileSync("/tmp/series.csv",
  "t_Myr,land_pct,vCont,p90,p95,p75,sea,co2,T\n" + rows.map((r) => r.join(",")).join("\n"))

// --- ASCII で形を見る ---
function plot(title: string, col: number, h = 14): void {
  const v = rows.map((r) => r[col])
  const lo = Math.min(...v), hi = Math.max(...v)
  const cols = 100
  const grid: string[][] = Array.from({ length: h }, () => new Array(cols).fill(" "))
  for (let c = 0; c < cols; c++) {
    const i = Math.floor(c * (v.length - 1) / (cols - 1))
    const y = hi > lo ? Math.round((h - 1) * (1 - (v[i] - lo) / (hi - lo))) : h - 1
    grid[y][c] = "*"
  }
  console.log(`\n${title}   [${lo.toFixed(1)} .. ${hi.toFixed(1)}]`)
  for (const r of grid) console.log("  |" + r.join(""))
  console.log("  +" + "-".repeat(cols))
  console.log(`   4540Ma${" ".repeat(cols - 14)}0Ma`)
}
plot("陸% ", 1)
plot("大陸地殻の体積 [1e9 km3]", 2)
plot("厚さ P90 [km]（陸海閾値は 31.7km）", 3)
plot("海面 [m]", 6)
console.log("\n/tmp/series.csv に保存")

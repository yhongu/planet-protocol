/**
 * 炭素収支の監査。
 *
 * 地殻を疑って長く調べたが、地殻は健全だった（陸% 中央値 29.1%、
 * 厚さ標準偏差 8.1km は地球の 6-8km と同等）。
 * 実際の破綻は最後の 8000 万年に起きる暴走温室で、その手前で
 * CO2 が 280ppm まで下がらず約 2000ppm で止まることが原因。
 * サーモスタットのどこが詰まっているかを測る。
 */
import { World, PLANET_AGE_YEARS } from "../src/sim/world"

const W = 64, H = 32
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const STEP = 4e6

const w = new World({ width: W, height: H, seed: "hadean-01", shared: false, startEpoch: "hadean" })
console.log("炭素収支の監査  64x32  全史")
console.log("Ga前   S比   CO2      T     陸%  |  火山   陸風化 海底風化  正味  | 供給律速% レゴリス 侵食平均")
const marks = [4.5,4.0,3.5,3.0,2.5,2.0,1.5,1.0,0.7,0.5,0.3,0.2,0.15,0.1,0.05,0.02,0.0]
let mi = 0
while (w.globals.yearsElapsed < PLANET_AGE_YEARS && mi < marks.length) {
  const ga = (PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9
  if (ga <= marks[mi]) {
    const f = w.carbon.lastFluxes
    const reg = w.store.f32("weatheringRegime").read
    const rego = w.store.f32("regolith").read
    const ero = w.store.f32("erosionRate").read
    const el = w.store.f32("elevation").read
    let sup = 0, land = 0, rsum = 0, esum = 0
    for (let y = 0; y < H; y++) {
      const aw = w.grid.areaWeight[y]
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (el[i] < w.globals.seaLevel) continue
        land += aw; sup += reg[i] * aw; rsum += rego[i] * aw; esum += ero[i] * aw
      }
    }
    console.log(`${ga.toFixed(2).padStart(5)} ${(w.globals.solarConstant/1361).toFixed(2)} ` +
      `${w.globals.co2.toFixed(0).padStart(7)} ${w.stats!.meanT.toFixed(1).padStart(6)} ` +
      `${(100*land).toFixed(1).padStart(5)}  | ` +
      `${(f?.volcanic ?? 0).toFixed(3).padStart(6)} ${(f?.land ?? 0).toFixed(3).padStart(7)} ` +
      `${(f?.seafloor ?? 0).toFixed(3).padStart(7)} ${(f?.net ?? 0).toFixed(3).padStart(7)} | ` +
      `${land > 0 ? (100*sup/land).toFixed(0).padStart(8) : "     -"} ` +
      `${land > 0 ? (rsum/land).toFixed(2).padStart(8) : "     -"} ` +
      `${land > 0 ? (esum/land).toExponential(1).padStart(9) : "     -"}`)
    mi++
  }
  w.advance(STEP, OPT)
}
console.log("\n地球の現在: 火山 0.10, 陸風化 0.07, 海底風化 0.03, 正味 0 [任意単位]")
console.log("供給律速% = 風化が供給（レゴリスの生成速度）で頭打ちになっているセルの割合")

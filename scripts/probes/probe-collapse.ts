/**
 * 冥王代の地形崩壊を追う。
 *
 * 全解像度で、スクイッシーリッド -> モバイルリッドの遷移から 1.4 億年で
 * 最高標高が 2351m -> -33m になり、惑星から陸が消える。
 * どの機構が地形を食べているかを landLoss / budget / varLedger で特定する。
 *
 *   npx vite-node scripts/probes/probe-collapse.ts [--width 128] [--until 4.0]
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"
import { MODE_LABEL } from "../../src/sim/mantle"

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? process.argv[i + 1] : d
}
const W = Number(arg("width", "128")), H = W >> 1
const UNTIL = Number(arg("until", "4.0"))            // Ga前
const STEP = 20e6                                    // 2000 万年ごとに見る
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

const w = new World({ width: W, height: H, seed: "audit", shared: false,
  startEpoch: "hadean", climateCouplingYears: 200_000 })

const snap = () => {
  const el = w.store.f32("elevation").read
  const th = w.store.f32("crustThickness").read
  const sea = w.globals.seaLevel
  let a = 0, maxE = -Infinity, tMax = 0, tSum = 0
  for (let y = 0; y < H; y++) {
    const aw = w.grid.areaWeight[y]
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (el[i] > maxE) maxE = el[i]
      if (th[i] > tMax) tMax = th[i]
      tSum += th[i] * aw
      if (el[i] >= sea) a += aw
    }
  }
  const b = w.tectonics.budget, v = w.tectonics.varLedger
  return { land: 100 * a, maxE, tMax, tMean: tSum,
    b: { ...b }, v: { ...v }, d: { ...w.tectonics.diag } }
}

let prev = snap()
console.log(`冥王代の地形崩壊  ${W}x${H}  seed audit  結合 200kyr`)
console.log(` Ga前  様式         陸%  最高標高 最大厚 平均厚 | 体積[1e6km³]      | 厚さ分散の増減[km²] ★どれが潰しているか`)
console.log(`                                              | 島弧 リフト 侵食  | 移流   境界   島弧   侵食  | 再サンプル 体積残差(累積)`)

while ((PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9 > UNTIL) {
  const target = w.globals.yearsElapsed + STEP
  while (w.globals.yearsElapsed < target) {
    const r = w.advance(Math.min(400_000, target - w.globals.yearsElapsed), OPT)
    if (r.yearsAdvanced <= 0) break
  }
  const c = snap()
  const ga = (PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9
  const d = (k: keyof typeof c.b) => ((c.b[k] - prev.b[k]) / 1e6).toFixed(1).padStart(6)
  const dv = (k: keyof typeof c.v) => (c.v[k] - prev.v[k]).toFixed(1).padStart(8)
  console.log(`${ga.toFixed(2).padStart(5)}  ${MODE_LABEL[w.tectonicMode].padEnd(11)} ` +
    `${c.land.toFixed(1).padStart(5)} ${c.maxE.toFixed(0).padStart(8)} ` +
    `${c.tMax.toFixed(0).padStart(6)} ${c.tMean.toFixed(1).padStart(6)} |` +
    `${d("arc")}${d("rift")}${d("erosion")} |` +
    `${dv("advection")}${dv("boundary")}${dv("arc")}${dv("erosion")} | ` +
    `${String(c.d.advectResamples - prev.d.advectResamples).padStart(4)}回  ` +
    `残差 ${(c.d.advectResidual*100).toFixed(4)}%`)
  prev = c
}

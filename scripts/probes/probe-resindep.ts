/**
 * 解像度独立性の測定。
 *
 * 同じ seed を別の格子解像度で走らせ、巨視的な観測量が一致するかを見る。
 * ここがずれていると、生命（セルの上に乗る）を足したときに必ず破綻する。
 */
import { World } from "../src/sim/world"
import { continentalVolume } from "../src/sim/tectonics"
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const

interface Obs { [k: string]: number }
function observe(w: World): Obs {
  const e = w.store.f32("elevation").read
  const c = w.carbon.lastFluxes!
  const P = w.store.f32("precip").read
  const D = w.store.f32("discharge").read
  let pSum = 0, pA = 0, dMax = 0
  for (let y = 0; y < w.grid.H; y++) {
    const a = w.grid.cellArea[y]
    for (let x = 0; x < w.grid.W; x++) {
      const i = y * w.grid.W + x
      pSum += P[i] * a; pA += a
      if (D[i] > dMax) dMax = D[i]
    }
  }
  return {
    "陸地面積%": w.grid.areaFractionWhere(e, (v) => v >= 0) * 100,
    "全球平均気温": w.stats!.meanT,
    "氷被覆率": w.stats!.iceFraction,
    "惑星アルベド": w.stats!.planetaryAlbedo,
    "CO2ppm": w.globals.co2,
    "供給律速%": c.supplyLimitedFraction * 100,
    "全球降水mm": pSum / pA,
    "最大流量km3": dMax / 1e9,
    "地殻体積比": continentalVolume(w, w.tectonics.params.continentThreshold) / 1e9,
  }
}

const RES = [[96, 48], [128, 64], [192, 96]] as const
console.log("=== t=0（生成直後）===")
const t0: Obs[] = []
for (const [W, H] of RES) {
  const w = new World({ width: W, height: H, seed: "hadean-01", shared: false })
  t0.push(observe(w))
}
const keys = Object.keys(t0[0])
const head = "指標".padEnd(14) + RES.map(([W, H]) => `${W}x${H}`.padStart(11)).join("") + "   ばらつき"
console.log(head)
for (const k of keys) {
  const vs = t0.map((o) => o[k])
  const mean = vs.reduce((a, b) => a + b, 0) / vs.length
  const spread = mean !== 0 ? (Math.max(...vs) - Math.min(...vs)) / Math.abs(mean) : 0
  console.log(k.padEnd(14) + vs.map((v) => v.toFixed(2).padStart(11)).join("") +
    `   ${(spread * 100).toFixed(1)}%`)
}

console.log("\n=== 48 Myr 後 ===")
const t1: Obs[] = []
for (const [W, H] of RES) {
  const w = new World({ width: W, height: H, seed: "hadean-01", shared: false })
  for (let i = 0; i < 60; i++) w.advance(800e3, OPT)
  t1.push(observe(w))
}
console.log(head)
for (const k of keys) {
  const vs = t1.map((o) => o[k])
  const mean = vs.reduce((a, b) => a + b, 0) / vs.length
  const spread = mean !== 0 ? (Math.max(...vs) - Math.min(...vs)) / Math.abs(mean) : 0
  console.log(k.padEnd(14) + vs.map((v) => v.toFixed(2).padStart(11)).join("") +
    `   ${(spread * 100).toFixed(1)}%`)
}

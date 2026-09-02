/**
 * 赤道-極の温度差が高 CO2 で潰れる問題を測る。
 *
 *   npx vite-node scripts/probes/probe-gradient.ts
 *
 * 【症状】冥王代の CO2（10 万 ppm）で惑星が 0.1K 以内の等温になる。
 * そのせいで熱塩循環が生まれた瞬間に塩分枝に落ち、全史で戻らない。
 *
 * 【原因】湿潤熱輸送のパラメタリゼーション
 *   D_eff = D·(1 + kMoist·(exp((T−T0)/Tq) − 1))
 * が指数関数なので、78℃ で 45 倍になる。地球近傍の較正としては妥当だが、
 * **外挿が効かない。**
 *
 * 【観測の拘束】温室気候でも南北勾配はゼロにならない。始新世（平均 +10K）で
 * 赤道-極の海面水温差は 15〜20K（現在 25〜28K）。金星のような等温は、
 * 厚い大気の全球対流が効く極限であって、地球型の惑星では起きない。
 */
import { World } from "../../src/sim/world"

const arg = (k: string, d: number) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? Number(process.argv[i + 1]) : d
}
const W = arg("width", 64), H = W >> 1

const w = new World({ width: W, height: H, seed: "audit", shared: false,
  climateCouplingYears: 5e5 })
const rowAt = (lat: number) => {
  let b = 0
  for (let k = 0; k < H; k++) {
    if (Math.abs(w.grid.latDeg[k] - lat) < Math.abs(w.grid.latDeg[b] - lat)) b = k
  }
  return b
}
const rowT = (y: number) => {
  const T = w.store.f32("surfaceTemp").read
  let s = 0
  for (let x = 0; x < W; x++) s += T[y * W + x]
  return s / W
}
const yEq = rowAt(0), yPole = rowAt(85)

console.log("■ いまの式  D_eff = D·(1 + kMoist·(exp((T−T0)/Tq) − 1))")
console.log("CO2[ppm]  全球平均T  赤道T   極T   赤道−極   D_eff(赤道)")
for (const co2 of [280, 1000, 4000, 20000, 100000]) {
  w.globals.co2 = co2
  w.solveClimate({ maxOuter: 300, tol: 1e-5 })
  const te = rowT(yEq), tp = rowT(yPole)
  const p = w.params
  const raw = Math.max(0, Math.exp((te - p.T0) / p.Tq) - 1)
  const r = raw / p.moistMax
  const lh = raw > 0 ? raw / Math.pow(1 + r * r * r * r, 0.25) : 0
  const d = p.D * (1 + p.kMoist * lh)
  console.log(`${co2.toString().padStart(7)}  ${w.stats!.meanT.toFixed(1).padStart(8)}  ` +
    `${te.toFixed(1).padStart(6)} ${tp.toFixed(1).padStart(6)}  ${(te - tp).toFixed(1).padStart(7)}  ` +
    `${d.toFixed(2).padStart(9)}`)
}

console.log("\n■ D を直接振ったときの勾配（頭打ちをどこに置くかの目安）")
console.log("CO2 10 万 ppm 固定。D_eff の上限を変えて赤道−極を見る")
console.log("  D_eff の上限   全球平均T   赤道−極")
w.globals.co2 = 100_000
for (const cap of [0.28, 0.6, 1.0, 2.0, 4.0, 8.0, 13.1]) {
  // kMoist を殺して D をその値に固定する（実効拡散係数を直接置く）
  const km = w.params.kMoist
  w.params.kMoist = 0
  const d0 = w.params.D
  w.params.D = cap
  w.solveClimate({ maxOuter: 300, tol: 1e-5 })
  const te = rowT(yEq), tp = rowT(yPole)
  console.log(`  ${cap.toFixed(2).padStart(11)}   ${w.stats!.meanT.toFixed(1).padStart(8)}  ` +
    `${(te - tp).toFixed(1).padStart(8)}`)
  w.params.kMoist = km
  w.params.D = d0
}
console.log("\n地球（現在）の赤道−極は 41K（このモデル・280ppm）。")
console.log("始新世（平均 +10K）の観測は 15〜20K。**温室気候でもゼロにはならない。**")

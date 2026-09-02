/**
 * CO2 が 280ppm まで下がらない原因を切り分ける。
 *
 * 全史ランでは因果が循環している:
 *   陸が少ない -> 風化容量が小さい -> CO2 が高い -> 高温 -> ...
 *   高温 -> 暴走温室 -> 陸が減る（海面・侵食）
 * どちらが先か分からないので、【地形を固定して】切る。
 *
 * 地球の現在の地形のまま、太陽だけを 72% -> 100% に明るくして
 * サーモスタットが CO2 を追随させられるかを見る。
 * 追随できれば炭素循環は健全で、問題は陸の供給側。
 * 追随できなければサーモスタット自体の問題。
 */
import { World } from "../src/sim/world"
import { solarConstantForElapsed } from "../src/sim/state"

const W = 64, H = 32
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

console.log("サーモスタットの追随性  64x32  【地形固定・地球の現在の大陸配置】")
console.log("太陽を暗くして平衡させ、そこから明るくしていく\n")
console.log("太陽比  CO2[ppm]     T[C]   陸%   火山   陸風化 海底風化   正味   供給律速%")

// 地形は固定（テクトニクスを止める）。炭素と気候だけを結合させる。
const w = new World({
  width: W, height: H, seed: "hadean-01", shared: false, enableTectonics: false,
})
const land = 100 * w.grid.areaFractionWhere(w.store.f32("elevation").read, (v) => v >= 0)

for (const ratio of [0.72, 0.78, 0.85, 0.90, 0.94, 0.97, 1.00]) {
  w.globals.solarConstant = 1361 * ratio
  // 各日射で平衡に達するまで十分回す（風化の時定数 20 万年の 100 倍）
  for (let i = 0; i < 60; i++) w.advance(400_000, OPT)
  const f = w.carbon.lastFluxes!
  const reg = w.store.f32("weatheringRegime").read
  const el = w.store.f32("elevation").read
  let sup = 0, la = 0
  for (let y = 0; y < H; y++) {
    const aw = w.grid.areaWeight[y]
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (el[i] < 0) continue
      la += aw; sup += reg[i] * aw
    }
  }
  console.log(`${ratio.toFixed(2).padStart(5)} ${w.globals.co2.toFixed(0).padStart(9)} ` +
    `${w.stats!.meanT.toFixed(1).padStart(8)} ${land.toFixed(1).padStart(5)} ` +
    `${f.volcanic.toFixed(3).padStart(6)} ${f.land.toFixed(3).padStart(8)} ` +
    `${f.seafloor.toFixed(3).padStart(8)} ${f.net.toFixed(4).padStart(8)} ` +
    `${(100*sup/la).toFixed(0).padStart(10)}`)
}
console.log(`\n太陽 100% での期待値: CO2 280ppm  T 14.5C（較正した定常状態）`)
console.log(`太陽 72%（冥王代）での期待値: CO2 は桁で高いはず`)

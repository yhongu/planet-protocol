/**
 * 陸地面積のリミットサイクルを測る。
 *
 * 推測せずに収支を取る。tectonics.budget（地殻体積の出入り）と
 * tectonics.landLoss（陸を失った原因別の面積）を毎サンプル差分で見る。
 */
import { World, PLANET_AGE_YEARS } from "../src/sim/world"
import { MODE_LABEL } from "../src/sim/mantle"

const W = 64, H = 32
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const STEP = 2e6            // 200 万年ずつ進める
const SAMPLE = 25e6         // 2500 万年ごとに記録

const w = new World({ width: W, height: H, seed: "hadean-01", shared: false, startEpoch: "hadean" })

const landPct = () => 100 * w.grid.areaFractionWhere(
  w.store.f32("elevation").read, (v) => v >= w.globals.seaLevel)
/** 陸の平均標高と最高標高 */
function relief(): [number, number] {
  const e = w.store.f32("elevation").read
  let sum = 0, n = 0, max = -Infinity
  for (let i = 0; i < e.length; i++) {
    if (e[i] >= 0) { sum += e[i]; n++ }
    if (e[i] > max) max = e[i]
  }
  return [n > 0 ? sum / n : 0, max]
}

type Snap = Record<string, number>
const snapBudget = (): Snap => ({ ...w.tectonics.budget })
const snapLoss = (): Snap => ({ ...w.tectonics.landLoss })
let pb = snapBudget(), pl = snapLoss()
const d = (now: Snap, prev: Snap, k: string) => now[k] - prev[k]

console.log(`陸のリミットサイクル調査  ${W}x${H}  ${STEP/1e6}Myr刻み / ${SAMPLE/1e6}Myrごと記録`)
console.log("Ga前   陸%   平均m 最高m  CO2      T    氷   |地殻体積の増減 km3|  |陸を失った面積 10^12 m2|")
console.log("                                                造山   リフト  侵食   |侵食   リフト  移流  クランプ")

let nextSample = 0
while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
  if (w.globals.yearsElapsed >= nextSample) {
    const nb = snapBudget(), nl = snapLoss()
    const [mean, max] = relief()
    const ga = (PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9
    console.log(
      `${ga.toFixed(2).padStart(5)} ${landPct().toFixed(1).padStart(5)} ` +
      `${mean.toFixed(0).padStart(6)} ${max.toFixed(0).padStart(6)} ` +
      `${w.globals.co2.toFixed(0).padStart(7)} ${w.stats!.meanT.toFixed(1).padStart(5)} ` +
      `${w.stats!.iceFraction.toFixed(2)} | ` +
      `${(d(nb,pb,"orogeny")/1e9).toFixed(2).padStart(6)} ${(d(nb,pb,"rift")/1e9).toFixed(2).padStart(6)} ` +
      `${(d(nb,pb,"erosion")/1e9).toFixed(2).padStart(6)} | ` +
      `${(d(nl,pl,"erosion")/1e12).toFixed(1).padStart(6)} ${(d(nl,pl,"rift")/1e12).toFixed(1).padStart(6)} ` +
      `${(d(nl,pl,"advection")/1e12).toFixed(1).padStart(6)} ${(d(nl,pl,"clamp")/1e12).toFixed(1).padStart(6)}`)
    pb = nb; pl = nl
    nextSample += SAMPLE
  }
  w.advance(STEP, OPT)
}
console.log(`\n最終: 陸 ${landPct().toFixed(1)}%  CO2 ${w.globals.co2.toFixed(0)}ppm  T ${w.stats!.meanT.toFixed(1)}C  ${MODE_LABEL[w.tectonicMode]}`)

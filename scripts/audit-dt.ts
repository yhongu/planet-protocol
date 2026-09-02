/**
 * 時間刻みの収束確認。★これを先にやるべきだった
 *
 * 炭素循環の応答時定数は約 20 万年で、preferredStepYears は 2.5 万年。
 * だがプローブは 400 万年刻みで回していた。SimLoop のサブステップ上限 16 で
 * 割っても 25 万年で、時定数より粗い。
 * 粗い刻みで積分すれば振動するのは当然なので、まず刻み依存性を見る。
 */
import { World, PLANET_AGE_YEARS } from "../src/sim/world"

const W = 64, H = 32
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

console.log("時間刻みの収束確認  64x32  直近 1Gyr の統計")
console.log("刻み[Myr]  ステップ数   CO2 中央   CO2 P5-P95      T 中央   T sd   陸% 中央  最終T")
// 上限（最も細かい希望刻み x MAX_SUBSTEPS = 40 万年）より【下】を掃引する。
// 上限より上を要求しても全部 40 万年に丸められるので、収束の判定にならない。
for (const stepMyr of [0.025, 0.05, 0.1, 0.2, 0.4]) {
  const STEP = stepMyr * 1e6
  const w = new World({ width: W, height: H, seed: "hadean-01", shared: false, startEpoch: "hadean" })
  const co2: number[] = [], temp: number[] = [], land: number[] = []
  let n = 0
  while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
    w.advance(STEP, OPT); n++
    if (w.globals.yearsElapsed > PLANET_AGE_YEARS - 1e9) {
      co2.push(w.globals.co2); temp.push(w.stats!.meanT)
      land.push(100 * w.grid.areaFractionWhere(
        w.store.f32("elevation").read, (v) => v >= w.globals.seaLevel))
    }
  }
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
  const p = (a: number[], f: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(f * s.length)] }
  const sd = (a: number[]) => { const m = a.reduce((x, y) => x + y, 0) / a.length
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length) }
  console.log(`${stepMyr.toFixed(1).padStart(8)} ${n.toString().padStart(11)} ` +
    `${med(co2).toFixed(0).padStart(9)} ${p(co2,0.05).toFixed(0).padStart(7)}-${p(co2,0.95).toFixed(0).padStart(6)} ` +
    `${med(temp).toFixed(1).padStart(10)} ${sd(temp).toFixed(1).padStart(6)} ` +
    `${med(land).toFixed(1).padStart(9)} ${temp[temp.length-1].toFixed(1).padStart(7)}`)
}
console.log("\n刻みで結果が変わるなら数値的、変わらないならモデルの実挙動。")
console.log("地球の現在: CO2 280ppm  T 15C  陸 29.2%")

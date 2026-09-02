/** 地殻の厚さの収支を測る。「大陸が痩せる」原因の切り分け。 */
import { World } from "../src/sim/world"
import { continentalVolume } from "../src/sim/tectonics"
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
const w = new World({ width: 64, height: 32, seed: "hadean-01", shared: false })
const thick = w.store.f32("crustThickness").read
const landThick = 4.8 / 0.1515
const v0 = continentalVolume(w, w.tectonics.params.continentThreshold)

const hist = (label: string) => {
  const bins = [0, 5, 10, 15, 20, 25, 31.7, 40, 50, 60, 75]
  const counts = new Array(bins.length).fill(0)
  let area = 0
  for (let y = 0; y < w.grid.H; y++) {
    const a = w.grid.cellArea[y]
    for (let x = 0; x < w.grid.W; x++) {
      const t = thick[y * w.grid.W + x]
      let b = 0
      for (let k = 0; k < bins.length; k++) if (t >= bins[k]) b = k
      counts[b] += a
      area += a
    }
  }
  console.log(`${label}  厚さ分布[%]: ` +
    bins.map((b, i) => `${b}km:${((counts[i] / area) * 100).toFixed(0)}`).join(" "))
}

let meanLandElev = () => {
  const e = w.store.f32("elevation").read
  let s = 0, a = 0
  for (let y = 0; y < w.grid.H; y++) {
    const ca = w.grid.cellArea[y]
    for (let x = 0; x < w.grid.W; x++) {
      const i = y * w.grid.W + x
      if (e[i] >= 0) { s += e[i] * ca; a += ca }
    }
  }
  return a > 0 ? s / a : 0
}

hist("t=0    ")
console.log(`陸 ${(w.grid.areaFractionWhere(w.store.f32("elevation").read, v=>v>=0)*100).toFixed(1)}%  平均陸標高 ${meanLandElev().toFixed(0)}m`)

const snap = () => JSON.stringify(w.tectonics.budget)
let prev = JSON.parse(snap())
for (let k = 0; k < 1250; k++) {
  w.advance(800e3, OPT)
  if ((k + 1) % 250 === 0) {
    const cur = JSON.parse(snap()) as Record<string, number>
    const d: string[] = []
    for (const key of Object.keys(cur)) {
      const dv = cur[key] - (prev as Record<string, number>)[key]
      if (Math.abs(dv) > 1e6) d.push(`${key} ${(dv / 1e9).toFixed(3)}`)
    }
    prev = cur
    const e = w.store.f32("elevation").read
    console.log(`  +${((k + 1) * 0.8).toFixed(0)}Myr 陸 ${(w.grid.areaFractionWhere(e, (v) => v >= 0) * 100).toFixed(1)}% ` +
      `平均陸標高 ${meanLandElev().toFixed(0)}m  収支[${d.join("  ")}]`)
  }
}

hist("t=1000Myr")
const b = w.tectonics.budget
const tot = Math.abs(b.orogeny) + Math.abs(b.rift) + Math.abs(b.arc) + Math.abs(b.erosion) + Math.abs(b.clamp)
console.log(`陸 ${(w.grid.areaFractionWhere(w.store.f32("elevation").read, v=>v>=0)*100).toFixed(1)}%  平均陸標高 ${meanLandElev().toFixed(0)}m  体積 ${(continentalVolume(w, w.tectonics.params.continentThreshold)/v0).toFixed(3)}`)
console.log(`\n400 Myr の体積収支 [10^9 km³]  (総移動量 ${(tot/1e9).toFixed(2)})`)
for (const [k2, v] of Object.entries(b)) {
  if (Math.abs(v) < 1) continue
  console.log(`  ${k2.padEnd(12)} ${(v/1e9).toFixed(4).padStart(10)}`)
}
console.log(`\n陸地から外れた総面積: ${(w.tectonics.landLoss.other/5.1e14*100).toFixed(1)}% (全球比、延べ)`)
void landThick

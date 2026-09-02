import { World } from "../src/sim/world"
import { MODE_LABEL } from "../src/sim/mantle"
import { continentalVolume } from "../src/sim/tectonics"
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
const w = new World({ width: 64, height: 32, seed: "hadean-01", shared: false })
const v0 = continentalVolume(w, w.tectonics.params.continentThreshold)
console.log("年代Myr 様式          陸%  最高m  CO2    T[C]  分散  体積")
for (let k = 0; k <= 1250; k++) {
  if (k > 0) w.advance(800e3, OPT)
  if (k % 125 !== 0) continue
  const e = w.store.f32("elevation").read
  let mx = -Infinity
  for (let i = 0; i < e.length; i++) if (e[i] > mx) mx = e[i]
  console.log(
    `${(w.globals.yearsElapsed/1e6).toFixed(0).padStart(6)} ${MODE_LABEL[w.tectonicMode].padEnd(12)} ` +
    `${(w.grid.areaFractionWhere(e, v => v>=0)*100).toFixed(1).padStart(5)} ${mx.toFixed(0).padStart(6)} ` +
    `${w.globals.co2.toFixed(0).padStart(6)} ${w.stats!.meanT.toFixed(1).padStart(6)} ` +
    `${w.tectonics.dispersion(w).toFixed(3)} ${(continentalVolume(w, w.tectonics.params.continentThreshold)/v0).toFixed(3)}`)
}

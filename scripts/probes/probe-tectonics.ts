import { World } from "../src/sim/world"
import { MODE_LABEL } from "../src/sim/mantle"
import { continentalVolume } from "../src/sim/tectonics"
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
const w = new World({ width: 96, height: 48, seed: "hadean-01", shared: false })
console.log(`初期: mode=${MODE_LABEL[w.tectonicMode]}  Tm=${w.mantle.state.temperature.toFixed(0)}C  ` +
  `陸 ${(w.grid.areaFractionWhere(w.store.f32("elevation").read, v => v>=0)*100).toFixed(1)}%  ` +
  `plates=${w.tectonics.plates.length}  LLSVP=${w.tectonics.llsvp.length}`)
console.log("\n年代     様式            Tm[C] 熱流TW 陸%  最高標高 CO2    T[C]  火山  風化  供給律速 LIP")
const step = 800e3
for (let k = 1; k <= 400; k++) {
  w.advance(step, OPT)
  const e = w.store.f32("elevation").read
  const land = w.grid.areaFractionWhere(e, v => v >= 0)
  let mx = -Infinity
  for (let i = 0; i < e.length; i++) if (e[i] > mx) mx = e[i]
  const lips = w.events.filter(ev => ev.kind === "lip").length
  const vol = continentalVolume(w, w.tectonics.params.continentThreshold)
  if (k === 1) (globalThis as Record<string, unknown>).vol0 = vol
  const c = w.carbon.lastFluxes!
  if (k % 25 === 0 || k <= 2)
    console.log(
      `${(w.globals.yearsElapsed/1e6).toFixed(0).padStart(5)}Myr ${MODE_LABEL[w.tectonicMode].padEnd(14)} ` +
      `${w.mantle.state.temperature.toFixed(0).padStart(5)} ${(w.mantle.state.heatFlow/1e12).toFixed(1).padStart(6)} ` +
      `${(land*100).toFixed(1).padStart(5)} ${mx.toFixed(0).padStart(7)} ` +
      `${w.globals.co2.toFixed(0).padStart(6)} ${w.stats!.meanT.toFixed(1).padStart(6)} ` +
      `${(c.volcanic*1000).toFixed(0).padStart(5)} ${((c.land+c.seafloor)*1000).toFixed(0).padStart(5)} ` +
      `${(c.supplyLimitedFraction*100).toFixed(0).padStart(6)}% ${String(lips).padStart(3)} ` +
      `水${w.globals.oceanWaterFraction.toFixed(3)} ` +
      `体積${(vol / ((globalThis as Record<string, unknown>).vol0 as number)).toFixed(3)}`)
}

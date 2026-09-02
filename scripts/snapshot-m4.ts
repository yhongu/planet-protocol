import { writeFileSync, mkdirSync } from "node:fs"
import { World } from "../src/sim/world"
import { LAYERS } from "../src/render/layers"
import { MODE_LABEL } from "../src/sim/mantle"
import { continentalVolume } from "../src/sim/tectonics"
import { encodePng } from "./png"
mkdirSync("snapshots", { recursive: true })
const W = 192, H = 96
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
const w = new World({ width: W, height: H, seed: "hadean-01", shared: false })
const v0 = continentalVolume(w, w.tectonics.params.continentThreshold)
const shot = (tag: string, ids: string[]) => {
  for (const id of ids) {
    const l = LAYERS.find((x) => x.id === id)!
    const rgba = new Uint8ClampedArray(W * H * 4)
    l.render(w.grid, w.store, rgba, 1)
    writeFileSync(`snapshots/m4-${tag}-${id}.png`, encodePng(W, H, rgba))
  }
  const e = w.store.f32("elevation").read
  let mx = -Infinity
  for (let i = 0; i < e.length; i++) if (e[i] > mx) mx = e[i]
  console.log(
    `${tag.padEnd(8)} ${(w.globals.yearsElapsed / 1e6).toFixed(0).padStart(4)}Myr ` +
    `${MODE_LABEL[w.tectonicMode].padEnd(12)} 陸 ${(w.grid.areaFractionWhere(e, (v) => v >= 0) * 100).toFixed(1)}% ` +
    `最高 ${mx.toFixed(0)}m  CO2 ${w.globals.co2.toFixed(0)}ppm  T ${w.stats!.meanT.toFixed(1)}C  ` +
    `体積 ${(continentalVolume(w, w.tectonics.params.continentThreshold) / v0).toFixed(3)}  ` +
    `LIP ${w.events.filter((x) => x.kind === "lip").length}`)
}
console.log("M4 スナップショット (256x128)")
shot("t0", ["plates", "elevation", "crustAge"])
for (let i = 0; i < 75; i++) w.advance(800e3, OPT)
shot("t180", ["plates", "elevation", "crustAge"])
for (let i = 0; i < 75; i++) w.advance(800e3, OPT)
shot("t360", ["plates", "elevation", "regime"])

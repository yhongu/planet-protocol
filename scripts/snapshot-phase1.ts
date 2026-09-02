/** フェーズ1 完成時の記念スナップショット。 */
import { writeFileSync, mkdirSync } from "node:fs"
import { World } from "../src/sim/world"
import { LAYERS } from "../src/render/layers"
import { MODE_LABEL } from "../src/sim/mantle"
import { encodePng } from "./png"
mkdirSync("snapshots", { recursive: true })
const W = 192, H = 96
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
const w = new World({ width: W, height: H, seed: "hadean-01", shared: false })
for (let i = 0; i < 150; i++) w.advance(800e3, OPT)
const e = w.store.f32("elevation").read
let mx = -Infinity
for (let i = 0; i < e.length; i++) if (e[i] > mx) mx = e[i]
console.log(
  `${(w.globals.yearsElapsed / 1e6).toFixed(0)}Myr  ${MODE_LABEL[w.tectonicMode]}  ` +
  `陸 ${(w.grid.areaFractionWhere(e, (v) => v >= 0) * 100).toFixed(1)}%  最高 ${mx.toFixed(0)}m  ` +
  `CO2 ${w.globals.co2.toFixed(0)}ppm  T ${w.stats!.meanT.toFixed(1)}C  ` +
  `分散 ${w.tectonics.dispersion(w).toFixed(3)}  出来事 ${w.events.length}`)
for (const id of ["elevation", "temperature", "discharge", "regime", "plates", "crustAge"]) {
  const l = LAYERS.find((x) => x.id === id)!
  const rgba = new Uint8ClampedArray(W * H * 4)
  l.render(w.grid, w.store, rgba, 1)
  writeFileSync(`snapshots/phase1-${id}.png`, encodePng(W, H, rgba))
}
console.log("snapshots/phase1-*.png")

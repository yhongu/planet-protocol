import { writeFileSync, mkdirSync } from "node:fs"
import { World } from "../src/sim/world"
import { LAYERS } from "../src/render/layers"
import { encodePng } from "./png"

mkdirSync("snapshots", { recursive: true })
const W = 512, H = 256
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-5 } as const

function shot(name: string, mutate: (w: World) => void, layers: string[]): void {
  const w = new World({ width: W, height: H, seed: "hadean-01", shared: false })
  mutate(w)
  const t0 = performance.now()
  const s = w.solveClimate(OPT)
  const ms = performance.now() - t0
  const zm = w.climate.zonalMean(w.store)
  console.log(
    `${name.padEnd(20)} ${ms.toFixed(0).padStart(5)}ms N${String(s.iterations).padStart(3)} ` +
    `${s.converged ? "conv" : "NO  "} | mean ${s.meanT.toFixed(2).padStart(7)} ` +
    `eq ${zm[H >> 1].toFixed(1).padStart(6)} pole ${zm[H - 1].toFixed(1).padStart(6)} ` +
    `ice ${s.iceFraction.toFixed(3)} alb ${s.planetaryAlbedo.toFixed(3)} ` +
    `imbal ${s.imbalance.toExponential(1)}`,
  )
  for (const id of layers) {
    const layer = LAYERS.find((l) => l.id === id)!
    const rgba = new Uint8ClampedArray(W * H * 4)
    layer.render(w.grid, w.store, rgba, 1)
    writeFileSync(`snapshots/m1-${name}-${id}.png`, encodePng(W, H, rgba))
  }
}

console.log("M1 スナップショット (512x256)")
shot("earth", () => {}, ["temperature", "ice", "albedo"])
shot("co2-x4", (w) => { w.globals.co2 = 1120 }, ["temperature", "ice"])
shot("snowball", (w) => { w.globals.solarConstant = 1361 * 0.75 }, ["temperature", "ice"])
shot("archean-haze", (w) => {
  w.globals.solarConstant = 1361 * 0.78
  w.globals.co2 = 20000
  w.globals.ch4 = 6400
}, ["temperature", "ice"])

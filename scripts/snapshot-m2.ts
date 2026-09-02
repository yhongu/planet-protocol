import { writeFileSync, mkdirSync } from "node:fs"
import { World } from "../src/sim/world"
import { LAYERS } from "../src/render/layers"
import { encodePng } from "./png"
mkdirSync("snapshots", { recursive: true })
const W = 256, H = 128
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const

function shot(name: string, erosion: number, years: number, layers: string[]) {
  const w = new World({ width: W, height: H, seed: "hadean-01", shared: false })
  w.carbon.params.erosionFactor = erosion
  const steps = 30
  for (let i = 0; i < steps; i++) w.advance(years / steps, OPT)
  const c = w.carbon.lastFluxes!
  console.log(
    `${name.padEnd(16)} 侵食 ${erosion.toFixed(2)}  ${(years/1e6).toFixed(0)}Myr後: ` +
    `CO2 ${w.globals.co2.toFixed(0).padStart(5)}ppm  T ${w.stats!.meanT.toFixed(2).padStart(6)}C  ` +
    `供給律速 ${(c.supplyLimitedFraction * 100).toFixed(0).padStart(3)}%`)
  for (const id of layers) {
    const l = LAYERS.find((x) => x.id === id)!
    const rgba = new Uint8ClampedArray(W * H * 4)
    l.render(w.grid, w.store, rgba, 1)
    writeFileSync(`snapshots/m2-${name}-${id}.png`, encodePng(W, H, rgba))
  }
}
console.log("M2 スナップショット (512x256)")
shot("healthy", 1.0, 3e6, ["regime", "temperature"])
shot("eroding", 0.4, 3e6, ["regime", "temperature"])
shot("dying", 0.2, 3e6, ["regime", "temperature"])

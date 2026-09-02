import { writeFileSync, mkdirSync } from "node:fs"
import { World } from "../src/sim/world"
import { LAYERS } from "../src/render/layers"
import { encodePng } from "./png"
mkdirSync("snapshots", { recursive: true })
const W = 384, H = 192
const w = new World({ width: W, height: H, seed: "hadean-01", shared: false })
console.log(`M3 スナップショット (${W}x${H})  mean ${w.stats!.meanT.toFixed(2)}C  供給律速 ${(w.carbon.lastFluxes!.supplyLimitedFraction*100).toFixed(0)}%`)
for (const id of ["precip", "runoff", "discharge", "erosion", "regime"]) {
  const l = LAYERS.find((x) => x.id === id)!
  const rgba = new Uint8ClampedArray(W * H * 4)
  l.render(w.grid, w.store, rgba, 1)
  writeFileSync(`snapshots/m3-${id}.png`, encodePng(W, H, rgba))
  console.log(`  snapshots/m3-${id}.png`)
}

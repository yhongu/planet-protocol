/** 格子解像度とスーパーサンプリングの見え方を比較する。 */
import { writeFileSync, mkdirSync } from "node:fs"
import { World } from "../src/sim/world"
import { LAYERS } from "../src/render/layers"
import { encodePng } from "./png"
mkdirSync("snapshots", { recursive: true })
const layer = LAYERS.find((l) => l.id === "elevation")!
for (const [W, H, ss, tag] of [
  [128, 64, 1, "128x64-ss1"],
  [128, 64, 4, "128x64-ss4"],
  [256, 128, 1, "256x128-ss1"],
  [256, 128, 3, "256x128-ss3"],
  [512, 256, 1, "512x256-ss1"],
] as const) {
  const w = new World({ width: W, height: H, seed: "hadean-01", shared: false })
  const rgba = new Uint8ClampedArray(W * ss * H * ss * 4)
  const t0 = performance.now()
  layer.render(w.grid, w.store, rgba, ss)
  const ms = performance.now() - t0
  writeFileSync(`snapshots/cmp-${tag}.png`, encodePng(W * ss, H * ss, rgba))
  console.log(`${tag.padEnd(14)} 出力 ${W * ss}x${H * ss}  描画 ${ms.toFixed(1)}ms`)
}

/**
 * 検証用スナップショット。ブラウザを開かずに生成結果を目視確認する。
 *   npx vite-node scripts/snapshot.ts
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { Grid } from "../src/core/grid"
import { FieldStore, M0_FIELDS } from "../src/core/fields"
import { generateTerrain, DEFAULT_TERRAIN } from "../src/worldgen/terrain"
import { renderElevation } from "../src/render/layers/elevation"
import { encodePng } from "./png"

mkdirSync("snapshots", { recursive: true })

function shot(name: string, W: number, H: number, seed: string, opts = {}): void {
  const grid = new Grid(W, H)
  const store = new FieldStore(grid, M0_FIELDS, { shared: false })
  const t0 = performance.now()
  const res = generateTerrain(grid, store, seed, { ...DEFAULT_TERRAIN, ...opts })
  const genMs = performance.now() - t0

  const rgba = new Uint8ClampedArray(W * H * 4)
  const t1 = performance.now()
  renderElevation(grid, store, rgba, 1)
  const renderMs = performance.now() - t1

  writeFileSync(`snapshots/${name}.png`, encodePng(W, H, rgba))

  // 継ぎ目の検査: 巻き付き境界と内部の隣接列の高低差を比べる
  const e = store.f32("elevation").read
  let seam = 0, interior = 0
  for (let y = 0; y < H; y++) {
    const row = y * W
    seam += Math.abs(e[row + W - 1] - e[row])
    interior += Math.abs(e[row + (W >> 1)] - e[row + (W >> 1) + 1])
  }
  seam /= H; interior /= H

  // 海洋の統計
  let oceanSum = 0, oceanN = 0, landSum = 0, landN = 0
  let maxH = -Infinity, minH = Infinity
  for (let i = 0; i < e.length; i++) {
    if (e[i] < 0) { oceanSum += e[i]; oceanN++ } else { landSum += e[i]; landN++ }
    if (e[i] > maxH) maxH = e[i]
    if (e[i] < minH) minH = e[i]
  }

  console.log(
    `${name.padEnd(22)} ${String(W).padStart(4)}x${String(H).padEnd(4)} ` +
    `gen ${genMs.toFixed(0).padStart(4)}ms  render ${renderMs.toFixed(1).padStart(5)}ms  ` +
    `land ${res.landFraction.toFixed(3)}  ` +
    `ocean ${(oceanSum / oceanN).toFixed(0).padStart(6)}m  ` +
    `land ${(landSum / landN).toFixed(0).padStart(4)}m  ` +
    `min ${minH.toFixed(0).padStart(6)}  max ${maxH.toFixed(0).padStart(5)}  ` +
    `seam/interior ${(seam / interior).toFixed(2)}`,
  )
}

console.log("地球の参照値:  land 0.29  ocean -3688m  land +840m  min -10935m  max 8849m")
console.log("（min の -10935m は海溝、max の 8849m は衝突帯。どちらも M4 のプレートで出るべきもの）\n")
shot("earthlike-512", 512, 256, "hadean-01")
shot("earthlike-1024", 1024, 512, "hadean-01")
shot("seed-02", 512, 256, "hadean-02")
shot("seed-03", 512, 256, "gaia-03")
shot("pangaea", 512, 256, "hadean-01", { continentFrequency: 0.75 })
shot("archipelago", 512, 256, "hadean-01", { continentFrequency: 2.6 })
shot("waterworld", 512, 256, "hadean-01", { landFraction: 0.08 })
shot("supercontinent", 512, 256, "hadean-01", { landFraction: 0.55, continentFrequency: 0.9 })

// --- 継ぎ目の目視検査 ---
// 画像を W/2 だけ東西にずらして、巻き付き境界を画像の【中央】に持ってくる。
// 継ぎ目があれば中央に縦線として明瞭に出る。
{
  const W = 512, H = 256
  const grid = new Grid(W, H)
  const store = new FieldStore(grid, M0_FIELDS, { shared: false })
  generateTerrain(grid, store, "hadean-01", DEFAULT_TERRAIN)
  const rgba = new Uint8ClampedArray(W * H * 4)
  renderElevation(grid, store, rgba, 1)
  const rolled = new Uint8ClampedArray(W * H * 4)
  const half = W >> 1
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const src = (y * W + ((x + half) % W)) * 4
      const dst = (y * W + x) * 4
      for (let k = 0; k < 4; k++) rolled[dst + k] = rgba[src + k]
    }
  writeFileSync("snapshots/seam-check-centered.png", encodePng(W, H, rolled))
  console.log("\nsnapshots/seam-check-centered.png : 巻き付き境界を中央に配置（縦線が見えなければ合格）")

  // 極付近の値を確認する
  const e = store.f32("elevation").read
  const rowStat = (y: number) => {
    let mn = Infinity, mx = -Infinity, sum = 0
    for (let x = 0; x < W; x++) { const v = e[y * W + x]; sum += v; if (v < mn) mn = v; if (v > mx) mx = v }
    return `row ${String(y).padStart(3)} (lat ${grid.latDeg[y].toFixed(1).padStart(6)}°): ` +
           `min ${mn.toFixed(0).padStart(6)} mean ${(sum / W).toFixed(0).padStart(6)} max ${mx.toFixed(0).padStart(5)}`
  }
  console.log("\n極付近の行:")
  for (const y of [0, 1, 2, H / 2, H - 3, H - 2, H - 1]) console.log("  " + rowStat(y))
}

import { World } from "../src/sim/world"
const w = new World({ width: 256, height: 128, seed: "hadean-01", shared: false })
w.solveClimate({ cgTol: 1e-2, maxOuter: 300, tol: 1e-5 })
const { W, H } = w.grid
const T = w.store.f32("temperature").read
const S = w.store.f32("surfaceTemp").read
const e = w.store.f32("elevation").read
console.log("緯度帯ごとの陸 vs 海の温度（海面基準 / 標高補正後）:")
for (const lat of [60, 40, 20, 0, -20, -40, -60]) {
  let b = 0
  for (let y = 0; y < H; y++) if (Math.abs(w.grid.latDeg[y] - lat) < Math.abs(w.grid.latDeg[b] - lat)) b = y
  let lt = 0, ln = 0, ot = 0, on = 0, ls = 0
  for (let x = 0; x < W; x++) {
    const i = b * W + x
    if (e[i] >= 0) { lt += T[i]; ls += S[i]; ln++ } else { ot += T[i]; on++ }
  }
  if (ln === 0 || on === 0) continue
  console.log(
    `  lat ${String(lat).padStart(4)}°  陸 ${(lt / ln).toFixed(2).padStart(7)} / 海 ${(ot / on).toFixed(2).padStart(7)} ` +
    `= 差 ${((lt / ln) - (ot / on)).toFixed(2).padStart(6)} K   陸の地表温度 ${(ls / ln).toFixed(2).padStart(7)}`)
}

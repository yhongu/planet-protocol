/**
 * 風成循環（M4.7 段階3 の部品 a）の検査。
 *
 *   npx vite-node scripts/probes/probe-gyre.ts
 *
 * 受け入れ基準（docs/05 M4.7）:
 *   - 湧昇が東岸と赤道に集中する
 *   - 西岸境界流が出る
 *   - 湧昇の総量が解像度に依らない
 */
import { World } from "../../src/sim/world"

const rowAt = (w: World, lat: number) => {
  let b = 0
  for (let y = 0; y < w.grid.H; y++) {
    if (Math.abs(w.grid.latDeg[y] - lat) < Math.abs(w.grid.latDeg[b] - lat)) b = y
  }
  return b
}

console.log("■ 水惑星（陸なし）の総湧昇 —— ソルバ自体の解像度依存を見る")
console.log("  陸を入れると海岸線の長さが解像度で伸びるので、まず陸抜きで測る")
{
  const out: string[] = []
  for (const W of [64, 96, 128, 192, 256]) {
    const w = new World({ width: W, height: W >> 1, seed: "audit", shared: false,
      climateCouplingYears: 500_000 })
    w.globals.seaLevel = 1e5          // 全部を海にする
    w.ocean.update(w, 0)
    out.push(`${W}:${w.ocean.state.upwellingSv.toFixed(0)}`)
  }
  console.log("  湧昇[Sv]  " + out.join("  "))
}

console.log("\n■ 大陸ありの総量")
console.log("解像度   湧昇[Sv]  沈降[Sv]  西岸境界流[Sv]  環流[Sv]  |最大湧昇 m/yr|")
for (const W of [64, 96, 128]) {
  const w = new World({ width: W, height: W >> 1, seed: "audit", shared: false,
    climateCouplingYears: 500_000 })
  const s = w.ocean.state
  const up = w.store.f32("upwelling").read
  let mx = 0
  for (let i = 0; i < up.length; i++) mx = Math.max(mx, up[i])
  console.log(`  ${W}x${W >> 1}  ${s.upwellingSv.toFixed(1).padStart(8)}  ` +
    `${s.downwellingSv.toFixed(1).padStart(8)}  ${s.westernBoundarySv.toFixed(1).padStart(13)}  ` +
    `${s.gyreStrengthSv.toFixed(1).padStart(8)}  ${mx.toFixed(1).padStart(14)}`)
}

console.log("\n■ 沿岸セル vs 外洋（海岸線は解像度で伸びるので沿岸分は揃わない）")
console.log("解像度   沿岸[Sv]   外洋[Sv]   海岸線長[1000km]")
for (const W of [64, 96, 128]) {
  const H = W >> 1
  const w = new World({ width: W, height: H, seed: "audit", shared: false,
    climateCouplingYears: 500_000 })
  const up = w.store.f32("upwelling").read
  const el = w.store.f32("elevation").read
  const sea = w.globals.seaLevel
  const R = 6.371e6, dLat = Math.PI / H, dLon = 2 * Math.PI / W
  let c = 0, o = 0, len = 0
  for (let y = 0; y < H; y++) {
    const A = w.grid.cellArea[y]
    const dxm = R * Math.cos(w.grid.latRad[y]) * dLon, dym = R * dLat
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (el[i] >= sea) continue
      let coastal = false
      const nb: Array<[number, number]> = [
        [y * W + ((x + 1) % W), dym], [y * W + ((x + W - 1) % W), dym],
        [y > 0 ? i - W : i, dxm], [y < H - 1 ? i + W : i, dxm]]
      for (const [j, l] of nb) if (el[j] >= sea) { coastal = true; len += l }
      const q = Math.abs(up[i]) / 3.15576e7 * A / 1e6
      if (coastal) c += q; else o += q
    }
  }
  console.log(`  ${W}x${H}  ${c.toFixed(1).padStart(9)}  ${o.toFixed(1).padStart(9)}  ` +
    `${(len / 1e6).toFixed(0).padStart(15)}`)
}

console.log("\n■ 帯状平均の湧昇 [m/yr]（赤道と 60 度で正、30 度で負になるはず）")
const w = new World({ width: 96, height: 48, seed: "audit", shared: false,
  climateCouplingYears: 500_000 })
const up = w.store.f32("upwelling").read
const elev = w.store.f32("elevation").read
console.log("緯度   " + [0, 15, 30, 45, 60, 75].map((l) => l.toString().padStart(8)).join(""))
const vals = [0, 15, 30, 45, 60, 75].map((lat) => {
  const y = rowAt(w, lat)
  let s = 0, n = 0
  for (let x = 0; x < 96; x++) {
    const i = y * 96 + x
    if (elev[i] < w.globals.seaLevel) { s += up[i]; n++ }
  }
  return n ? s / n : NaN
})
console.log("湧昇   " + vals.map((v) => v.toFixed(2).padStart(8)).join(""))

console.log("\n■ 東岸 vs 西岸 vs 外洋の湧昇 [m/yr]（亜熱帯 15〜35 度の海）")
let east = 0, eastN = 0, west = 0, westN = 0, open = 0, openN = 0
for (let y = 0; y < 48; y++) {
  const lat = Math.abs(w.grid.latDeg[y])
  if (lat < 15 || lat > 35) continue
  for (let x = 0; x < 96; x++) {
    const i = y * 96 + x
    if (elev[i] >= w.globals.seaLevel) continue
    const e = y * 96 + ((x + 1) % 96)      // 東隣
    const wst = y * 96 + ((x + 95) % 96)   // 西隣
    if (elev[e] >= w.globals.seaLevel) { east += up[i]; eastN++ }
    else if (elev[wst] >= w.globals.seaLevel) { west += up[i]; westN++ }
    else { open += up[i]; openN++ }
  }
}
console.log(`  東岸（大陸の西海岸）${(east / eastN).toFixed(2)} m/yr  (n=${eastN})`)
console.log(`  西岸（大陸の東海岸）${(west / westN).toFixed(2)} m/yr  (n=${westN})`)
console.log(`  外洋              ${(open / openN).toFixed(2)} m/yr  (n=${openN})`)

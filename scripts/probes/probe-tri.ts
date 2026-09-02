import { Grid } from "../src/core/grid"
import { FieldStore } from "../src/core/fields"
import { Climate, M1_FIELDS } from "../src/sim/climate"
import { EARTH_PARAMS, earthGlobals } from "../src/sim/state"

// 全球海洋・アルベド一様・氷なし にして、純粋な拡散問題として解く
const W = 64, H = 64
const grid = new Grid(W, H)
const store = new FieldStore(grid, M1_FIELDS, { shared: false })
store.f32("elevation").read.fill(-4000)      // 全球海洋
const clim = new Climate(grid)
const g = earthGlobals()
// 氷アルベドを殺す: tIce を極端に低くする
const p = { ...EARTH_PARAMS, tIce: -300, alphaOcean: 0.3, alphaLand: 0.3, kMoist: 0 }

for (const outers of [1, 2, 3, 5, 10, 30, 100]) {
  store.f32("temperature").read.fill(15)
  store.f32("albedo").read.fill(0.3)
  const s = clim.solve(store, p, g, { dtYears: null, maxOuter: outers, innerSweeps: 1, tol: 0 })
  const zm = clim.zonalMean(store)
  console.log(
    `outer=${String(outers).padStart(3)}  mean ${s.meanT.toFixed(3).padStart(7)} ` +
    `eq ${zm[32].toFixed(2).padStart(6)}  60N ${zm[10].toFixed(2).padStart(7)}  pole ${zm[0].toFixed(2).padStart(7)}  ` +
    `imbal ${s.imbalance.toFixed(5).padStart(9)}`,
  )
}

// 解析解との比較: 拡散なし(D=0) なら各セルが局所平衡になるはず
console.log("\nD=0 の局所平衡（解析解と比較）:")
store.f32("temperature").read.fill(15)
store.f32("albedo").read.fill(0.3)
const p0 = { ...p, D: 1e-9 }
clim.solve(store, p0, g, { dtYears: null, maxOuter: 50, innerSweeps: 1, tol: 0 })
const zm0 = clim.zonalMean(store)
for (const y of [0, 10, 32]) {
  const S = clim.insolation(p0, g, y)
  const analytic = (S * 0.7 - p0.A0) / p0.B
  console.log(`  y=${String(y).padStart(2)} lat ${grid.latDeg[y].toFixed(1).padStart(6)}°  S=${S.toFixed(1).padStart(6)}  数値 ${zm0[y].toFixed(3).padStart(8)}  解析 ${analytic.toFixed(3).padStart(8)}`)
}

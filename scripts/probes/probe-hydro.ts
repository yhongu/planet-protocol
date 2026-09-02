import { World } from "../src/sim/world"
const w = new World({ width: 256, height: 128, seed: "hadean-01", shared: false })
const { W, H } = w.grid
const P = w.store.f32("precip").read
const R = w.store.f32("runoff").read
const E = w.store.f32("erosionRate").read
const D = w.store.f32("discharge").read
const e = w.store.f32("elevation").read
const rowAt = (lat: number) => { let b = 0; for (let y = 0; y < H; y++) if (Math.abs(w.grid.latDeg[y]-lat) < Math.abs(w.grid.latDeg[b]-lat)) b = y; return b }

console.log("緯度帯ごとの降水（陸のみ平均） [mm/yr]  ← 25-35度に乾燥帯が出るはず")
for (const lat of [0, 10, 20, 30, 40, 50, 60, 75]) {
  const y = rowAt(lat)
  let s = 0, n = 0, sr = 0
  for (let x = 0; x < W; x++) { const i = y * W + x; if (e[i] >= 0) { s += P[i]; sr += R[i]; n++ } }
  const yS = rowAt(-lat)
  let s2 = 0, n2 = 0
  for (let x = 0; x < W; x++) { const i = yS * W + x; if (e[i] >= 0) { s2 += P[i]; n2++ } }
  console.log(`  ${String(lat).padStart(3)}°N ${n ? (s/n).toFixed(0).padStart(6) : "   -- "}  流出 ${n ? (sr/n).toFixed(0).padStart(5) : "  -- "}   |  ${String(lat).padStart(3)}°S ${n2 ? (s2/n2).toFixed(0).padStart(6) : "   -- "}`)
}
let pmin = Infinity, pmax = 0
let landSum = 0, landA = 0, allSum = 0, allA = 0, oceanSum = 0, oceanA = 0
for (let y = 0; y < H; y++) { const a = w.grid.cellArea[y]
  for (let x = 0; x < W; x++) { const i = y*W+x
    allSum += P[i]*a; allA += a
    if (e[i] >= 0) { landSum += P[i]*a; landA += a; if (P[i]<pmin) pmin=P[i]; if (P[i]>pmax) pmax=P[i] }
    else { oceanSum += P[i]*a; oceanA += a } } }
console.log(`\n降水 [mm/yr]  全球 ${(allSum/allA).toFixed(0)} (現実 ~1000)  陸 ${(landSum/landA).toFixed(0)} (現実 ~750)  海 ${(oceanSum/oceanA).toFixed(0)} (現実 ~1100)`)
console.log(`陸上の範囲: ${pmin.toFixed(0)} - ${pmax.toFixed(0)} mm/yr`)
let dmax = 0, emax = 0
for (let i = 0; i < e.length; i++) { if (D[i]>dmax) dmax=D[i]; if (E[i]>emax) emax=E[i] }
console.log(`最大流量 ${(dmax/1e9).toFixed(1)} km³/yr（アマゾン川は 6600 km³/yr）  最大侵食 ${emax.toFixed(3)}`)
console.log(`供給律速の面積割合 ${(w.carbon.lastFluxes!.supplyLimitedFraction*100).toFixed(0)}%`)

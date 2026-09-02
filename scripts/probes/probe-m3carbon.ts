import { World } from "../src/sim/world"
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
const mk = () => new World({ width: 96, height: 48, seed: "hadean-01", shared: false })
const w0 = mk()
console.log(`較正: 供給律速 ${(w0.carbon.state!.supplyLimitedRef*100).toFixed(1)}% (目標 25%)  S/K=${(w0.carbon.state!.sDensity/w0.carbon.state!.kDensity).toFixed(2)}`)
const ero = w0.store.f32("erosionRate").read
const e = w0.store.f32("elevation").read
const vals: number[] = []
for (let i = 0; i < ero.length; i++) if (e[i] >= 0) vals.push(ero[i])
vals.sort((a,b)=>a-b)
const q = (p: number) => vals[Math.floor(p*(vals.length-1))]
console.log(`侵食分布: p1 ${q(0.01).toFixed(1)}  p10 ${q(0.1).toFixed(1)}  p50 ${q(0.5).toFixed(1)}  p90 ${q(0.9).toFixed(1)}  p99 ${q(0.99).toFixed(1)}  (幅 ${(q(0.99)/Math.max(1e-9,q(0.01))).toFixed(0)}倍)`)
console.log("\n侵食倍率に対する平衡 CO2 (M3 の水循環駆動の侵食):")
console.log("  侵食   平衡CO2    気温   供給律速")
for (const f of [2.0, 1.5, 1.0, 0.7, 0.5, 0.35, 0.25, 0.15]) {
  const w = mk()
  w.carbon.params.erosionFactor = f
  for (let i = 0; i < 120; i++) w.advance(5e6/120, OPT)
  const c = w.carbon.lastFluxes!
  console.log(`  ${f.toFixed(2)}  ${w.globals.co2.toFixed(0).padStart(7)} ppm  ${w.stats!.meanT.toFixed(1).padStart(6)} C  ${(c.supplyLimitedFraction*100).toFixed(0).padStart(4)}%`)
}

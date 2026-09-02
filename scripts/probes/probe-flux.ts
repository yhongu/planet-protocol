import { World } from "../src/sim/world"
import { computeWeathering } from "../src/sim/carbon"
const w = new World({ width: 64, height: 32, seed: "hadean-01", shared: false })
const cp = w.carbon.params, st = w.carbon.state!
console.log(`較正: landArea=${(st.landArea / 1e12).toFixed(1)}e12 m2`)
console.log(`      kDensity=${st.kDensity.toExponential(3)}  sDensity=${st.sDensity.toExponential(3)}  S/K=${(st.sDensity / st.kDensity).toFixed(3)}`)
console.log(`      供給律速の面積割合（基準）=${(st.supplyLimitedRef * 100).toFixed(1)}%  目標 ${(cp.supplyLimitedTarget * 100).toFixed(0)}%`)
console.log(`気候: meanT=${w.stats!.meanT.toFixed(3)}  T0=${w.params.T0}`)
for (const dt of [1, 25000]) {
  const f = computeWeathering(w, cp, st, dt)
  console.log(`dt=${String(dt).padStart(6)}  volc ${f.volcanic.toFixed(5)}  land ${f.land.toFixed(5)} (kin ${f.landKinetic.toFixed(5)} sup ${f.landSupplyLimited.toFixed(5)})  sf ${f.seafloor.toFixed(5)}  net ${f.net.toExponential(2)}  供給律速 ${(f.supplyLimitedFraction * 100).toFixed(1)}%`)
}
console.log(`\n目標: land=${cp.W0}  volc は基準状態から決まる  net=0`)

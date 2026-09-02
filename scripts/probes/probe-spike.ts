import { World } from "../src/sim/world"
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
const w = new World({ width: 192, height: 96, seed: "hadean-01", shared: false })
for (let i = 0; i < 5; i++) w.advance(8333, OPT)
console.log("フレームごとのコスト (x4 = 33333 年/フレーム)、発火したサブシステム付き:")
let worst = 0
for (let i = 0; i < 20; i++) {
  const t = performance.now()
  w.advance(33333, OPT)
  const ms = performance.now() - t
  if (ms > worst) worst = ms
  const f = JSON.stringify(w.lastStep!.fired)
  if (ms > 30 || i < 3) console.log(`  ${String(i).padStart(2)}: ${ms.toFixed(0).padStart(5)}ms  N=${w.stats!.iterations}  cg=${w.stats!.cgIterations}  ${f}`)
}
console.log(`最悪 ${worst.toFixed(0)}ms`)
console.log("\n--- Newton 反復を 8 回に制限した場合 ---")
const OPT2 = { cgTol: 1e-2, maxOuter: 8, tol: 1e-4 } as const
const w2 = new World({ width: 192, height: 96, seed: "hadean-01", shared: false })
for (let i = 0; i < 5; i++) w2.advance(8333, OPT2)
let worst2 = 0, tot = 0
for (let i = 0; i < 20; i++) {
  const t = performance.now(); w2.advance(33333, OPT2); const ms = performance.now() - t
  if (ms > worst2) worst2 = ms; tot += ms
}
console.log(`  平均 ${(tot/20).toFixed(1)}ms  最悪 ${worst2.toFixed(0)}ms  不平衡 ${w2.stats!.imbalance.toExponential(1)}  平均気温 ${w2.stats!.meanT.toFixed(2)}C`)

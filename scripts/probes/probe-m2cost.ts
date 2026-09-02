import { World } from "../src/sim/world"
for (const [W, H] of [[64, 32], [128, 64]] as const) {
  const t0 = performance.now()
  const w = new World({ width: W, height: H, seed: "hadean-01", shared: false })
  const init = performance.now() - t0
  const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
  const t1 = performance.now()
  for (let i = 0; i < 40; i++) w.advance(25000, OPT)
  const per = (performance.now() - t1) / 40
  console.log(`${W}x${H}  init ${init.toFixed(0).padStart(5)}ms  advance ${per.toFixed(1)}ms/step  ` +
    `-> 3 Myr (120 step) = ${(per * 120 / 1000).toFixed(1)}s  co2=${w.globals.co2.toFixed(1)}`)
}

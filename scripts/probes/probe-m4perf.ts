import { World } from "../src/sim/world"
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
for (const [W, H] of [[64, 32], [96, 48], [128, 64]] as const) {
  const t0 = performance.now()
  const w = new World({ width: W, height: H, seed: "hadean-01", shared: false })
  const init = performance.now() - t0
  const t1 = performance.now()
  for (let i = 0; i < 20; i++) w.advance(1.6e6, OPT)
  const per = (performance.now() - t1) / 20
  console.log(`${W}x${H}  init ${init.toFixed(0).padStart(5)}ms  advance(1.6Myr) ${per.toFixed(0).padStart(5)}ms  fired=${JSON.stringify(w.lastStep!.fired)} substeps=${w.lastStep!.substeps}`)
}

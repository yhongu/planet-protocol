import { World } from "/home/peko/Nilklops/gaia-protocol/src/sim/world"
for (const [W,H] of [[128,64],[256,128]] as const) {
  const t0 = performance.now()
  new World({ width: W, height: H, seed: "hadean-01", shared: false })
  console.log(`${W}x${H} init ${(performance.now()-t0).toFixed(0)}ms`)
}

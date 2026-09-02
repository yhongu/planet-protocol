import { World } from "../src/sim/world"
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
for (const [W, H] of [[192, 96], [256, 128]] as const) {
  const w = new World({ width: W, height: H, seed: "hadean-01", shared: false })
  for (let i = 0; i < 3; i++) w.advance(8333, OPT)
  const time = (label: string, f: () => void, n = 5) => {
    const t = performance.now(); for (let i = 0; i < n; i++) f()
    return `${label} ${((performance.now() - t) / n).toFixed(1)}ms`
  }
  const parts = [
    time("気候", () => w.solveClimate(OPT)),
    time("水循環", () => w.hydrology.update(w, 250e3)),
    time("炭素", () => w.carbon.update(w, 25e3)),
    time("テクトニクス", () => w.tectonics.update(w, 500e3), 3),
    time("分散度", () => w.tectonics.dispersion(w), 10),
    time("PGZ露出", () => w.tectonics.pgzExposure(w), 10),
  ]
  console.log(`${W}x${H}  ` + parts.join("  "))
}

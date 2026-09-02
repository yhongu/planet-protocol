import { Grid } from "../src/core/grid"
import { FieldStore, M0_FIELDS } from "../src/core/fields"
import { generateTerrain, DEFAULT_TERRAIN } from "../src/worldgen/terrain"
const W = 256, H = 128
console.log("極の標高（seed ごと）— 0m 付近に張り付いていたらバグ")
for (const seed of ["hadean-01","hadean-02","gaia-03","x","y","z","alpha","beta"]) {
  const g = new Grid(W, H)
  const s = new FieldStore(g, M0_FIELDS, { shared: false })
  generateTerrain(g, s, seed, DEFAULT_TERRAIN)
  const e = s.f32("elevation").read
  const mean = (y:number) => { let t=0; for(let x=0;x<W;x++) t+=e[y*W+x]; return t/W }
  console.log(`  ${seed.padEnd(10)} N ${mean(0).toFixed(0).padStart(6)}m   S ${mean(H-1).toFixed(0).padStart(6)}m`)
}

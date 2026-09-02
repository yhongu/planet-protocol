import { Grid } from "../src/core/grid"
import { ridgedFbm, fbm } from "../src/worldgen/noise"
const g = new Grid(256, 128)
const vals: number[] = []
const masks: number[] = []
for (let i = 0; i < g.cellCount; i++) {
  const p = [g.sphere[i*3], g.sphere[i*3+1], g.sphere[i*3+2]] as const
  vals.push(ridgedFbm(p[0], p[1], p[2], 12345, { octaves: 5, frequency: 6.5, lacunarity: 2.2, gain: 0.55 }))
  const prov = fbm(p[0], p[1], p[2], 999, { octaves: 3, frequency: 2.2 })
  masks.push(Math.max(0, Math.min(1, (prov + 0.15) * 1.6)))
}
vals.sort((a,b)=>a-b); masks.sort((a,b)=>a-b)
const q = (a:number[],p:number)=>a[Math.floor(p*(a.length-1))]
console.log("ridge  min",q(vals,0).toFixed(3),"p50",q(vals,0.5).toFixed(3),"p99",q(vals,0.99).toFixed(3),"p999",q(vals,0.999).toFixed(3),"max",q(vals,1).toFixed(3))
console.log("mask   p50",q(masks,0.5).toFixed(3),"p99",q(masks,0.99).toFixed(3),"max",q(masks,1).toFixed(3))

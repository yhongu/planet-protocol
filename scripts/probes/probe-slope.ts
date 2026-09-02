/**
 * **基準状態（現在の地球）で、侵食の場が解像度に依るかを測る。**
 *
 * 侵食は `carbon.ts` では `ero / erosionRef`、`tectonics.ts` では `ero / eroMean`
 * と正規化して使われるので、**一様な倍率は打ち消える。効くのは分布の形**。
 * だから平均だけでなく、緯度帯ごとの取り分と集中度も出す。
 *
 * ★設定は `scripts/probes/probe-flux.ts` と同じく**構築直後の基準状態**を見る
 *   （組み直さないこと。`CLAUDE.md` の 20）。1 ステップだけ進めて場を埋める。
 *
 *   npx vite-node scripts/probes/probe-slope.ts [--seed res-check] [--set slopePerDistance=1]
 */
import { World } from "../../src/sim/world"
import { EARTH_TECTONICS } from "../../src/sim/tectonics"
import { EARTH_HYDRO } from "../../src/sim/hydrology"
import { EARTH_OCEAN } from "../../src/sim/ocean"
import { EARTH_CARBON } from "../../src/sim/carbon"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "--set") continue
  const [k, v] = argv[i + 1].split("=")
  const t = EARTH_TECTONICS as unknown as Record<string, number>
  const h = EARTH_HYDRO as unknown as Record<string, number>
  const o = EARTH_OCEAN as unknown as Record<string, number>
  if (k in t) t[k] = Number(v)
  else if (k in h) h[k] = Number(v)
  else if (k in o) o[k] = Number(v)
  else if (k in (EARTH_CARBON as unknown as Record<string, number>)) {
    (EARTH_CARBON as unknown as Record<string, number>)[k] = Number(v)
  } else throw new Error(`知らないパラメータ: ${k}`)
}
const SEED = arg("seed", "res-check")
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const

console.log(`基準状態の侵食  seed ${SEED}  slopePerDistance=${EARTH_HYDRO.slopePerDistance}`)
console.log(`  W    erosionRef   陸% 侵食P95/平均  取り分 |lat|<30 / 30-60 / >60   流量P95/平均`)
for (const W of [64, 96, 128, 144]) {
  const H = W >> 1
  const w = new World({ width: W, height: H, seed: SEED, shared: false })
  w.advance(1000, OPT)
  const lf = w.store.f32("landFraction").read
  const ero = w.store.f32("erosionRate").read
  const dis = w.store.f32("discharge").read
  const vals: number[] = [], dvals: number[] = []
  let a = 0, e = 0, land = 0, d = 0
  const band = [0, 0, 0]
  for (let y = 0; y < H; y++) {
    const ca = w.grid.cellArea[y]
    const la = Math.abs(w.grid.latDeg[y])
    const b = la < 30 ? 0 : la < 60 ? 1 : 2
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      land += ca * lf[i]
      if (lf[i] <= 0) continue
      const wgt = ca * lf[i]
      a += wgt; e += ero[i] * wgt; d += dis[i] * wgt
      band[b] += ero[i] * wgt
      vals.push(ero[i]); dvals.push(dis[i])
    }
  }
  const p95 = (v: number[]) => { const s = [...v].sort((x, y) => x - y); return s[Math.floor(s.length * 0.95)] }
  const mean = e / a
  const total = band[0] + band[1] + band[2]
  console.log(`${String(W).padStart(4)}  ${mean.toExponential(3)}  ` +
    `${((land / w.grid.totalArea) * 100).toFixed(1)}  ${(p95(vals) / mean).toFixed(2).padStart(9)}  ` +
    `${band.map((v) => ((v / total) * 100).toFixed(1).padStart(5)).join(" /")}   ` +
    `${(p95(dvals) / (d / a)).toFixed(2)}`)
}

/**
 * **大陸のまとまりを時代別に測る。**
 *
 * ★2026-09-01 に描画を作って目で見えた課題:
 * 生成直後の地形は連続した大陸なのに、全史を回すとセル規模の島に散る。
 * **陸地面積（20.5%）は地球に近いのに、分布がまったく違う。**
 * 「陸の量」ではなく「陸のまとまり」で測らないと気づけない。
 *
 * 測るもの（4 近傍の連結成分。x は巡回、y は極で閉じる）:
 *   成分数        多いほど断片化
 *   最大成分の割合 大陸が 1 つにまとまっていれば大きい
 *   有効陸塊数     逆シンプソン `(Σa)² / Σa²`。裾の小島を数えすぎない
 *
 *   npx vite-node scripts/probes/probe-fragment.ts [--width 64] [--seed audit]
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"
import { EARTH_TECTONICS } from "../../src/sim/tectonics"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const W = Number(arg("width", "64")), H = W >> 1
const SEED = arg("seed", "audit")
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
// ★粒子数を変えて「断片化は標本ノイズか、実際のプレート運動か」を切り分ける
const PER = Number(arg("perCell", "0"))
if (PER > 0) EARTH_TECTONICS.parcelsPerCell = PER
// ★**既定値と同じ「省略」と「0 を明示」を区別すること。**
// `if (SM > 0)` と書いていたので `--smooth 0` が既定の 0.3 のまま走り、
// A/B の対照側が実験側と同じになっていた（2026-09-01）
const SM = argv.includes("--smooth") ? Number(arg("smooth", "0")) : -1
if (SM >= 0) EARTH_TECTONICS.rasterSmoothing = SM

const label = new Int32Array(W * H)
const stack = new Int32Array(W * H)

/** 陸セルの連結成分。面積は緯度重み付き */
function components(isLand: (i: number) => boolean, areaOf: (y: number) => number) {
  label.fill(-1)
  const areas: number[] = []
  for (let s = 0; s < W * H; s++) {
    if (label[s] >= 0 || !isLand(s)) continue
    const id = areas.length
    let a = 0, top = 0
    stack[top++] = s
    label[s] = id
    while (top > 0) {
      const c = stack[--top]
      const y = (c / W) | 0, x = c - y * W
      a += areaOf(y)
      const nb = [
        y * W + (x === 0 ? W - 1 : x - 1),
        y * W + (x === W - 1 ? 0 : x + 1),
        y > 0 ? c - W : -1,
        y < H - 1 ? c + W : -1,
      ]
      for (const n of nb) {
        if (n < 0 || label[n] >= 0 || !isLand(n)) continue
        label[n] = id
        stack[top++] = n
      }
    }
    areas.push(a)
  }
  const total = areas.reduce((s, v) => s + v, 0)
  const big = areas.length ? Math.max(...areas) : 0
  const sq = areas.reduce((s, v) => s + v * v, 0)
  return {
    n: areas.length,
    biggest: total > 0 ? big / total : 0,
    effN: sq > 0 ? (total * total) / sq : 0,
    landPct: total / (4 * Math.PI * 6.371e6 * 6.371e6) * 100,
  }
}

const w = new World({
  width: W, height: H, seed: SEED, shared: false,
  startEpoch: "hadean", climateCouplingYears: 200_000,
})
const el = () => w.store.f32("elevation").read
const lf = () => w.store.f32("landFraction").read
const areaOf = (y: number) => w.grid.cellArea[y]

function report(name: string): void {
  const e = el(), l = lf(), sea = w.globals.seaLevel
  const byElev = components((i) => e[i] >= sea, areaOf)
  const byLf = components((i) => l[i] >= 0.5, areaOf)
  console.log(`${name.padEnd(18)} 標高: 陸 ${byElev.landPct.toFixed(1).padStart(5)}%` +
    ` 成分 ${String(byElev.n).padStart(4)} 最大 ${(byElev.biggest * 100).toFixed(0).padStart(3)}%` +
    ` 有効 ${byElev.effN.toFixed(1).padStart(5)}` +
    `  │ lf: 陸 ${byLf.landPct.toFixed(1).padStart(5)}%` +
    ` 成分 ${String(byLf.n).padStart(4)} 最大 ${(byLf.biggest * 100).toFixed(0).padStart(3)}%` +
    ` 有効 ${byLf.effN.toFixed(1).padStart(5)}`)
}

console.log(`大陸のまとまり  ${W}x${H}  seed ${SEED}`)
console.log(`${"".padEnd(18)} ${"標高で判定".padEnd(44)} │ landFraction で判定`)
report("初期地形")
for (const [name, year] of [["冥王代 300Myr", 3e8], ["太古代 1.2Gyr", 1.2e9],
  ["原生代 2.6Gyr", 2.6e9], ["後期原生代 3.8Gyr", 3.8e9],
  ["顕生代 4.3Gyr", 4.3e9], ["現在 4.54Gyr", PLANET_AGE_YEARS]] as [string, number][]) {
  while (w.globals.yearsElapsed < year) w.advance(400_000, OPT)
  report(name)
}

/**
 * 「陸のまとまり具合」の指標を選ぶ。
 *
 * 陸塊の【数】はセル数にほぼ完全比例した（0.040〜0.045）ので指標にならない。
 * 解像度を変えても同じ値を出す指標を選びたい。
 *
 * 初期地形は単位球上の 3D ノイズから作るので、解像度が違っても
 * 【同じ惑星】になる（tests/resolution.test.ts が保証している）。
 * つまり初期地形は指標の選別にそのまま使える。しかも一瞬で終わる。
 *
 *   npx vite-node scripts/probes/probe-landmetric.ts [--seed hadean-01]
 */
import { World } from "../../src/sim/world"
import { Grid } from "../../src/core/grid"

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? process.argv[i + 1] : d
}
const SEED = arg("seed", "hadean-01")
const RES = [64, 96, 128, 160, 192, 256]

type Metrics = {
  land: number; n: number; biggest: number; biggestAbs: number
  effN: number; nBig: number; coastIdx: number
}

/** 4 近傍の連結成分（東西は巡回、極は閉じる）を測る */
function measure(grid: Grid, el: Float32Array, sea: number): Metrics {
  const { W, H } = grid
  const label = new Int32Array(W * H)
  const stack = new Int32Array(W * H)
  const areas: number[] = []
  let landArea = 0, cur = 0
  for (let s = 0; s < W * H; s++) {
    if (label[s] !== 0 || el[s] < sea) continue
    cur++
    let top = 0
    stack[top++] = s; label[s] = cur
    let a = 0
    while (top > 0) {
      const i = stack[--top]
      const y = (i / W) | 0, x = i - y * W
      a += grid.areaWeight[y]
      const nb = [y * W + (x + 1 === W ? 0 : x + 1), y * W + (x === 0 ? W - 1 : x - 1),
        y > 0 ? i - W : -1, y + 1 < H ? i + W : -1]
      for (const j of nb) {
        if (j < 0 || label[j] !== 0 || el[j] < sea) continue
        label[j] = cur; stack[top++] = j
      }
    }
    areas.push(a); landArea += a
  }
  areas.sort((p, q) => q - p)
  // 有効陸塊数（逆シンプソン）: 小さな島は a² が効かないのでほぼ数えない
  const sum2 = areas.reduce((s, v) => s + v * v, 0)
  const effN = sum2 > 0 ? (landArea * landArea) / sum2 : 0
  // 海岸線の長さ。セル境界の本数ではなく【物理長 km】で測る
  let coast = 0
  const dLon = (2 * Math.PI) / W
  for (let y = 0; y < H; y++) {
    const dx = 6371 * dLon * Math.cos(grid.latRad[y])   // 東西の辺の長さ km
    const dy = 6371 * (Math.PI / H)                      // 南北の辺の長さ km
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (el[i] < sea) continue
      const ie = y * W + (x + 1 === W ? 0 : x + 1)
      if (el[ie] < sea) coast += dy
      if (y + 1 < H && el[i + W] < sea) coast += dx
      if (y > 0 && el[i - W] < sea) coast += dx
      const iw = y * W + (x === 0 ? W - 1 : x - 1)
      if (el[iw] < sea) coast += dy
    }
  }
  const landKm2 = landArea * 5.1e8      // 全球 5.1e8 km²
  return {
    land: 100 * landArea,
    n: areas.length,
    biggest: landArea > 0 ? (100 * areas[0]) / landArea : 0,
    biggestAbs: 100 * (areas[0] ?? 0),
    effN,
    // 全球面積の 0.1% 以上の陸塊の数（面積で切るのでセル数に依らない）
    nBig: areas.filter((a) => a >= 0.001).length,
    // 海岸線の長さ / sqrt(陸地面積)。円なら 3.54、複雑なほど大きい
    coastIdx: landKm2 > 0 ? coast / Math.sqrt(landKm2) : 0,
  }
}

console.log(`陸のまとまり具合の指標  seed ${SEED}  初期地形（時間発展なし）\n`)
console.log(`  解像度   陸%   陸塊数  最大%  最大(全球%)  有効陸塊数  0.1%以上  海岸線指数`)
const rows: Array<[number, Metrics]> = []
for (const W of RES) {
  const w = new World({ width: W, height: W >> 1, seed: SEED, shared: false })
  const m = measure(w.grid, w.store.f32("elevation").read, w.globals.seaLevel)
  rows.push([W, m])
  console.log(`  ${String(W).padStart(4)}x${String(W >> 1).padEnd(4)} ` +
    `${m.land.toFixed(1).padStart(5)} ${String(m.n).padStart(6)} ` +
    `${m.biggest.toFixed(1).padStart(6)} ${m.biggestAbs.toFixed(1).padStart(10)} ` +
    `${m.effN.toFixed(2).padStart(11)} ${String(m.nBig).padStart(9)} ` +
    `${m.coastIdx.toFixed(2).padStart(11)}`)
}

/**
 * 【ばらつきだけで判定してはいけない】
 * 解像度と共に一方向に動く（系統的な傾き）のか、単なる標本ノイズなのかを
 * 分ける。傾きがある指標は解像度を上げるほど答えが変わるので使えない。
 * ノイズだけなら、時間方向の中央値を取れば消せるので使える。
 */
const trend = (f: (m: Metrics) => number, name: string) => {
  const v = rows.map(([, m]) => f(m))
  const x = rows.map(([W]) => Math.log2(W))
  const mx = x.reduce((s, a) => s + a, 0) / x.length
  const mv = v.reduce((s, a) => s + a, 0) / v.length
  let sxy = 0, sxx = 0, sse = 0
  for (let i = 0; i < v.length; i++) { sxy += (x[i] - mx) * (v[i] - mv); sxx += (x[i] - mx) ** 2 }
  const slope = sxy / Math.max(1e-30, sxx)            // 解像度 2 倍あたりの変化量
  for (let i = 0; i < v.length; i++) sse += (v[i] - (mv + slope * (x[i] - mx))) ** 2
  const noise = Math.sqrt(sse / v.length)
  const slopePct = Math.abs(mv) > 1e-30 ? (100 * slope) / Math.abs(mv) : Infinity
  const noisePct = Math.abs(mv) > 1e-30 ? (100 * noise) / Math.abs(mv) : Infinity
  const verdict = Math.abs(slopePct) > 10 ? "使えない（傾きあり）"
    : noisePct > 15 ? "要注意（ノイズ大）" : "★使える"
  console.log(`  ${name.padEnd(24)} ${mv.toFixed(2).padStart(7)} ` +
    `${(slopePct >= 0 ? "+" : "") + slopePct.toFixed(1) + "%"}`.padStart(9) +
    `  ${noisePct.toFixed(1).padStart(5)}%   ${verdict}`)
}
console.log(`\n  指標                       平均   傾き/倍  ノイズ   判定`)
console.log(`                                    (解像度2倍あたり)`)
trend((m) => m.land, "陸地面積 %")
trend((m) => m.n, "陸塊の数")
trend((m) => m.biggest, "最大陸塊の占有率 %")
trend((m) => m.biggestAbs, "最大陸塊 全球比 %")
trend((m) => m.effN, "有効陸塊数（逆シンプソン）")
trend((m) => m.nBig, "0.1% 以上の陸塊の数")
trend((m) => m.coastIdx, "海岸線指数")

// --- 地球の実測値（比較の基準）---
// 陸塊の面積 [100万 km²]。地峡で繋がるものは 1 つに数える（4 近傍の連結と同じ扱い）
const EARTH = [84.5, 42.5, 14.0, 7.7, 2.2, 0.786, 0.748, 0.587, 0.507]
const eSum = EARTH.reduce((s, v) => s + v, 0)
const eSum2 = EARTH.reduce((s, v) => s + v * v, 0)
console.log(`\n  地球の値（アフロユーラシア 84.5 / 南北アメリカ 42.5 / 南極 14.0 / 豪州 7.7 ...）`)
console.log(`    陸地面積 %              29.2`)
console.log(`    最大陸塊の占有率 %        ${(100 * EARTH[0] / eSum).toFixed(1)}`)
console.log(`    最大陸塊 全球比 %         ${(100 * EARTH[0] / 510).toFixed(1)}`)
console.log(`    有効陸塊数              ${(eSum * eSum / eSum2).toFixed(2)}  ←「実質いくつの大陸か」`)
console.log(`    0.1% 以上の陸塊の数       ${EARTH.length}`)

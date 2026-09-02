/**
 * 陸塊の連結成分を測る。M4.7 段階1（付加 = terrane accretion）の合否判定用。
 *
 * 付加を入れた狙いは「小島の群れ」を「まとまった大陸」に縫うこと。
 * 陸地面積だけ見ても分からないので、連結成分の数と最大成分の占有率で測る。
 *
 *   npx vite-node scripts/probes/probe-landmass.ts [--last 30]
 *
 * 入力は public/timelapse.{json,bin}（npm run audit -- --timelapse が出す）。
 * x は巡回、y は極で閉じる（docs/01-2.1）。近傍は 4 近傍。
 */
import { readFileSync } from "node:fs"
import { Grid } from "../../src/core/grid"
import { FieldStore } from "../../src/core/fields"
import { WORLD_FIELDS } from "../../src/sim/world"

const arg = (k: string, d: number) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? Number(process.argv[i + 1]) : d
}

const idx = JSON.parse(readFileSync("public/timelapse.json", "utf8")) as {
  width: number; height: number; frames: number; bytesPerFrame: number
  meta: Array<{ ga: number; seaLevel: number; land: number; epoch: string }>
}
const bin = readFileSync("public/timelapse.bin")
const { width: W, height: H, bytesPerFrame: BPF } = idx
const grid = new Grid(W, H)
const buf = new ArrayBuffer(BPF)
const store = FieldStore.attach(grid, WORLD_FIELDS, buf)
const dst = new Uint8Array(buf)
const el = store.f32("elevation").read

const label = new Int32Array(W * H)
const stack = new Int32Array(W * H)

type Row = { ga: number; land: number; biggest: number; effN: number; nBig: number }

/**
 * 陸セルの 4 近傍連結成分。
 * 【陸塊の「数」は指標にならない】——セル数にほぼ完全比例する
 * （0.040〜0.045 /セル。64x32 で 89 個、160x80 で 515 個）。
 * probe-landmetric.ts で選別した解像度独立な指標だけを出す。
 */
function components(sea: number): { areas: number[]; landArea: number } {
  label.fill(0)
  const areas: number[] = []
  let landArea = 0, cur = 0
  for (let s = 0; s < W * H; s++) {
    if (label[s] !== 0 || el[s] < sea) continue
    cur++
    let top = 0
    stack[top++] = s
    label[s] = cur
    let a = 0
    while (top > 0) {
      const i = stack[--top]
      const y = (i / W) | 0, x = i - y * W
      a += grid.areaWeight[y]
      const xe = x + 1 === W ? 0 : x + 1
      const xw = x === 0 ? W - 1 : x - 1
      const nb = [y * W + xe, y * W + xw,
                  y > 0 ? (y - 1) * W + x : -1,
                  y + 1 < H ? (y + 1) * W + x : -1]
      for (const j of nb) {
        if (j < 0 || label[j] !== 0 || el[j] < sea) continue
        label[j] = cur
        stack[top++] = j
      }
    }
    areas.push(a); landArea += a
  }
  areas.sort((p, q) => q - p)
  return { areas, landArea }
}

const rows: Row[] = []
for (let f = 0; f < idx.frames; f++) {
  dst.set(bin.subarray(f * BPF, (f + 1) * BPF))
  const m = idx.meta[f]
  const { areas, landArea } = components(m.seaLevel)
  const sum2 = areas.reduce((s, v) => s + v * v, 0)
  rows.push({
    ga: m.ga,
    land: 100 * landArea,
    biggest: landArea > 0 ? (100 * areas[0]) / landArea : 0,
    effN: sum2 > 0 ? (landArea * landArea) / sum2 : 0,
    nBig: areas.filter((a) => a >= 0.001).length,
  })
}

const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
const LAST = arg("last", 30)
const tail = rows.slice(-LAST)

console.log(`陸のまとまり具合  ${W}x${H}  ${idx.frames} フレーム`)
console.log(`  Ga前    陸%   最大陸塊%  有効陸塊数  0.1%以上`)
const HEAD = Number(arg("head", "0"))
for (let i = 0; i < rows.length; i += (HEAD > 0 && i < HEAD) ? 1 : Math.max(1, Math.floor(rows.length / 18))) {
  const r = rows[i]
  console.log(`  ${r.ga.toFixed(2).padStart(5)}  ${r.land.toFixed(1).padStart(5)}  ` +
    `${r.biggest.toFixed(1).padStart(8)}  ${r.effN.toFixed(2).padStart(9)}  ${String(r.nBig).padStart(7)}`)
}

const j = (name: string, v: number[], target: string, earth: string) =>
  console.log(`  ${name.padEnd(24)} ${med(v).toFixed(2).padStart(7)}   ${target.padEnd(10)} ${earth}`)

const report = (label: string, rs: Row[]) => {
  console.log(`\n${label}                中央値   目標       地球`)
  j("陸地面積 %", rs.map((r) => r.land), "25〜35", "29.2")
  j("最大陸塊の占有率 %", rs.map((r) => r.biggest), "50 以上", "55.0")
  j("有効陸塊数", rs.map((r) => r.effN), "2〜4", "2.56")
  j("0.1% 以上の陸塊の数", rs.map((r) => r.nBig), "10 前後", "9")
}
report(`直近 ${tail.length} フレーム`, tail)
report("全史", rows)
console.log(`\n  ※ 陸塊の「数」と海岸線の長さは解像度に比例するので指標にしない`)
console.log(`     （probe-landmetric.ts で選別。傾き +40.9% と +14.2% /解像度2倍）`)

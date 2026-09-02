/**
 * 全史のタイムラプスを作る。
 *
 * 45.4 億年を先に計算して、各時点の場をまるごと保存する。
 * ブラウザ側（timelapse.html）でスライダーを動かせば、
 * 既存の描画レイヤをそのまま使って全レイヤを見られる。
 *
 *   npx vite-node scripts/timelapse.ts [--width 128] [--frames 150]
 */
import { World, PLANET_AGE_YEARS, WORLD_FIELDS } from "../src/sim/world"
import { MODE_LABEL } from "../src/sim/mantle"
import { writeFileSync, mkdirSync } from "node:fs"

const arg = (k: string, d: number) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? Number(process.argv[i + 1]) : d
}
const W = arg("width", 128), H = W >> 1
const FRAMES = arg("frames", 150)
const SEED = process.argv.includes("--seed")
  ? process.argv[process.argv.indexOf("--seed") + 1] : "hadean-01"
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

const w = new World({
  width: W, height: H, seed: SEED, shared: false, startEpoch: "hadean",
  climateCouplingYears: 200_000,     // 見た目用なので少し緩めて速くする
})

const bytesPerFrame = w.store.buffer.byteLength
console.log(`タイムラプス生成  ${W}x${H}  ${FRAMES} フレーム  seed ${SEED}`)
console.log(`1 フレーム ${(bytesPerFrame/1024).toFixed(0)}KB -> 合計 ${(FRAMES*bytesPerFrame/1048576).toFixed(1)}MB`)

const frames: Uint8Array[] = []
type Meta = {
  year: number; ga: number; epoch: string; mode: string
  land: number; meanT: number; co2: number; ice: number
  seaLevel: number; maxElev: number; landElev: number; mantleT: number
  events: string[]
}
const meta: Meta[] = []
let sentEvents = 0

const snap = () => {
  frames.push(new Uint8Array(w.store.buffer.slice(0)))
  const el = w.store.f32("elevation").read
  const sea = w.globals.seaLevel
  let a = 0, es = 0, maxE = -Infinity
  for (let y = 0; y < H; y++) {
    const aw = w.grid.areaWeight[y]
    for (let x = 0; x < W; x++) {
      const v = el[y * W + x]
      if (v > maxE) maxE = v
      if (v < sea) continue
      a += aw; es += (v - sea) * aw
    }
  }
  const ev = w.events.slice(sentEvents).map((e) => e.text)
  sentEvents = w.events.length
  meta.push({
    year: w.globals.yearsElapsed,
    ga: (PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9,
    epoch: w.epoch.label, mode: MODE_LABEL[w.tectonicMode],
    land: 100 * a, meanT: w.stats!.meanT, co2: w.globals.co2,
    ice: w.stats!.iceFraction, seaLevel: sea, maxElev: maxE,
    landElev: a > 0 ? es / a : 0, mantleT: w.mantle.state.temperature,
    events: ev,
  })
}

const t0 = Date.now()
const per = PLANET_AGE_YEARS / (FRAMES - 1)
snap()
for (let f = 1; f < FRAMES; f++) {
  const target = f * per
  while (w.globals.yearsElapsed < target) {
    const r = w.advance(Math.min(400_000, target - w.globals.yearsElapsed), OPT)
    if (r.yearsAdvanced <= 0) break
  }
  snap()
  if (f % 15 === 0) {
    const pct = (100 * f / (FRAMES - 1)).toFixed(0)
    console.log(`  ${pct}%  ${meta[f].ga.toFixed(2)}Ga前  陸 ${meta[f].land.toFixed(1)}%  ` +
      `T ${meta[f].meanT.toFixed(1)}C  (${((Date.now()-t0)/1000).toFixed(0)}秒)`)
  }
}

mkdirSync("public", { recursive: true })
const total = new Uint8Array(frames.length * bytesPerFrame)
frames.forEach((f, i) => total.set(f, i * bytesPerFrame))
writeFileSync("public/timelapse.bin", total)
writeFileSync("public/timelapse.json", JSON.stringify({
  width: W, height: H, seed: SEED, frames: FRAMES,
  bytesPerFrame, fields: WORLD_FIELDS.map((f) => f.name), meta,
}))
console.log(`\n完了 ${((Date.now()-t0)/1000).toFixed(0)}秒`)
console.log(`  public/timelapse.bin  ${(total.byteLength/1048576).toFixed(1)}MB`)
console.log(`  public/timelapse.json`)
console.log(`\n  npm run dev して http://localhost:5180/timelapse.html を開く`)

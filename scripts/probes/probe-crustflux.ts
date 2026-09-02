/**
 * **現在の地球から短く回して、地殻の生成/消失フラックス [km³/yr] を測る。**
 *
 * 全史 1 本は 64x32 で 10 分・96x48 で 29 分かかるので、解像度依存の切り分けに
 * 使うには重すぎる。地球の値（海嶺 20・島弧 1〜3・再循環 2〜2.8 km³/yr）と
 * 直接比べられるのは【基準状態】なので、まずここで測る（`CLAUDE.md` の 12）。
 *
 * ★設定は `scripts/probes/probe-subgrid-carbon.ts` と同じにしてある
 *   （組み直さないこと。`CLAUDE.md` の 20）:
 *   startEpoch は既定の present / seed "res-check" /
 *   OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } / 刻み 800kyr
 *   違うのは解像度（--width）と刻み数（--steps）だけ。
 *
 *   npx vite-node scripts/probes/probe-crustflux.ts [--width 96] [--steps 20]
 *                 [--seed res-check] [--set marginErosionRatio=0.03]
 *
 * ★**カナリア**（`CLAUDE.md` の 13）: 海嶺の「線の長さ」（発散セルの数 × dy）を
 * 一緒に出す。解像度を変えてもこれは不変のはずで、動いていたら測定条件が違う。
 */
import { World } from "../../src/sim/world"
import { EARTH_TECTONICS, continentalVolume } from "../../src/sim/tectonics"
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

const W = Number(arg("width", "96")), H = W >> 1
const STEPS = Number(arg("steps", "20"))
const DT = Number(arg("dt", "800000"))
const SEED = arg("seed", "res-check")
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const

const w = new World({ width: W, height: H, seed: SEED, shared: false })
const b = w.tectonics.budget
const snap = () => ({
  arc: b.arc, spreading: b.spreading, subduction: b.subduction,
  delamination: b.delamination, erosion: b.erosion, basalt: b.basaltCycle,
})
const v0 = continentalVolume(w, w.tectonics.params.continentThreshold)
const b0 = snap()
let opened = 0, emptyV = 0, margin = 0
// 海嶺と海溝の【線の長さ】[km]。セルの南北幅 dy を足す（解像度不変のカナリア）
let ridgeLen = 0, trenchLen = 0, nSamp = 0
let openSum = 0, n90Sum = 0, nPosSum = 0, effLen = 0
let subBudget = 0, subKinem = 0
const dyKm = (Math.PI * 6371) / H

const t0 = Date.now()
for (let s = 0; s < STEPS; s++) {
  w.advance(DT, OPT)
  const div = w.store.f32("divergence").read
  // 【開く面積の積分】Σ 2·div·A [km²/yr]。海嶺は【線】なので
  // これは「線長 × 拡大速度」であり、解像度で変わってはいけない。
  // 強い順に並べて、どの `|div|` の帯が総量を作っているかも見る
  const pos: { d: number; a: number }[] = []
  let rl = 0, tl = 0, openArea = 0
  for (let y = 0; y < H; y++) {
    const aKm2 = w.grid.cellArea[y] / 1e6
    for (let x = 0; x < W; x++) {
      const d = div[y * W + x]
      if (d > 0) { rl += dyKm; openArea += 2 * d * aKm2; pos.push({ d, a: 2 * d * aKm2 }) }
      else if (d < 0) tl += dyKm
    }
  }
  // 【消費の予算】沈み込みは `min(1,2|div|dt) × セル平均の厚さ` を上限に削る。
  // 運動学（厚さ 7km 相当）と比べると、混成セルで予算が膨らんでいるかが分かる
  const thk = w.store.f32("crustThickness").read
  for (let y = 0; y < H; y++) {
    const aKm2 = w.grid.cellArea[y] / 1e6
    for (let x = 0; x < W; x++) {
      const c = y * W + x
      if (div[c] >= 0) continue
      const fr = Math.min(1, 2 * -div[c] * DT)
      subBudget += (fr * thk[c] * aKm2) / DT
      subKinem += (fr * 7 * aKm2) / DT
    }
  }
  pos.sort((p1, p2) => p2.d - p1.d)
  let acc = 0, n90 = 0
  for (const q of pos) { acc += q.a; n90++; if (acc >= 0.9 * openArea) break }
  ridgeLen += rl; trenchLen += tl; nSamp++
  openSum += openArea; n90Sum += n90; nPosSum += pos.length
  // 上位 90% の体積を作っているセルの数 × dy = 【実効の海嶺の長さ】
  effLen += n90 * dyKm
}
const d = snap()
opened = w.tectonics.diag.cumSpreadOpened
emptyV = w.tectonics.diag.cumSpreadEmpty
margin = w.tectonics.diag.cumMarginErosion
const yrs = STEPS * DT
const rate = (x: number) => (x / yrs).toFixed(3).padStart(8)
const v1 = continentalVolume(w, w.tectonics.params.continentThreshold)

const lf = w.store.f32("landFraction").read
let land = 0
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) land += lf[y * W + x] * w.grid.areaWeight[y]

console.log(`${W}x${H} seed=${SEED} ${STEPS}x${(DT / 1e3).toFixed(0)}kyr ` +
  `marginErosionRatio=${w.tectonics.params.marginErosionRatio} ` +
  `crustRecycleRate=${w.tectonics.params.crustRecycleRate} ${((Date.now() - t0) / 1000).toFixed(0)}s`)
console.log(`  フラックス [km³/yr]  海嶺 ${rate(d.spreading - b0.spreading)}` +
  ` (開いた分 ${rate(opened)} 空セル ${rate(emptyV)})  島弧 ${rate(d.arc - b0.arc)}` +
  `  珪長質の再循環 ${rate(-(d.subduction - b0.subduction))} (うち縁の削剥 ${rate(margin)})`)
console.log(`  　　　　　　　　　　  剥離 ${rate(-(d.delamination - b0.delamination))}` +
  `  侵食 ${rate(-(d.erosion - b0.erosion))}  玄武岩の循環 ${rate(d.basalt - b0.basalt)}`)
console.log(`  大陸地殻 ${(v1 / 1e9).toFixed(3)}e9 km³（地球 7.2。${yrs / 1e6}Myr で ` +
  `${(((v1 - v0) / v0) * 100).toFixed(2)}%）  陸(lf) ${(land * 100).toFixed(1)}%` +
  `  海面 ${w.globals.seaLevel.toFixed(0)}m`)
console.log(`  ★カナリア: div>0 のセル ${(nPosSum / nSamp).toFixed(0)} 個（線長換算 ` +
  `${(ridgeLen / nSamp / 1e3).toFixed(0)}e3 km。地球の海嶺は 6e4 km 級）`)
console.log(`  ★消費の予算 [km³/yr]  セル平均の厚さで ${(subBudget / nSamp).toFixed(1)}` +
  `  運動学（7km 相当）で ${(subKinem / nSamp).toFixed(1)}` +
  `  実際に消えた玄武岩 ${((d.spreading - b0.spreading - (d.basalt - b0.basalt)) / yrs).toFixed(1)}`)
console.log(`  ★開く面積 Σ2·div·A = ${(openSum / nSamp).toFixed(1)} km²/yr` +
  `（×海洋地殻 7km ≈ ${((openSum / nSamp) * 7).toFixed(0)} km³/yr。地球 20）` +
  `  総量の 90% を作るセル ${(n90Sum / nSamp).toFixed(0)} 個 = 実効の線長 ` +
  `${(effLen / nSamp / 1e3).toFixed(0)}e3 km`)

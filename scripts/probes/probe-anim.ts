/**
 * README 用のアニメーション（APNG）を作る。**45.4 億年を数秒で見せる。**
 *
 * ★ffmpeg も ImageMagick も無いので、自作の PNG エンコーダを拡張した
 * `encodeApng` を使う（`scripts/png.ts`）。GIF と違って**色を減らさない**。
 *
 *   npx vite-node scripts/probes/probe-anim.ts [--seed gaia-6] [--frames 60]
 *
 * 出力: docs/images/history.png（アニメーション PNG）
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"
import { renderNatural } from "../../src/render/layers/natural"
import { encodeApng } from "../png"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const W = Number(arg("width", "128")), H = W >> 1
const SEED = arg("seed", "gaia-6")
const N = Number(arg("frames", "48"))
// ★README に載せるので大きさを抑える。384x192・60 枚だと 7.7MB になった
const SS = Number(arg("ss", "2"))
const OPT = { cgTol: 1e-2, maxOuter: 8, tol: 1e-4 } as const

const w = new World({
  width: W, height: H, seed: SEED, shared: false,
  startEpoch: "hadean", climateCouplingYears: 200_000,
})
const OW = W * SS, OH = H * SS
const frames: Uint8ClampedArray[] = []
console.log(`全史のアニメーション  ${OW}x${OH}  ${N} 枚  seed ${SEED}`)
for (let k = 0; k < N; k++) {
  const target = (PLANET_AGE_YEARS * (k + 1)) / N
  while (w.globals.yearsElapsed < target) w.advance(400_000, OPT)
  const buf = new Uint8ClampedArray(OW * OH * 4)
  renderNatural(w.grid, w.store, buf, SS, {
    oceanWaterFraction: w.globals.oceanWaterFraction,
    steamFraction: w.globals.steamFraction,
    mantleTempC: w.mantle.state.temperature,
  })
  frames.push(buf)
  if (k % 10 === 0) {
    console.log(`  ${k + 1}/${N}  ${(w.globals.yearsElapsed / 1e9).toFixed(2)}Gyr  ` +
      `${w.stats!.meanT.toFixed(1)}℃  氷 ${(w.stats!.iceFraction * 100).toFixed(0)}%`)
  }
}
mkdirSync("docs/images", { recursive: true })
const png = encodeApng(OW, OH, frames, 200)
writeFileSync("docs/images/history.png", png)
console.log(`  -> docs/images/history.png  ${(png.length / 1048576).toFixed(1)}MB`)

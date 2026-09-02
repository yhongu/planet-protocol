/**
 * **ピクセルの見た目だけを、数秒の輪で見る**（`CLAUDE.md` の 34）。
 *
 * 「拡大するとぼやける」を直すのに全史（35 分）を回す必要はない。
 * 見たいのは【1 フレームの絵】なので、基準状態（現在の地球）を 1 枚描く。
 *
 * ★設定は `scripts/probes/probe-crustflux.ts` と同じ:
 *   startEpoch は既定の present / OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 }。
 *   違うのは seed（見た目の判断なので陸の多い既定 seed を使う）と刻み数だけ。
 *
 *   npx vite-node scripts/probes/probe-pixel.ts [--width 128] [--zoom 6]
 *
 * 出力:
 *   snapshots/pixel-full.png   全体（ss 倍のまま）
 *   snapshots/pixel-zoom.png   ★**拡大したときに画面で見えるもの**。
 *                              中央を切り出して最近傍で引き伸ばす
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { World } from "../../src/sim/world"
import { renderNatural } from "../../src/render/layers/natural"
import { encodePng } from "../png"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const W = Number(arg("width", "128")), H = W >> 1
const SS = Number(arg("ss", "4"))
// 画面の拡大率（1 セルあたりの画面ピクセル）。既定 6 は「大陸が画面に収まる」あたり
const ZOOM = Number(arg("zoom", "6"))
const SEED = arg("seed", "hadean-01")

// ★**氷の見え方は冥王代でしか確かめられない**（現在の地球は氷 3% しかない）。
// 冥王代から 3 億年は 1 分ほどで着くので、輪はまだ十分短い（`CLAUDE.md` の 34）
const YEARS = Number(arg("years", "0"))
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
const w = YEARS > 0
  ? new World({ width: W, height: H, seed: SEED, shared: false,
    startEpoch: "hadean", climateCouplingYears: 200_000 })
  : new World({ width: W, height: H, seed: SEED, shared: false })
if (YEARS > 0) {
  while (w.globals.yearsElapsed < YEARS) w.advance(400_000, OPT)
} else {
  // 氷と土壌水分が落ち着くまで少しだけ回す（見た目の判断に必要な場はこの 2 つ）
  for (let i = 0; i < 4; i++) w.advance(200_000, OPT)
}

mkdirSync("snapshots", { recursive: true })
const OW = W * SS, OH = H * SS
const out = new Uint8ClampedArray(OW * OH * 4)
renderNatural(w.grid, w.store, out, SS, {
  oceanWaterFraction: w.globals.oceanWaterFraction,
  steamFraction: w.globals.steamFraction,
  mantleTempC: w.mantle.state.temperature,
})
writeFileSync(`snapshots/pixel-full${YEARS > 0 ? "-" + (YEARS / 1e6) + "Myr" : ""}.png`, encodePng(OW, OH, out))

// ★拡大の再現。画面では 1 セル = ZOOM 画面px、offscreen は 1 セル = SS px なので、
// アート 1 px が画面 ZOOM/SS px に最近傍で引き伸ばされる（planetView.ts と同じ）
const up = Math.max(1, Math.round(ZOOM / SS * 4))   // 見やすさのため 4 倍して観察する
const cw = 160, ch = 90                              // 切り出すアートピクセル数
const x0 = Math.max(0, (OW >> 1) - (cw >> 1)), y0 = Math.max(0, (OH >> 1) - (ch >> 1))
const zw = cw * up, zh = ch * up
const zoom = new Uint8ClampedArray(zw * zh * 4)
for (let y = 0; y < zh; y++) {
  const sy = y0 + Math.floor(y / up)
  for (let x = 0; x < zw; x++) {
    const sx = x0 + Math.floor(x / up)
    const s = (sy * OW + sx) * 4, d = (y * zw + x) * 4
    zoom[d] = out[s]; zoom[d + 1] = out[s + 1]; zoom[d + 2] = out[s + 2]; zoom[d + 3] = 255
  }
}
writeFileSync("snapshots/pixel-zoom.png", encodePng(zw, zh, zoom))

// ★診断: 絵の中に何色あるか。**ピクセルアートは色数が少ない**ので、
// これが「ぼやけ」の直接の指標になる（連続の混色は色数が爆発する）
const seen = new Set<number>()
for (let i = 0; i < OW * OH; i++) {
  seen.add((out[i * 4] << 16) | (out[i * 4 + 1] << 8) | out[i * 4 + 2])
}
const st = w.stats!
console.log(`${W}x${H} ss${SS}  seed ${SEED}  ${st.meanT.toFixed(1)}℃` +
  `  氷 ${(st.iceFraction * 100).toFixed(0)}%  陸 ${(st.landFraction * 100).toFixed(0)}%`)
console.log(`★色数 ${seen.size}  （ピクセルアートの目安は 64 以下）`)

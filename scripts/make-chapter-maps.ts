/**
 * ★★**章の惑星を「球に貼る絵」として焼く**（タイトル画面用。2026-09-10）。
 *
 * ★プレイして「トップ画面は惑星が円型で回転して、**ちゃんとこのゲームの
 * 惑星**」と要望された。
 *
 * ★**実行時に章そのものを読まない。** 章は 1 つ 15MB あり、タイトルで 4 つ
 * 読むと 60MB になる（罠 75 の親戚 —— 見せるためだけに本物を運ばない）。
 * ここで**実際のセーブから自然な見た目レイヤをラスタライズ**して
 * 小さな正距円筒の PNG にしておき、ブラウザはそれを球へ投影する。
 * 焼いた絵は**本物の惑星そのもの**なので「ちゃんとこのゲームの惑星」を満たす。
 *
 * ★冥王代だけは配られた章が無い（まだ何も起きていないので保存する意味が薄い）。
 * その場で 500 万年だけ回して焼く —— **決定論なので誰が回しても同じ**。
 *
 *   npx vite-node scripts/make-chapter-maps.ts
 *
 * 出力: public/chapters/map-<id>.png（正距円筒・幅 512）
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { World } from "../src/sim/world"
import { loadWorld } from "../src/sim/snapshot"
import { renderNatural } from "../src/render/layers/natural"
import { encodePng } from "./png"

/** 焼く幅。★球は 512px 程度で描くので、その 1 倍で足りる */
const OUT_W = 512
const OPT = { cgTol: 1e-2, maxOuter: 8, tol: 1e-4 } as const

function bake(w: World, id: string): void {
  const { W, H } = w.grid
  // ★スーパーサンプリングは「出したい幅 ÷ 格子の幅」で決める。
  //   固定値にすると、章の解像度が変わったとき絵の大きさが変わる
  const ss = Math.max(1, Math.round(OUT_W / W))
  const out = new Uint8ClampedArray(W * ss * H * ss * 4)
  renderNatural(w.grid, w.store, out, ss, {
    oceanWaterFraction: w.globals.oceanWaterFraction,
    steamFraction: w.globals.steamFraction,
    mantleTempC: w.mantle.state.temperature,
  })
  const path = `public/chapters/map-${id}.png`
  writeFileSync(path, encodePng(W * ss, H * ss, out))
  console.log(`${path}  ${W * ss}x${H * ss}`
    + `  ${w.stats!.meanT.toFixed(1)}℃`
    + `  CO2 ${w.globals.co2.toFixed(0)}ppm`
    + `  ${(w.globals.yearsElapsed / 1e9).toFixed(2)}Gyr`)
}

// --- 配られている章はそのまま焼く ---
for (const id of ["archean", "proterozoic", "phanerozoic"]) {
  const f = `public/chapters/${id}.gaia`
  if (!existsSync(f)) { console.log(`（${id} は未配布。飛ばす）`); continue }
  const w = loadWorld(new Uint8Array(gunzipSync(readFileSync(f))))
  w.refresh(OPT)
  bake(w, id)
}

// --- 冥王代は章が無いので、その場で少しだけ回す ---
{
  const w = new World({
    width: 96, height: 48, seed: "hadean-01", shared: false,
    startEpoch: "hadean", climateCouplingYears: 200_000,
  })
  // ★マグマオーシャンのまま焼くと真っ黒に近いので、溶岩の海が見える所まで進める
  w.advance(5e6, OPT)
  bake(w, "hadean")
}

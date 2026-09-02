/**
 * 炭素循環の時間積分の収束確認。★安く決着させる
 *
 * 全史 4.54Gyr を細かい刻みで回すと 1 ケース 1 時間超になる。
 * 数値の問題を見るだけなら、短い孤立した問題で十分。
 *
 * 現在の地球（較正済みの定常状態）から CO2 を 4 倍に摂動し、
 * 戻る過程を刻みを変えて積分する。定常値と時定数が刻みに依存しなければ、
 * 炭素循環の積分は健全ということになる。
 */
import { World } from "../src/sim/world"

const W = 64, H = 32
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const TOTAL = 3e6      // 300 万年（風化の時定数 20 万年の 15 倍）

console.log("炭素循環の刻み依存性  64x32  現在の地球から CO2 4倍 -> 回復")
console.log("較正の定常値: CO2 280ppm  T 14.5C\n")
console.log("刻み[kyr]  呼出回数  実進行[Myr]  300万年後CO2   T[C]   半減までの年数")
// 100kyr だけが跳ねたので、その周辺を細かく見る。
// 単調な収束誤差なら滑らかに変わるはず。特定の刻みだけ跳ねるなら
// サブシステムの発火位相の共鳴（炭素 25k / 水循環 250k / テクトニクス 500k）。
for (const kyr of [60, 70, 80, 90, 100, 110, 125, 150, 175, 200, 250]) {
  const step = kyr * 1000
  const w = new World({ width: W, height: H, seed: "dt", shared: false })
  const base = w.globals.co2
  w.globals.co2 = base * 4
  w.refresh(OPT)
  const target = base + (base * 4 - base) * 0.5     // 半分戻った点
  let half = -1, elapsed = 0, calls = 0
  while (elapsed < TOTAL) {
    const r = w.advance(step, OPT)
    elapsed += r.yearsAdvanced; calls++
    if (half < 0 && w.globals.co2 <= target) half = elapsed
    if (r.yearsAdvanced <= 0) break
  }
  console.log(`${kyr.toString().padStart(8)} ${calls.toString().padStart(9)} ` +
    `${(elapsed/1e6).toFixed(2).padStart(11)}  ${w.globals.co2.toFixed(1).padStart(11)} ` +
    `${w.stats!.meanT.toFixed(2).padStart(7)}  ${half > 0 ? (half/1000).toFixed(0)+" kyr" : "未到達"}`)
}
console.log("\n刻みで結果が変わらなければ、炭素循環の積分は健全。")

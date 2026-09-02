/**
 * 熱塩循環（M4.7 段階3 の部品 b）の較正と枝の検査。
 *
 *   npx vite-node scripts/probes/probe-thc.ts [--width 96]
 *
 * 1. 現在の地球で ΔT*・淡水流入・転覆流量がいくつになるか
 * 2. 解像度独立か（強制は面積重み積分なので依らないはず）
 * 3. 淡水異常を上げ下げしてヒステリシスが出るか
 */
import { World } from "../../src/sim/world"

const arg = (k: string, d: number) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? Number(process.argv[i + 1]) : d
}

console.log("■ 現在の地球（startEpoch: present）")
console.log("解像度   ΔT*[K]  淡水[Sv]   ΔT[K]   ΔS[psu]   q[Sv]   枝")
for (const W of [64, 96, 128]) {
  const w = new World({ width: W, height: W >> 1, seed: "audit", shared: false })
  const s = w.ocean.state
  console.log(`  ${W}x${W >> 1}  ${s.deltaTAtm.toFixed(2).padStart(6)}  ` +
    `${s.freshwaterSv.toFixed(3).padStart(7)}  ${s.deltaT.toFixed(2).padStart(6)}  ` +
    `${s.deltaS.toFixed(3).padStart(7)}  ${s.overturningSv.toFixed(2).padStart(6)}  ` +
    `${s.thermohalineMode}`)
}

console.log("\n■ ヒステリシス（淡水異常を往復させる）")
console.log("  崩壊: 往路で q が 1 Sv を切る淡水異常  /  回復: 復路で戻る淡水異常")
console.log("解像度   崩壊[Sv]   回復[Sv]   ヒステリシス幅[Sv]   崩壊後の q[Sv]")
for (const W of [64, 96, 128]) {
  const w = new World({ width: W, height: W >> 1, seed: "audit", shared: false })
  const step = 0.005
  const set = (f: number) => {
    w.ocean.params.freshwaterAnomalySv = f
    w.ocean.update(w, 0)
    return w.ocean.state.overturningSv
  }
  let collapse = NaN, qAfter = NaN
  for (let f = 0; f <= 1.0001; f += step) {
    const q = set(f)
    if (q < 1) { collapse = f; qAfter = q; break }
  }
  // 復路: 淡水を負まで下げて、いつ熱塩枝に戻るか
  let recover = NaN
  for (let f = collapse; f >= -3.0001; f -= step) {
    if (set(f) > 1) { recover = f; break }
  }
  console.log(`  ${W}x${W >> 1}  ${collapse.toFixed(3).padStart(8)}  ` +
    `${recover.toFixed(3).padStart(9)}  ` +
    `${(collapse - recover).toFixed(3).padStart(16)}  ${qAfter.toFixed(2).padStart(12)}`)
}

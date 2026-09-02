/**
 * 陸地の振動が【解像度のせい】かどうかを測る。
 *
 * 侵食を切っても振れ幅 18.9 ポイントが残った。気候→侵食の環ではない。
 * 残る容疑者はプレートの離散化:
 *   - 12 プレートを 64x32 (2048 セル) に載せると 1 プレート約 170 セル
 *   - assignPlates はボロノイの再割り当てで、境界が【セル単位で飛ぶ】
 *   - advectByRotation は 0.75 セル溜まったら最近傍で丸ごと 1 セルずらす
 *     64x32 では 1 セル = 約 625km
 * これが本当の原因なら、解像度を上げると振れ幅が縮むはず。
 * 縮まなければモデルの欠陥、縮めば「使える最低解像度」の問題になる。
 */
import { World, PLANET_AGE_YEARS } from "../src/sim/world"

const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const STEP = 4e6

console.log("振動の解像度依存性  全史 4.54Gyr  seed hadean-01  受け皿1.0")
console.log("格子      1セル[km]  最終陸%  CO2    T   | 直近2Gyr 陸% 平均  最小-最大 (振れ幅)")
for (const [W, H] of [[64, 32], [96, 48], [128, 64]] as const) {
  const w = new World({
    width: W, height: H, seed: "hadean-01", shared: false, startEpoch: "hadean",
    tectonics: { shelfMinFactor: 1.0 },
  })
  const cellKm = 2 * Math.PI * 6371 / W
  const hist: number[] = []
  while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
    w.advance(STEP, OPT)
    if (w.globals.yearsElapsed > PLANET_AGE_YEARS - 2e9) {
      hist.push(100 * w.grid.areaFractionWhere(w.store.f32("elevation").read, (v) => v >= 0))
    }
  }
  const land = 100 * w.grid.areaFractionWhere(w.store.f32("elevation").read, (v) => v >= 0)
  const mn = Math.min(...hist), mx = Math.max(...hist)
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length
  console.log(`${W}x${H}`.padEnd(9) + `${cellKm.toFixed(0).padStart(8)}  ` +
    `${land.toFixed(1).padStart(6)} ${w.globals.co2.toFixed(0).padStart(6)} ` +
    `${w.stats!.meanT.toFixed(1).padStart(5)} | ${mean.toFixed(1).padStart(5)} ` +
    `${mn.toFixed(1).padStart(6)} -${mx.toFixed(1).padStart(6)} (${(mx-mn).toFixed(1).padStart(5)})`)
}

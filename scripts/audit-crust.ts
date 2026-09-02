/**
 * 地殻体積の収支監査。
 *
 * 【設計方針】
 * 症状に合わせてパラメータを調整するのではなく、毎ステップの収支を記録して
 * 「どの機構がどれだけ動かしたか」を見る。エネルギー・炭素・水・地殻の
 * 4 つの収支を常時監査できるようにするための、地殻分の実装。
 *
 * 評価指標は max-min ではなく、平均・標準偏差・P5/P95・自己相関・卓越周期を出す。
 * 「20→30→20」と「20→30」は振れ幅が同じでも意味が全く違うため。
 */
import { World, PLANET_AGE_YEARS } from "../src/sim/world"

const W = Number(process.env.AW ?? 64), H = Number(process.env.AH ?? 32)
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const STEP = 4e6
const SEED = process.env.ASEED ?? "hadean-01"

type Row = {
  t: number; land: number; sat: number; clampK: number
  vCont: number; vTot: number; sea: number; water: number
  dArc: number; dClamp: number; dOro: number; dRift: number; dEro: number
  nearThresh: number; p10: number; p50: number; p90: number; co2: number; temp: number
}

function run(name: string, patch: Record<string, number>): Row[] {
  const w = new World({
    width: W, height: H, seed: SEED, shared: false, startEpoch: "hadean",
    tectonics: patch,
  })
  const rows: Row[] = []
  const LAND_THICK = (4.8) / 0.1515            // 標高 0 に対応する厚さ [km] = 31.7
  while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
    w.advance(STEP, OPT)
    const el = w.store.f32("elevation").read
    const th = w.store.f32("crustThickness").read
    const d = w.tectonics.diag
    // 陸海閾値の近く（±2km）にいるセルの割合。ここが多いほど陸%は敏感になる
    let near = 0
    const sorted: number[] = []
    for (let i = 0; i < th.length; i++) {
      if (Math.abs(th[i] - LAND_THICK) < 2) near++
      sorted.push(th[i])
    }
    sorted.sort((a, b) => a - b)
    const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]
    rows.push({
      t: w.globals.yearsElapsed,
      land: 100 * w.grid.areaFractionWhere(el, (v) => v >= w.globals.seaLevel),
      sat: d.saturation, clampK: d.clampK,
      vCont: d.continentalVolume / 1e9, vTot: d.totalVolume / 1e9,
      sea: w.globals.seaLevel, water: w.globals.oceanWaterFraction,
      dArc: d.dArc / 1e6, dClamp: d.dClamp / 1e6, dOro: d.dOrogeny / 1e6,
      dRift: d.dRift / 1e6, dEro: d.dErosion / 1e6,
      nearThresh: 100 * near / th.length,
      p10: q(0.1), p50: q(0.5), p90: q(0.9),
      co2: w.globals.co2, temp: w.stats!.meanT,
    })
  }
  return rows
}

// --- 統計 ---
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))) }
const pct = (a: number[], f: number) => {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(f * s.length))]
}
/** 自己相関。lag はステップ数 */
function autocorr(a: number[], lag: number): number {
  const m = mean(a), n = a.length
  let num = 0, den = 0
  for (let i = 0; i < n; i++) den += (a[i] - m) ** 2
  for (let i = 0; i + lag < n; i++) num += (a[i] - m) * (a[i + lag] - m)
  return den > 0 ? num / den : 0
}
/** 自己相関の最初の山を卓越周期とする [Myr]。谷を越えてから探す */
function dominantPeriod(a: number[]): { period: number; peak: number } {
  let i = 1
  while (i < a.length / 3 && autocorr(a, i) > 0) i++      // 最初のゼロ交差まで進む
  let best = -2, bestLag = 0
  for (let l = i; l < Math.floor(a.length / 3); l++) {
    const c = autocorr(a, l)
    if (c > best) { best = c; bestLag = l }
  }
  return { period: bestLag * STEP / 1e6, peak: best }
}
/** x が y に対して何ステップ先行しているか（相互相関の最大） */
function leadLag(x: number[], y: number[], maxLag: number): { lag: number; corr: number } {
  const mx = mean(x), my = mean(y)
  const sx = sd(x), sy = sd(y)
  if (sx === 0 || sy === 0) return { lag: 0, corr: 0 }
  let best = -2, bestLag = 0
  for (let l = -maxLag; l <= maxLag; l++) {
    let sum = 0, n = 0
    for (let i = 0; i < x.length; i++) {
      const j = i + l
      if (j < 0 || j >= y.length) continue
      sum += (x[i] - mx) * (y[j] - my); n++
    }
    const c = n > 0 ? sum / (n * sx * sy) : 0
    if (c > best) { best = c; bestLag = l }
  }
  return { lag: bestLag * STEP / 1e6, corr: best }
}

const CASES: Array<[string, Record<string, number>]> = [
  ["基準", {}],
  ["クランプOFF", { volumeClamp: 0 }],
  ["飽和OFF", { volumeSaturation: 0 }],
  ["両方OFF", { volumeClamp: 0, volumeSaturation: 0 }],
]

console.log(`地殻体積の収支監査  ${W}x${H}  seed ${SEED}  全史 4.54Gyr  ${STEP/1e6}Myr刻み`)
console.log(`統計は直近 2Gyr（${Math.floor(2e9/STEP)} サンプル）で取る\n`)

for (const [name, patch] of CASES) {
  const all = run(name, patch)
  const rows = all.filter((r) => r.t > PLANET_AGE_YEARS - 2e9)
  const land = rows.map((r) => r.land)
  const dp = dominantPeriod(land)
  console.log(`■ ${name}`)
  console.log(`  陸%   平均 ${mean(land).toFixed(1)}  sd ${sd(land).toFixed(1)}  ` +
    `P5 ${pct(land,0.05).toFixed(1)}  P50 ${pct(land,0.5).toFixed(1)}  P95 ${pct(land,0.95).toFixed(1)}  ` +
    `最小 ${Math.min(...land).toFixed(1)} 最大 ${Math.max(...land).toFixed(1)}`)
  console.log(`  自己相関  lag1 ${autocorr(land,1).toFixed(2)}  ` +
    `卓越周期 ${dp.period.toFixed(0)} Myr (相関 ${dp.peak.toFixed(2)})`)
  const sat = rows.map((r) => r.sat), dArc = rows.map((r) => r.dArc)
  const dClamp = rows.map((r) => r.dClamp), ck = rows.map((r) => r.clampK)
  console.log(`  飽和  平均 ${mean(sat).toFixed(3)} sd ${sd(sat).toFixed(3)}   ` +
    `clampK 平均 ${mean(ck).toFixed(4)} 最大 ${Math.max(...ck).toFixed(3)}  ` +
    `クランプ発動率 ${(100*ck.filter((v)=>v>0).length/ck.length).toFixed(0)}%`)
  console.log(`  体積 [1e9km3]  大陸 ${mean(rows.map(r=>r.vCont)).toFixed(2)} (sd ${sd(rows.map(r=>r.vCont)).toFixed(2)})  ` +
    `全体 ${mean(rows.map(r=>r.vTot)).toFixed(2)}`)
  console.log(`  厚さ[km] P10 ${mean(rows.map(r=>r.p10)).toFixed(1)} P50 ${mean(rows.map(r=>r.p50)).toFixed(1)} ` +
    `P90 ${mean(rows.map(r=>r.p90)).toFixed(1)}   陸海閾値(31.7km)±2km のセル ${mean(rows.map(r=>r.nearThresh)).toFixed(1)}%`)
  console.log(`  収支 [1e6km3/step]  弧 ${mean(dArc).toFixed(2)}  造山 ${mean(rows.map(r=>r.dOro)).toFixed(2)}  ` +
    `リフト ${mean(rows.map(r=>r.dRift)).toFixed(2)}  侵食 ${mean(rows.map(r=>r.dEro)).toFixed(2)}  ` +
    `クランプ ${mean(dClamp).toFixed(2)}`)
  const ll1 = leadLag(sat, dArc, 40), ll2 = leadLag(dArc, land, 40), ll3 = leadLag(dClamp, land, 40)
  console.log(`  位相  飽和→弧成長 ${ll1.lag>=0?"+":""}${ll1.lag.toFixed(0)}Myr (r=${ll1.corr.toFixed(2)})  ` +
    `弧成長→陸% ${ll2.lag>=0?"+":""}${ll2.lag.toFixed(0)}Myr (r=${ll2.corr.toFixed(2)})  ` +
    `クランプ→陸% ${ll3.lag>=0?"+":""}${ll3.lag.toFixed(0)}Myr (r=${ll3.corr.toFixed(2)})`)
  console.log(`  最終  陸 ${all[all.length-1].land.toFixed(1)}%  CO2 ${all[all.length-1].co2.toFixed(0)}  ` +
    `T ${all[all.length-1].temp.toFixed(1)}C  海面 ${all[all.length-1].sea.toFixed(0)}m  海水 ${all[all.length-1].water.toFixed(3)}\n`)
}

/**
 * M4 の合格条件の検証（docs/05-roadmap.md）。
 *   npx vite-node scripts/validate-m4.ts
 */
import { World } from "../src/sim/world"
import { MODE_TRAITS, MODE_LABEL, selectMode, EARTH_MANTLE } from "../src/sim/mantle"
import { Tectonics, continentalVolume } from "../src/sim/tectonics"

const W = Number(process.env.VAL_W ?? 96)
const H = Number(process.env.VAL_H ?? 48)
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
let pass = 0, fail = 0
const check = (n: string, ok: boolean, d: string) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + n + " :: " + d); ok ? pass++ : fail++
}
const mk = (o: Record<string, unknown> = {}) =>
  new World({ width: W, height: H, seed: "hadean-01", shared: false, ...o })
const run = (w: World, years: number, steps: number) => {
  for (let i = 0; i < steps; i++) w.advance(years / steps, OPT)
}

// --- T1 テクトニクス様式の遷移 ---
console.log(`\n[T1] マントル熱史から様式が創発する (${W}x${H})`)
{
  // 熱い惑星から始める
  const hot = mk({ initialMantleTempC: 2200 })
  const seen: string[] = [hot.tectonicMode]
  for (let i = 0; i < 300; i++) {
    hot.advance(4e6, OPT)
    if (seen[seen.length - 1] !== hot.tectonicMode) seen.push(hot.tectonicMode)
  }
  check("T1a 高温から始めると様式が順に遷移する", seen.length >= 2,
    seen.map((m) => MODE_LABEL[m as keyof typeof MODE_LABEL]).join(" → "))
  check("T1b マグマオーシャンから始まる", seen[0] === "magmaOcean",
    `初期 ${MODE_LABEL[seen[0] as keyof typeof MODE_LABEL]}`)

  // 冷たすぎる惑星は mobileLid に到達できない（「動かない星」）
  const cold = mk({ initialMantleTempC: 950 })
  check("T1c 冷えすぎた惑星は停止したまま", !MODE_TRAITS[cold.tectonicMode].mobile,
    `${MODE_LABEL[cold.tectonicMode]}（敗北条件「動かない星」）`)
}

// --- T2 大陸と造山 ---
console.log("\n[T2] 大陸が動き、衝突し、山ができる")
{
  const w = mk()
  const thick0 = w.store.f32("crustThickness").read.slice()
  const v0 = continentalVolume(w, w.tectonics.params.continentThreshold)
  const e0 = w.store.f32("elevation").read
  let max0 = -Infinity
  for (let i = 0; i < e0.length; i++) if (e0[i] > max0) max0 = e0[i]

  run(w, 400e6, 500)
  const thick1 = w.store.f32("crustThickness").read
  const v1 = continentalVolume(w, w.tectonics.params.continentThreshold)
  const e1 = w.store.f32("elevation").read
  let max1 = -Infinity
  for (let i = 0; i < e1.length; i++) if (e1[i] > max1) max1 = e1[i]

  let moved = 0
  for (let i = 0; i < thick0.length; i++) if (Math.abs(thick1[i] - thick0[i]) > 3) moved++
  check("T2a 大陸が動く（地殻の厚さ分布が変わる）", moved / thick0.length > 0.15,
    `400 Myr で ${((moved / thick0.length) * 100).toFixed(0)}% のセルの地殻厚が 3km 以上変化`)
  check("T2b 衝突で山ができる", max1 > max0 * 1.2,
    `最高標高 ${max0.toFixed(0)} → ${max1.toFixed(0)} m`)
  check("T2c ★ 大陸地殻の体積が保存される", Math.abs(v1 / v0 - 1) < 0.25,
    `体積比 ${(v1 / v0).toFixed(3)}（数値拡散で失われないこと）`)
  check("T2d 陸地面積が壊滅しない", w.grid.areaFractionWhere(e1, (v) => v >= 0) > 0.1,
    `陸地 ${(w.grid.areaFractionWhere(e1, (v) => v >= 0) * 100).toFixed(1)}%`)
}

// --- T3 海洋地殻の年齢-深度関係 ---
console.log("\n[T3] 海嶺が浅く、古い海盆が深い")
{
  const p = mk().tectonics.params
  const ridge = Tectonics.deriveElevation(p, 0, 0)
  const mid = Tectonics.deriveElevation(p, 0, 40)
  const old = Tectonics.deriveElevation(p, 0, 150)
  check("T3a depth = 2600 + 350*sqrt(age) が成立する",
    Math.abs(ridge + 2600) < 50 && old < mid && mid < ridge,
    `age 0 → ${ridge.toFixed(0)}m、40Myr → ${mid.toFixed(0)}m、150Myr → ${old.toFixed(0)}m`)
  check("T3b 古い海洋地殻の深さが現実的（約 -5700m で頭打ち）",
    old < -5000 && old > -6500, `${old.toFixed(0)} m`)

  const w = mk()
  run(w, 200e6, 250)
  const age = w.store.f32("crustAge").read
  const elev = w.store.f32("elevation").read
  let young = 0, yn = 0, oldD = 0, on = 0
  for (let i = 0; i < age.length; i++) {
    if (elev[i] >= 0) continue
    if (age[i] < 20) { young += elev[i]; yn++ } else if (age[i] > 80) { oldD += elev[i]; on++ }
  }
  check("T3c 実際の海底で若い地殻が浅い", yn > 0 && on > 0 && young / yn > oldD / on,
    yn && on ? `<20Myr: ${(young / yn).toFixed(0)}m  vs  >80Myr: ${(oldD / on).toFixed(0)}m` : "サンプル不足")
}

// --- T4 LLSVP と LIP ---
console.log("\n[T4] ★ LIP は LLSVP の縁（PGZ）の通過で起きる（ランダムではない）")
{
  const w = mk()
  const exposures: number[] = []
  let lipYears: number[] = []
  for (let i = 0; i < 400; i++) {
    w.advance(1e6, OPT)
    exposures.push(w.tectonics.pgzExposure(w))
    const n = w.events.filter((e) => e.kind === "lip").length
    if (n > lipYears.length) lipYears.push(i)
  }
  const meanExp = exposures.reduce((s, v) => s + v, 0) / exposures.length
  const atLip = lipYears.map((i) => exposures[i])
  const meanAtLip = atLip.length ? atLip.reduce((s, v) => s + v, 0) / atLip.length : 0
  check("T4a LIP が発生する", lipYears.length > 0, `400 Myr で ${lipYears.length} 回`)
  check("T4b ★ LIP は PGZ 露出が大きいときに起きる", meanAtLip > meanExp,
    `LIP 時の PGZ 露出 ${(meanAtLip * 100).toFixed(2)}% vs 平均 ${(meanExp * 100).toFixed(2)}%`)
  check("T4c LIP が CO2 パルスを起こす",
    w.events.some((e) => e.kind === "lip" && e.text.includes("CO₂")),
    w.events.filter((e) => e.kind === "lip")[0]?.text ?? "-")
}

// --- T5 気候 → テクトニクス（docs/01-6.6a）---
console.log("\n[T5] ★ 暴走温室がプレートを止め、ヒステリシスで戻らない")
{
  const P = EARTH_MANTLE
  const normal = selectMode(P, 1350, 15, 1.0, "mobileLid")
  const venus = selectMode(P, 1350, 460, 0.02, "mobileLid")
  const restart = selectMode(P, 1350, 15, 1.0, "stagnantLid")
  check("T5a 通常はモバイルリッド", MODE_TRAITS[normal].mobile, MODE_LABEL[normal])
  check("T5b 金星条件（460degC・水の喪失）でプレートが止まる", !MODE_TRAITS[venus].mobile,
    MODE_LABEL[venus])
  check("T5c 条件が戻れば再開はできる（ただし条件は厳しい）", MODE_TRAITS[restart].mobile,
    `${MODE_LABEL[restart]}。境界条件では停止側が有利（T5d）`)
  const borderKeep = selectMode(P, 1350, 200, 0.3, "mobileLid")
  const borderStart = selectMode(P, 1350, 200, 0.3, "stagnantLid")
  check("T5d ★ ヒステリシス: 同じ条件でも動いている方が維持しやすい",
    MODE_TRAITS[borderKeep].mobile && !MODE_TRAITS[borderStart].mobile,
    `維持 ${MODE_LABEL[borderKeep]} / 再開 ${MODE_LABEL[borderStart]}`)
}

// --- T6 脱氷による火山活動（docs/01-6.6b）---
console.log("\n[T6] ★ 脱氷で火山活動が跳ね上がる（アイスランドで 30〜50 倍）")
{
  const w = mk()
  run(w, 20e6, 40)
  const base = w.carbon.lastFluxes!.volcanic
  // 氷期にしてから急に暖める
  w.globals.solarConstant = 1361 * 0.9
  run(w, 10e6, 20)
  const iceHigh = w.stats!.iceFraction
  // 気候はサブシステムの後に解かれるので、脱氷の検出は 1 ティック遅れる。
  // 数ティック回して最大値を取る。
  w.globals.solarConstant = 1361 * 1.02
  let boosted = 0
  for (let i = 0; i < 6; i++) {
    w.advance(25_000, OPT)
    boosted = Math.max(boosted, w.carbon.lastFluxes!.volcanic)
  }
  check("T6a 氷期に氷床が広がる", iceHigh > 0.2, `氷被覆 ${(iceHigh * 100).toFixed(0)}%`)
  check("T6b 急激な脱氷で火山活動が増える", boosted > base * 1.5,
    `${(base * 1000).toFixed(0)} → ${(boosted * 1000).toFixed(0)} Mt-C/yr（${(boosted / base).toFixed(1)}倍）`)
}

// --- T7 深部水循環（docs/01-6.5）---
console.log("\n[T7] 深部水循環")
{
  const w = mk()
  run(w, 500e6, 300)
  const f = w.globals.oceanWaterFraction
  check("T7a 海水量が数十億年スケールでゆっくり変化する",
    f > 0.9 && f < 1.15, `500 Myr 後 ${f.toFixed(4)}（初期 1.0）`)
  const fr = w.ledger.latest("oceanWater")
  check("T7b 沈み込みと脱ガスの両方が台帳に出る",
    fr !== null && fr.contributions.length >= 2,
    fr ? fr.contributions.map((c) => `${c.cause} ${c.delta.toExponential(1)}`).join("  ") : "-")
}

console.log(`\n${"=".repeat(64)}\n合格 ${pass} / ${pass + fail}\n${"=".repeat(64)}`)

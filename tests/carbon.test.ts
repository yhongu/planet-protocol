import { describe, it, expect } from "vitest"
import { World } from "../src/sim/world"

const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
// 炭素循環そのものを検証したいので固体地球は止める。
// テクトニクスを有効にすると地形が動き、風化の条件が変わってしまう。
const mk = () => new World({
  width: 64, height: 32, seed: "hadean-01", shared: false, enableTectonics: false,
})
const run = (w: World, years: number, steps: number) => {
  for (let i = 0; i < steps; i++) w.advance(years / steps, OPT)
}

describe("炭素循環と風化", () => {
  it("★ 較正は開始エポックに依存しない（現在の地球が基準だから）", () => {
    // 較正は「現在の地球は定常である」を火山脱ガス量の定義に使う。
    // だから【どのエポックから始めても較正定数は同じ】でなければならない。
    // 冥王代の状態（CO2 10万ppm・マントル 2250℃・液体の海なし）で較正すると
    // 定義そのものが壊れる。
    //
    // 2026-08-28 に内部熱流を足したとき、代入を較正より前に置いて
    // 冥王代の 285 W/m² で較正してしまい、顕生代の CO2 が 2.6e12 ppm、
    // 気温 117℃ で暴走した。**全史監査（30分）でしか見つからなかった。**
    // このテストなら構築だけで数秒で落ちる。
    const opts = { width: 64, height: 32, seed: "hadean-01", shared: false,
      enableTectonics: false } as const
    const now = new World(opts)
    const hadean = new World({ ...opts, startEpoch: "hadean" })
    const a = now.carbon.state!, b = hadean.carbon.state!
    expect(b.kDensity).toBeCloseTo(a.kDensity, 12)
    expect(b.sDensity).toBeCloseTo(a.sDensity, 12)
    expect(b.fTRef).toBeCloseTo(a.fTRef, 9)
    expect(b.erosionRef).toBeCloseTo(a.erosionRef, 9)
    expect(b.landArea).toBeCloseTo(a.landArea, 0)
    // 火山脱ガス量も較正から決まる量なので一致する
    expect(hadean.carbon.params.volcanicFlux)
      .toBeCloseTo(now.carbon.params.volcanicFlux, 9)
  })

  it("★ 基準状態が厳密に定常（較正の 2 拘束が満たされている）", () => {
    const w = mk()
    const st = w.carbon.state!
    expect(st.supplyLimitedRef).toBeCloseTo(w.carbon.params.supplyLimitedTarget, 2)
    run(w, 3e6, 60)
    expect(Math.abs(w.globals.co2 - 280)).toBeLessThan(30)
  })

  it("★ CO2 4倍の摂動が元に戻り、時定数が 10^5-10^6 年", () => {
    const w = mk()
    w.globals.co2 = 1120
    w.refresh(OPT)
    const target = 280 + (1120 - 280) / Math.E
    let tau = NaN
    for (let i = 0; i < 200; i++) {
      w.advance(15000, OPT)
      if (!Number.isFinite(tau) && w.globals.co2 <= target) tau = w.globals.yearsElapsed
    }
    expect(w.globals.co2).toBeLessThan(400)
    expect(tau).toBeGreaterThan(5e4)
    expect(tau).toBeLessThan(2e6)
  })

  it("★ 侵食を落とすとサーモスタットが弱り CO2 が上がる", () => {
    const w = mk()
    w.carbon.params.erosionFactor = 0.25
    run(w, 3e6, 100)
    expect(w.globals.co2).toBeGreaterThan(450)
    expect(w.stats!.meanT).toBeGreaterThan(16)
    expect(w.carbon.lastFluxes!.supplyLimitedFraction).toBeGreaterThan(0.4)
  })

  it("★ 応答は滑らかで、崖はない（1D のアーティファクトの否定）", () => {
    // 【終端の 1 点で見てはいけない】★2026-08-28
    //
    // CO2 は平衡の周りで振動するので、終端の 1 点は振動の位相を拾う。
    // 実測（侵食係数 0.688）: 終端 700ppm に対し、同じランの後半の中央値は 419ppm。
    // 0.0588 W/m² の内部熱流（0.024K 相当）を足しただけで、ある 1 点が
    // 469 -> 665ppm に跳ねて単調性が壊れた。**応答が壊れたのではなく測り方が悪い。**
    //
    // docs/01-6.5c の「単一ランの終端値で判断しない。中央値と分位点で見る」を
    // このテスト自身が破っていた。後半 50 ステップの中央値で見る。
    //
    // 【点ごとの単調性が成り立つのは中央値で見たときだけ】
    // 細かく掃引すると氷アルベドの双安定性で暖かい分枝に落ちる点がある
    // （侵食係数 1.187 で氷 0.101、両隣は 0.129 / 0.123）。
    // 双安定性はモデルが意図して持つ性質（climate.test.ts の分岐のテスト）。
    // 掃引を細かくするならこの主張は成り立たない。
    const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
    const co2s: number[] = []
    for (const e of [1.5, 1.0, 0.7, 0.5, 0.35, 0.25]) {
      const w = mk()
      w.carbon.params.erosionFactor = e
      const traj: number[] = []
      for (let k = 0; k < 100; k++) {
        run(w, 5e6 / 100, 1)
        if (k >= 50) traj.push(w.globals.co2)
      }
      co2s.push(med(traj))
    }
    // 【崖が無いこと】が主張であって、点ごとの厳密な単調性ではない。
    //
    // 6 点の標本で厳密な単調性を要求していたが、それは**運で通っていた**。
    // 氷アルベドの双安定性があるので、どの点がどちらの分枝に落ちるかは
    // 紙一重で決まる。実際 2026-08-29 に湿潤拡散の上限を入れた（较正済みの
    // 領域は 0.4% しか動いていない）だけで、侵食係数 0.5 の点が 0.35 を
    // 追い越した（500 対 485。氷率 0.068 対 0.069）。
    // 上のコメント自身が「掃引を細かくするとこの主張は成り立たない」と
    // 書いていたとおりだった。
    //
    // 測るべきは「隣り合う点で崖が無い」ことと「全体として上がる」こと。
    // 実測: 236 / 280 / 463 / 500 / 485 / 544
    for (let i = 1; i < co2s.length; i++) {
      // 逆行してもよいが、わずかであること（双安定性の紙一重の分だけ）
      expect(co2s[i] / co2s[i - 1]).toBeGreaterThan(0.9)
      expect(co2s[i] / co2s[i - 1]).toBeLessThan(3)
    }
    // 傾向として単調（順位相関）。1 点の逆行は許すが、傾きは必ず正
    let concordant = 0, total = 0
    for (let i = 0; i < co2s.length; i++) {
      for (let j = i + 1; j < co2s.length; j++) {
        total++
        if (co2s[j] > co2s[i]) concordant++
      }
    }
    expect(concordant / total).toBeGreaterThan(0.85)
    // 全体としては有意に上がる
    expect(co2s[co2s.length - 1] / co2s[1]).toBeGreaterThan(1.5)
  })

  it("★ 応答が飽和する — 全球の風化は少数の造山帯が担っている", () => {
    // 侵食の空間分布は 2 桁以上に広がる（山岳と楯状地）。
    // 侵食を一律に落としても、高侵食の「エンジン」領域は供給を保つので、
    // CO2 の上昇は飽和する。M2 の傾斜のみの暫定侵食では飽和しなかった。
    const co2s: number[] = []
    for (const e of [1.0, 0.5, 0.25, 0.12]) {
      const w = mk()
      w.carbon.params.erosionFactor = e
      run(w, 5e6, 100)
      co2s.push(w.globals.co2)
    }
    const r1 = co2s[1] / co2s[0]     // 1.0 -> 0.5
    const r3 = co2s[3] / co2s[2]     // 0.25 -> 0.12
    expect(r3).toBeLessThan(r1)      // 後半ほど鈍る = 飽和
  })

  it("★ 侵食の空間分布が 2 桁以上に広がる", () => {
    const w = mk()
    const ero = w.store.f32("erosionRate").read
    const e = w.store.f32("elevation").read
    const v: number[] = []
    for (let i = 0; i < ero.length; i++) if (e[i] >= 0) v.push(ero[i])
    v.sort((a, b) => a - b)
    const p10 = v[Math.floor(0.1 * v.length)]
    const p99 = v[Math.floor(0.99 * v.length)]
    expect(p99 / p10).toBeGreaterThan(100)
  })

  it("★ 造山でサーモスタットが復活する", () => {
    const w = mk()
    w.carbon.params.erosionFactor = 0.25
    run(w, 2e6, 60)
    const hot = w.globals.co2
    expect(hot).toBeGreaterThan(400)
    w.carbon.params.erosionFactor = 2.5
    run(w, 5e6, 100)
    expect(w.globals.co2).toBeLessThan(hot * 0.7)
  })

  it("★ CO2 の寄与分解が厳密に閉じる", () => {
    const w = mk()
    w.globals.co2 = 560
    w.refresh(OPT)
    w.advance(1e5, OPT)
    const fr = w.ledger.latest("co2")!
    const sum = fr.contributions.reduce((s, c) => s + c.delta, 0)
    expect(sum).toBeCloseTo(fr.total, 6)
    const by = new Map(fr.contributions.map((c) => [c.cause, c.delta]))
    expect(by.get("volcanism.arc")!).toBeGreaterThan(0)
    expect(by.get("weathering.kinetic")!).toBeLessThan(0)
    expect(by.get("weathering.supplyLimited")!).toBeLessThan(0)
    // サブステップをまたいでも残差が出ないこと
    expect(Math.abs(by.get("disequilibrium") ?? 0)).toBeLessThan(Math.abs(fr.total) * 0.01)
  })
})

describe("時間駆動", () => {
  it("エポックが年代から決まる", () => {
    const w = mk()
    expect(w.epoch.id).toBe("hadean")
    w.globals.yearsElapsed = 4.54e9 - 3.0e9      // 30 億年前
    expect(w.epoch.id).toBe("archean")
    w.globals.yearsElapsed = 4.54e9 - 0.3e9      // 3 億年前
    expect(w.epoch.id).toBe("phanerozoic")
  })

  it("★ 速度は物理上限 (2M 年/秒) を超えない", () => {
    const w = mk()
    // ★2026-08-31 に速度を絶対値の段にした（`loop.ts` の SPEED_STEPS）。
    // 以前は時代ごとの基準速度 × 倍率で、同じ ×1 でも時代で速さが変わった
    expect(w.yearsPerSecond(20)).toBeLessThanOrEqual(2_000_000)
    expect(w.yearsPerSecond(0)).toBe(0)
    expect(w.yearsPerSecond(1)).toBe(100_000)
    expect(w.yearsPerSecond(20)).toBe(2_000_000)
  })

  it("★ 大きすぎるステップはサブステップに刻まれる", () => {
    const w = mk()
    const r = w.advance(400_000, OPT)
    // 炭素循環の preferredStepYears は 25000
    expect(r.substeps).toBeGreaterThan(1)
    expect(r.yearsAdvanced / r.substeps).toBeLessThanOrEqual(w.carbon.maxStepYears)
  })

  it("★ 大きな要求でも時間が黙って捨てられない", () => {
    // 以前は SimLoop のサブステップ上限に当たると進行年数が減り、
    // throttled で通知していた。いまは World.advance が
    // 結合間隔（5 万年）ごとに区切って回すので、要求どおり進む。
    // 時間を落とさないという保証は変わっていない（むしろ強くなった）。
    const w = mk()
    const r = w.advance(1e7, OPT)
    expect(r.yearsAdvanced).toBeGreaterThan(0.99 * r.yearsRequested)
    expect(r.yearsAdvanced).toBeLessThanOrEqual(r.yearsRequested)
  })

  it("★ 結合間隔を変えても進行年数は同じ（精度だけが変わる）", () => {
    const fine = mk()
    const coarse = new World({
      width: 64, height: 32, seed: "hadean-01", shared: false,
      climateCouplingYears: 500_000,
    })
    const a = fine.advance(2e6, OPT), b = coarse.advance(2e6, OPT)
    expect(a.yearsAdvanced).toBeCloseTo(b.yearsAdvanced, -3)
    expect(fine.globals.yearsElapsed).toBeCloseTo(coarse.globals.yearsElapsed, -3)
  })
})

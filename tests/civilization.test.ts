import { describe, it, expect } from "vitest"
import {
  Civilization, EARTH_CIV, CIV_FIELDS, logisticStep, relaxStep, techLossLambda,
  type Civ,
} from "../src/sim/civilization"
import {
  TECHS, TECH_INDEX, ROLE_PROVIDERS, techPrereqOk, techGateOk, sumTech,
} from "../src/sim/tech"
import {
  EPOCHS, SPEED_STEPS, CIV_SPEED_STEPS, resolveSpeed, couplingForSpeed, tickYears,
} from "../src/sim/loop"

/**
 * ★★**時間解像度の独立性**（M6 の設計上の契約。2026-09-08）。
 *
 * 案 A-2（知性が生まれたら「降りるか」を選ぶ）を成立させるには、
 * **降りても降りなくても結果が同じ**でなければならない:
 *
 *   降りないと文明が進まない → **降りるのが必須**になり A-2 の意味が消える
 *   降りると結果が変わる     → **降りるのが裏技**になる
 *
 * これは空間の解像度独立性（`docs/04-8.8`・`tests/resolution.test.ts`）の
 * **時間版**である。同じ文明を 2 つの刻みで回して、集計が同じ範囲に入ること。
 *
 * ★**この模型が何度も失敗している形**（後から合わせようとして打ち消し合う。
 * `CLAUDE.md` の 19）を避けるため、**機構を書く前にテストを置く**。
 *
 * いまは枠だけなので、契約の形と「既定では何も起きない」ことを固定する。
 * 中身が入ったら、下の `it.todo` を実測で埋める。
 */
describe("文明（M6）", () => {
  it("★既定で有効。ただし知性が現れるまでは動かない", () => {
    // ★2026-09-08 に既定を 1 にした（①〜⑥ が揃い、4 つの契約が通ったため）。
    //   ★**知性が生まれるまでは何もしない**ので、生命への回帰は無い ——
    //   実測で、知性が生まれない 5 seed は系統数・生物圏・O2 が
    //   既定 0 のときと一致した（罠 51 の検査）
    expect(EARTH_CIV.enabled).toBe(1)
    const civ = new Civilization()
    expect(civ.state.emergedYear).toBe(-1)
    expect(civ.isActive({} as never)).toBe(false)   // 知性がまだ現れていない
  })

  it("★場は 2 つ（人口・土地利用）で、どちらも 1 セル 1 値", () => {
    const names = CIV_FIELDS.map((f) => f.name)
    expect(names).toContain("population")
    expect(names).toContain("landUse")
    // ★レーンを持たない（クレードごとではなく地域ごと）
    for (const f of CIV_FIELDS) expect(f.lanes).toBeUndefined()
  })

  it("★保存と復元が往復する（`CLAUDE.md` の 67）", () => {
    const a = new Civilization()
    a.state.totalPopulation = 1.23e8
    a.state.energyPerCapita = 2100
    a.state.emergedYear = 4.4e9
    const b = new Civilization()
    b.restore(a.snapshot())
    expect(b.state.totalPopulation).toBe(a.state.totalPopulation)
    expect(b.state.energyPerCapita).toBe(a.state.energyPerCapita)
    expect(b.state.emergedYear).toBe(a.state.emergedYear)
  })

  it("★★時間解像度の独立性: 100 年刻み × 1 万回 = 100 万年刻み × 1 回", () => {
    // ★これが M6 の設計上の契約。降りても降りなくても結果が同じでなければ、
    //   降りるのが必須（A-2 の意味が消える）か裏技（結果が変わる）になる。
    const K = 1.2e8, r = 1e-3, N0 = 1e4
    let fine = N0
    for (let i = 0; i < 10_000; i++) fine = logisticStep(fine, K, r, 100)
    const coarse = logisticStep(N0, K, r, 1_000_000)
    // ★解析解なので**丸め誤差だけ**しか違わない
    expect(Math.abs(fine / coarse - 1)).toBeLessThan(1e-9)
  })

  it("★★オイラー法だと刻みで答えが変わる（なぜ解析解が要るかの対照）", () => {
    // ★**対照が本当に対照かを値で示す**（罠 39）。
    //   これが無いと「解析解にした意味」が後から読む人に伝わらない
    const K = 1.2e8, r = 1e-3, N0 = 1e4
    const euler = (n: number, dt: number) => n + r * n * (1 - n / K) * dt
    let fine = N0
    for (let i = 0; i < 10_000; i++) fine = euler(fine, 100)
    const coarse = euler(N0, 1_000_000)
    // 粗い刻みでは 1 歩で K を大きく飛び越える（発散する）
    expect(Math.abs(fine / coarse - 1)).toBeGreaterThan(0.5)
  })

  it("★緩和（土地利用）も刻みに依らない", () => {
    const tau = 5e4, target = 0.6, x0 = 0.05
    let fine = x0
    for (let i = 0; i < 10_000; i++) fine = relaxStep(fine, target, tau, 100)
    const coarse = relaxStep(x0, target, tau, 1_000_000)
    expect(Math.abs(fine - coarse)).toBeLessThan(1e-12)
  })

  it("ロジスティックは 0 と K で止まり、K を超えない", () => {
    expect(logisticStep(0, 100, 1e-3, 1e6)).toBe(0)
    expect(logisticStep(100, 100, 1e-3, 1e6)).toBeCloseTo(100, 6)
    // 収容力が減った惑星では人口が減る（★餓死も同じ式で出る）
    expect(logisticStep(100, 50, 1e-3, 1e6)).toBeLessThan(100)
    expect(logisticStep(1, 100, 1e-3, 1e9)).toBeCloseTo(100, 6)
  })
  it("★知性種が絶滅したら文明も畳まれる（作った種が消えて都市が残らない）", () => {
    // ★実測で踏んだ: これを書く前は知性種 0 の惑星に**人口 21 億人が残り続けた**。
    //   ロジスティックの K が 0 になるだけでは「増えない」しか意味しない
    const civ = new Civilization({ enabled: 1, collapseTauYears: 1e5 })
    civ.state.totalPopulation = 2.1e9
    civ.state.energyPerCapita = 300
    // 知性種がいない世界（クレードなし）で 100 万年
    // ★複数文明にしたので `civId`（u8）も要る
    const fake = {
      grid: { cellCount: 1, W: 1, H: 1, cellArea: [1], areaWeight: [1] },
      store: {
        f32: () => ({ read: new Float32Array(1) }),
        u8: () => ({ read: new Uint8Array(1) }),
      },
      life: { clades: [] },
      globals: { yearsElapsed: 0 },
    } as never
    // ★1 歩では 0 にならない（τ=10 万年で 100 万年なら exp(−10) が残る）。
    //   **指数減衰は 0 に漸近するだけ**なので、「いつ 0 と呼ぶか」は別の判断。
    //   最初 1 歩で 0 を期待して落ちた —— テストが実態を教えてくれた
    civ.update(fake, 1e6)
    expect(civ.state.totalPopulation).toBeLessThan(2.1e9 * 1e-4)
    civ.update(fake, 1e6)
    civ.update(fake, 1e6)
    expect(civ.state.totalPopulation).toBe(0)
    expect(civ.state.energyPerCapita).toBe(0)
  })

  it("★★崩壊が内生する（Tainter の収穫逓減。外から与えない）", () => {
    // ★複雑さが上がるほど維持費が収量を食い、**収容力そのものが下がる**。
    //   隕石も気候変動も与えていないのに人口が減る = 内生的な崩壊。
    //   実測（顕生代の章・2000 万年）で、文明 #7 は最盛の 16%、#3 は 37% に落ちた
    const p = EARTH_CIV
    const upkeep = (complexity: number) => 1 - p.complexityCost * complexity
    expect(upkeep(0)).toBe(1)                       // 技術が無ければ維持費も無い
    expect(upkeep(1)).toBeLessThan(1)               // 技術を持つほど削られる
    // ★複雑さが 1/complexityCost を超えると収量が 0 になる（＝崩壊の底）
    expect(upkeep(1 / p.complexityCost + 0.1)).toBeLessThan(0)
    // 収容力が現在の人口を下回れば、ロジスティックは**減る方向**に働く
    expect(logisticStep(1e9, 5e8, 1e-3, 1e5)).toBeLessThan(1e9)
  })
  it("★★惑星が許さない技術は永久に発明できない（火には酸素が要る）", () => {
    // ★燃焼限界 —— 大気の酸素が 16% 未満だと火は燃えない。
    //   実測: 原生代の章（O2 9%）では**石器と儀礼だけ**で止まり、
    //   顕生代の章（O2 26%）では 37 技術すべてに到達した。
    //   ★これが「惑星ごとに技術史が変わる」の実体（罠 87）
    const fire = TECH_INDEX.get("fire")!
    const poor = { o2: 9, buriedC: 1e20, felsic: 6e9, land: 0.25, ocean: 0.75, river: 1 }
    const rich = { ...poor, o2: 26 }
    expect(techGateOk(fire, poor)).toBe(false)
    expect(techGateOk(fire, rich)).toBe(true)
    // ★石炭紀が無かった惑星には化石燃料が無い
    const fossil = TECH_INDEX.get("fossilFuel")!
    expect(techGateOk(fossil, { ...rich, buriedC: 1e18 })).toBe(false)
    expect(techGateOk(fossil, rich)).toBe(true)
  })

  it("★鎖は緩めない（前提を全部持っていないと引けない）", () => {
    const has = TECHS.map(() => false)
    const iron = TECH_INDEX.get("iron")!
    expect(techPrereqOk(has, iron)).toBe(false)
    // 鉄には青銅が、青銅には銅と交易が…と遡って全部要る
    for (const n of ["stoneTools", "fire", "pottery", "agriculture", "copper",
      "boats", "trade", "bronze"]) has[TECH_INDEX.get(n)!] = true
    expect(techPrereqOk(has, iron)).toBe(true)
  })

  it("★★代替経路: 同じ役割を別の技術で満たせる（機能は収斂する）", () => {
    // ★交易は「何かで運べれば」成り立つ —— 舟でも畜力でも車輪でもよい。
    //   これが無いと、技術を増やしても一本道が長くなるだけになる
    const trade = TECH_INDEX.get("trade")!
    const base = () => {
      const h = TECHS.map(() => false)
      for (const n of ["stoneTools", "fire", "pottery"]) h[TECH_INDEX.get(n)!] = true
      return h
    }
    const byBoat = base(); byBoat[TECH_INDEX.get("boats")!] = true
    const byDraft = base()
    for (const n of ["agriculture", "draft"]) byDraft[TECH_INDEX.get(n)!] = true
    expect(techPrereqOk(base(), trade)).toBe(false)      // 運ぶ手段が無い
    expect(techPrereqOk(byBoat, trade)).toBe(true)       // 海の惑星は舟で
    expect(techPrereqOk(byDraft, trade)).toBe(true)      // 内陸の惑星は畜力で
  })

  it("★役割は複数の技術が果たす（代替経路が実在する）", () => {
    // ★1 つしか提供者がいない役割は「代替」になっていない
    for (const [role, providers] of ROLE_PROVIDERS) {
      if (role === "farming") continue   // 農耕は今のところ 1 本道（既知）
      expect(providers.length, `役割 ${role} の提供者`).toBeGreaterThan(1)
    }
  })

  it("★すべての技術に維持費がある（トレードオフの無い技術は全員が持つ。罠 44）", () => {
    for (const t of TECHS) expect(t.complexity).toBeGreaterThan(0)
    // ★合計の維持費が 1 を超えること —— そうでないと Tainter の
    //   収穫逓減が効かず、技術を増やすほど無条件に得になる
    expect(sumTech(TECHS.map(() => true)).complexity).toBeGreaterThan(1)
  })

  it("★★孤立した文明は技術を失う（Henrich のタスマニア効果）", () => {
    const p = EARTH_CIV
    const lam = (pop: number, retention = 1) =>
      techLossLambda(0.2, pop, retention, p.lossRate, p.lossPopRef)
    // ★**小さい文明ほど速く失う**（人口に反比例）
    expect(lam(5e7)).toBeGreaterThan(lam(2.4e9))
    expect(lam(5e7) / lam(2.4e9)).toBeCloseTo(2.4e9 / 5e7, 0)
    // ★**複雑な技術ほど先に失われる**
    const simple = techLossLambda(0.02, 1e8, 1, p.lossRate, p.lossPopRef)
    const complex = techLossLambda(0.5, 1e8, 1, p.lossRate, p.lossPopRef)
    expect(complex).toBeGreaterThan(simple * 20)
    // ★**情報の保持（文字・印刷）が失伝を抑える**
    expect(lam(1e8, 3)).toBeLessThan(lam(1e8, 1))
    // ★目盛りの確認: 100 万年刻みで**規模の差が確率に出る**こと。
    //   最初 3e4 にしたら両方 1.0 に飽和して差が消えた（実測で気づいた）
    const pSmall = 1 - Math.exp(-lam(5e7) * 1e6)
    const pBig = 1 - Math.exp(-lam(2.4e9) * 1e6)
    expect(pSmall).toBeGreaterThan(pBig * 5)
  })
  it("★★由来 id で独立発明と伝播を区別できる（機能は収斂する）", () => {
    // ★`docs/02` の中心的主張の文明版。実測で「畜力を 4 文明が持ち、
    //   由来は 1 種類」＝ 1 つが発明して 3 つに伝わった、と読めた
    const civ = new Civilization({ enabled: 1 })
    const mk = (id: number): Civ => ({
      id, foundedYear: 0, population: 1e6, energyPerCapita: 300,
      tech: TECHS.map(() => false), techOrigin: TECHS.map(() => -1),
      peakPopulation: 1e6, lostCount: 0,
    })
    const a = mk(1), b = mk(2), c = mk(3)
    const fire = TECH_INDEX.get("fire")!
    // a と b は別々に発明（由来が違う）、c は a から伝わった（由来が同じ）
    a.tech[fire] = true; a.techOrigin[fire] = 10
    b.tech[fire] = true; b.techOrigin[fire] = 11
    c.tech[fire] = true; c.techOrigin[fire] = 10
    civ.state.civs = [a, b, c]
    const origins = new Set([a, b, c].map((x) => x.techOrigin[fire]))
    expect(origins.size).toBe(2)                    // 2 系統の由来
    expect(a.techOrigin[fire]).toBe(c.techOrigin[fire])  // ★a→c は伝播
    expect(a.techOrigin[fire]).not.toBe(b.techOrigin[fire]) // a と b は収斂
  })
})

/**
 * ★★**降りたら時計が人間の尺度になる**（2026-09-09。プレイして要望された）。
 *
 * 惑星の段（10 万〜200 万年/秒）では文明史の 1 万年が 0.005 秒で通り過ぎる。
 * ★**倍率の番号は変えず（×1 ×5 ×10 ×20）、1 秒あたりの年数だけ替える。**
 */
describe("降りたときの速度の段", () => {
  const epoch = EPOCHS.find((e) => e.id === "phanerozoic")!
  it("×1 = 10 年/秒 … ×20 = 200 年/秒", () => {
    expect(resolveSpeed(epoch, 1, true)).toBe(10)
    expect(resolveSpeed(epoch, 5, true)).toBe(50)
    expect(resolveSpeed(epoch, 10, true)).toBe(100)
    expect(resolveSpeed(epoch, 20, true)).toBe(200)
  })
  it("降りていなければ惑星の段のまま（★既定を壊していないこと）", () => {
    for (const s of SPEED_STEPS) {
      expect(resolveSpeed(epoch, s.multiplier, false)).toBe(s.yearsPerSecond)
    }
  })
  it("★★時間が止まらない: 刻みが結合間隔より小さくならない罠", () => {
    // `simWorker` は step = max(tickYears, coupling) で進める。
    // 結合が 5 万年のままだと 10 年/秒では 5000 秒かかって**画面が凍る**。
    // ★**1 秒あたり少なくとも 1 歩は進むこと**を検査する
    for (const st of CIV_SPEED_STEPS) {
      const yps = resolveSpeed(epoch, st.multiplier, true)
      const step = Math.max(tickYears(yps), couplingForSpeed(st.multiplier, true))
      expect(step).toBeLessThanOrEqual(yps)
      // ★★`World.chunked` は `while (remaining > 1)` で刻むので、
      //   **1 年ちょうどの歩は 1 つも実行されない**（実測で 1 秒に 0 年進んだ）。
      //   段の側が 2 年以上であることを見張る
      expect(step).toBeGreaterThan(1)
    }
  })
  it("★文明の刻みは降りたときだけ細かくなる", () => {
    const civ = new Civilization({ enabled: 1 })
    expect(civ.preferredStepYears).toBe(1_000_000)
    civ.focused = true
    expect(civ.preferredStepYears).toBe(EARTH_CIV.focusStepYears)
    // ★**サブステップが溢れないこと。** `SubsystemLoop` は
    //   min(preferredStepYears) に合わせるので、1 秒ぶんの年数を
    //   その刻みで割った回数が上限（16）を超えると throttle される
    const yps = resolveSpeed(epoch, 20, true)
    expect(Math.ceil(tickYears(yps) / civ.preferredStepYears)).toBeLessThanOrEqual(16)
  })
})

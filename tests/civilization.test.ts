import { describe, it, expect } from "vitest"
import {
  Civilization, EARTH_CIV, CIV_FIELDS, logisticStep, relaxStep,
} from "../src/sim/civilization"
import {
  TECHS, TECH_INDEX, ROLE_PROVIDERS, techPrereqOk, techGateOk, sumTech,
} from "../src/sim/tech"

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
  it("★既定は無効（未検証の物理を既定に残さない）", () => {
    expect(EARTH_CIV.enabled).toBe(0)
    const civ = new Civilization()
    // 知性が現れていなければ、有効にしても動かない
    expect(civ.state.emergedYear).toBe(-1)
    expect(civ.isActive({} as never)).toBe(false)
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

  it.todo("★崩壊が内生する（Tainter の収穫逓減。外から与えない）")
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

  it.todo("★孤立した文明は技術を失う（Henrich のタスマニア効果）")
  it.todo("★由来 id で独立発明と伝播を区別できる")
})

import { describe, it, expect } from "vitest"
import {
  Civilization, EARTH_CIV, CIV_FIELDS, logisticStep, relaxStep,
} from "../src/sim/civilization"

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
  it.todo("★崩壊が内生する（Tainter の収穫逓減。外から与えない）")
  it.todo("★孤立した文明は技術を失う（Henrich のタスマニア効果）")
  it.todo("★由来 id で独立発明と伝播を区別できる")
})

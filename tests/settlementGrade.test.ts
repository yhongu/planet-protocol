import { describe, it, expect } from "vitest"
import { TECHS, TECH_INDEX } from "../src/sim/tech"
import {
  settlementOf, settlementOfIndices, SETTLEMENTS, SETTLEMENT_LABEL,
} from "../src/ui/settlementGrade"

/**
 * ★**集落の段階**（地図と文明タブに置く建物の絵を 1 枚選ぶ）。
 * `docs/07-art-spec.md` §7.7。
 */
describe("集落の段階", () => {
  const has = (...names: string[]) => {
    const a = new Array<boolean>(TECHS.length).fill(false)
    for (const n of names) {
      const k = TECH_INDEX.get(n)
      expect(k, `技術 ${n} が無い`).toBeDefined()
      a[k!] = true
    }
    return a
  }

  it("技術ゼロは集落", () => {
    expect(settlementOf(has())).toBe("camp")
  })
  it("農耕で農村、金属で城壁、官僚制で石造、蒸気で産業、電気で近代", () => {
    expect(settlementOf(has("agriculture"))).toBe("village")
    expect(settlementOf(has("agriculture", "bronze"))).toBe("walled")
    expect(settlementOf(has("agriculture", "bronze", "bureaucracy"))).toBe("stone")
    expect(settlementOf(has("agriculture", "bronze", "bureaucracy", "steam")))
      .toBe("industrial")
    expect(settlementOf(has("agriculture", "steam", "electricity"))).toBe("modern")
  })
  it("★上の段を持っていれば下は見ない（優先順位であって梯子ではない）", () => {
    // ★**段を飛ばす惑星がある。** 化石燃料の無い惑星は蒸気機関に届かないので、
    //   官僚制まで行っても石造で止まる —— それが正しい姿
    expect(settlementOf(has("semiconductor"))).toBe("modern")
    expect(settlementOf(has("steam"))).toBe("industrial")
  })
  it("★失伝して段が戻る（技術を失えば絵も戻る）", () => {
    const rich = has("agriculture", "bronze", "bureaucracy", "steam", "electricity")
    expect(settlementOf(rich)).toBe("modern")
    rich[TECH_INDEX.get("electricity")!] = false
    expect(settlementOf(rich)).toBe("industrial")
    rich[TECH_INDEX.get("steam")!] = false
    expect(settlementOf(rich)).toBe("stone")
  })
  it("添字の並びからも同じ答えになる（`CivInfo.tech` の形）", () => {
    const k = TECH_INDEX.get("steam")!
    expect(settlementOfIndices([k])).toBe(settlementOf(has("steam")))
  })
  it("★全部の段に日本語の名前がある（画面に出す）", () => {
    for (const s of SETTLEMENTS) {
      expect(SETTLEMENT_LABEL[s], s).toBeTruthy()
    }
  })
})

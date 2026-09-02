import { describe, it, expect } from "vitest"
import { EPOCHS, MAX_YEARS_PER_SECOND, SPEED_STEPS, epochAt, resolveSpeed, tickYears } from "../src/sim/loop"

const AGE = 4.54e9

describe("エポックと時間設計", () => {
  it("年代からエポックが決まる", () => {
    expect(epochAt(0, AGE).id).toBe("hadean")
    expect(epochAt(AGE - 3.0e9, AGE).id).toBe("archean")
    expect(epochAt(AGE - 1.5e9, AGE).id).toBe("proterozoic")
    expect(epochAt(AGE - 0.3e9, AGE).id).toBe("phanerozoic")
  })

  it("エポックが年代の降順に並んでいる", () => {
    for (let i = 1; i < EPOCHS.length; i++) {
      expect(EPOCHS[i].startGa).toBeLessThan(EPOCHS[i - 1].startGa)
    }
  })

  it("★ どの速度倍率でも物理上限を超えない", () => {
    for (const e of EPOCHS) {
      for (const m of [0, 1, 4, 16, 64]) {
        expect(resolveSpeed(e, m)).toBeLessThanOrEqual(MAX_YEARS_PER_SECOND)
      }
    }
  })

  it("★ 全編の所要時間（速度を絶対値にしたので設計目標も変わった）", () => {
    // ★2026-08-31 に「時代ごとの基準速度 × 倍率」から
    // 「絶対値の段 + 時代ごとの天井」に変えた。先カンブリア時代を
    // 自動で速く流さなくなったぶん、×1 は長くなる（12 時間級）。
    // **速く見たいときはプレイヤーが段を上げる**、という設計に寄せた。
    let total = 0
    for (let i = 0; i < EPOCHS.length; i++) {
      const start = EPOCHS[i].startGa
      const end = i + 1 < EPOCHS.length ? EPOCHS[i + 1].startGa : 0
      total += (start - end) * 1e9
    }
    const hours = (mult: number) => {
      let s = 0
      for (let i = 0; i < EPOCHS.length; i++) {
        const start = EPOCHS[i].startGa
        const end = i + 1 < EPOCHS.length ? EPOCHS[i + 1].startGa : 0
        s += ((start - end) * 1e9) / resolveSpeed(EPOCHS[i], mult)
      }
      return s / 3600
    }
    expect(total).toBeGreaterThan(4.4e9)
    // ×1（10万年/秒）で 12 時間級、最上段（200万年/秒）で 1 時間以内
    expect(hours(1)).toBeGreaterThan(10)
    expect(hours(1)).toBeLessThan(15)
    expect(hours(20)).toBeLessThan(1)
  })

  it("人新世だけ速度に天井がある（500 年しかないので地質の速度で流せない）", () => {
    const anth = EPOCHS.find((e) => e.id === "anthropocene")!
    expect(anth.maxYearsPerSecond).toBeLessThan(1000)
    for (const e of EPOCHS) {
      if (e.id === "anthropocene") continue
      expect(e.maxYearsPerSecond).toBeGreaterThanOrEqual(2_000_000)
    }
  })

  it("★速度の段は絶対値で、どの時代でも同じ年数/秒になる", () => {
    // 「×1 なのに時代で速さが変わる」のをやめた（2026-08-31）
    const had = EPOCHS.find((e) => e.id === "hadean")!
    const pha = EPOCHS.find((e) => e.id === "phanerozoic")!
    for (const s of SPEED_STEPS) {
      expect(resolveSpeed(had, s.multiplier)).toBe(s.yearsPerSecond)
      expect(resolveSpeed(pha, s.multiplier)).toBe(s.yearsPerSecond)
    }
    // 一時停止
    expect(resolveSpeed(had, 0)).toBe(0)
  })

  it("★段はすべて丸い年数（表示が 100.5 のようにならない）", () => {
    for (const s of SPEED_STEPS) {
      expect(s.yearsPerSecond % 100_000).toBe(0)
    }
  })

  it("★どの段も毎秒およそ 20 ティックに落ちる（階段が合っている）", () => {
    for (const s of SPEED_STEPS) {
      const ticks = s.yearsPerSecond / tickYears(s.yearsPerSecond)
      expect(ticks).toBeGreaterThanOrEqual(10)
      expect(ticks).toBeLessThanOrEqual(40)
    }
  })
})

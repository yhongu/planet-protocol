import { describe, it, expect } from "vitest"
import {
  EARTH_OXYGEN, EARTH_BURIAL, EARTH_BURIAL_MARINE, EARTH_BURIAL_LAND,
  EARTH_NEW_PRODUCTION, burialAtReference,
} from "../src/sim/oxygen"

/**
 * ★**供給側の見張り**（`CLAUDE.md` の 94）。
 *
 * 吸い込み側（還元剤 2.0e12 + 酸化的風化 8.0e12 = 1.0e13 mol/yr）は
 * 地球の実測がそのまま入っているのに、**供給側（有機炭素の埋没）には
 * 「地球と比べて妥当か」の検査が無かった**。
 * その結果、埋没を決める `recalcitrance` が**適応度に 0 箇所**の
 * 中立形質のまま、惑星の酸素の全域（7〜43%）を動かしていた。
 */
describe("酸素の供給側の較正", () => {
  it("★契約: 現在の地球の条件で【海の】埋没が 7e12 mol C/yr になる", () => {
    // 中央の形質（recalcitrance 0.5）で釣り合わせる
    expect(Math.abs(burialAtReference(EARTH_OXYGEN) / EARTH_BURIAL_MARINE - 1))
      .toBeLessThan(0.05)
  })

  it("★海だけでは吸い込みに届かない（陸が要る）", () => {
    // 地球の 1.0e13 は 海 ~7e12 + 陸 ~3e12。**海だけで釣り合わせない**こと ——
    // 海を上げて陸の欠落を隠すと、原生代の「退屈な 10 億年」が潰れる（罠 19）
    const sink = EARTH_OXYGEN.reductantPresent
      + EARTH_OXYGEN.oxidativeWeatheringPresent
    expect(burialAtReference(EARTH_OXYGEN)).toBeLessThan(sink * 0.8)
    expect(EARTH_BURIAL_MARINE + EARTH_BURIAL_LAND).toBeCloseTo(EARTH_BURIAL, -11)
    expect(Math.abs((EARTH_BURIAL_MARINE + EARTH_BURIAL_LAND) / sink - 1))
      .toBeLessThan(0.05)
  })

  it("海の埋没は新生産の 0.5〜1%（地球の値）", () => {
    const frac = burialAtReference(EARTH_OXYGEN) / EARTH_NEW_PRODUCTION
    expect(frac).toBeGreaterThan(0.004)
    expect(frac).toBeLessThan(0.012)
  })

  it("★形質が振り回す幅は 1.5 倍まで（それ以上だと O2 が形質で決まる）", () => {
    const lo = burialAtReference(EARTH_OXYGEN, 0)
    const hi = burialAtReference(EARTH_OXYGEN, 1)
    // 平衡 O2 は埋没の 2 乗で効くので、ここが 3 倍あると 7〜43% に散る
    expect(hi / lo).toBeLessThan(1.5)
    // ただし 1 倍（＝形質が効かない）にはしない。幅を作る役は残す
    expect(hi / lo).toBeGreaterThan(1.05)
  })
})

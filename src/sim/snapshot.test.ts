/**
 * **セーブとロードの受け入れ試験。**
 *
 * ★判定は「もっともらしい値が出るか」ではなく、
 * **保存して読み込んだ惑星が、保存しなかった惑星と 1 ビットも違わないか**。
 *
 * 決定論が契約なので（`docs/04-6`）、これが唯一の正しい判定である。
 * 「だいたい合っている」は失格 —— **ビット単位の差が 20 億年後に
 * 陸地面積 3 ポイントの差になる**（`CLAUDE.md` の 11）。
 *
 * ★このテストは**何を保存し忘れたかを教えてくれる**。
 * 状態を足したのに `snapshot()` に入れ忘れると、ここが赤くなる。
 */
import { describe, it, expect } from "vitest"
import { World } from "./world"
import { saveWorld, loadWorld } from "./snapshot"

const OPT = { cgTol: 1e-2, maxOuter: 8, tol: 1e-4 } as const

/** 惑星の「指紋」。ここに出ない量がずれていても気づけないので、広く採る */
function fingerprint(w: World): Record<string, number | string> {
  const e = w.store.f32("elevation").read
  const bio = w.store.has("biomassTotal") ? w.store.f32("biomassTotal").read : null
  let eSum = 0, eSq = 0, bSum = 0
  for (let i = 0; i < e.length; i++) { eSum += e[i]; eSq += e[i] * e[i] }
  if (bio) for (let i = 0; i < bio.length; i++) bSum += bio[i]
  const ps = w.tectonics.parcels
  let pSum = 0
  if (ps) for (let i = 0; i < ps.limit; i++) if (ps.alive[i]) pSum += ps.thick[i] + ps.x[i]
  return {
    years: w.globals.yearsElapsed,
    co2: w.globals.co2, ch4: w.globals.ch4, o2: w.globals.o2,
    ocean: w.globals.oceanWaterFraction, steam: w.globals.steamFraction,
    meanT: w.stats?.meanT ?? 0,
    ice: w.stats?.iceFraction ?? 0,
    mantle: w.mantle.state.temperature, mode: w.mantle.state.mode,
    elevSum: eSum, elevSq: eSq,
    parcelSum: pSum, parcelCount: ps?.count ?? 0,
    biomass: bSum, clades: w.life.clades.length,
    events: w.events.length,
    thc: w.ocean.state.overturningSv ?? 0,
    volcanicFlux: w.carbon.params.volcanicFlux,
  }
}

describe("セーブとロード", () => {
  it("往復した惑星は、保存しなかった惑星と 1 ビットも違わない", () => {
    // 冥王代から少し回す。★生命・粒子・海・炭素が全部動いている時点で保存する
    //   （現在の地球で試すと、動いていない機構の取りこぼしを見逃す）
    const a = new World({
      width: 48, height: 24, seed: "snap-test", shared: false,
      startEpoch: "hadean", climateCouplingYears: 200_000,
    })
    for (let i = 0; i < 40; i++) a.advance(400_000, OPT)

    const bytes = saveWorld(a)
    const b = loadWorld(bytes)

    // 保存した瞬間の一致
    expect(fingerprint(b)).toEqual(fingerprint(a))

    // ★**ここが本番。** 復元した惑星を進めて、進め続けた惑星と比べる。
    // 乱数の途中経過や判定の履歴を落としていると、ここで初めてずれる
    for (let i = 0; i < 25; i++) { a.advance(400_000, OPT); b.advance(400_000, OPT) }
    expect(fingerprint(b)).toEqual(fingerprint(a))
  })

  it("生命が動いている時点でも、往復して 1 ビットも違わない", () => {
    // ★**生命が生まれた後で保存する。** クレード・ゲノム・由来 id・レーンは
    // どれも保存し忘れやすく、しかも**絶滅と分岐が起きるまで表に出ない**
    const a = new World({
      // ★seed は「生命が早く出るもの」を実測で選んである（48x24 で 366Myr・20 秒）。
      // snap-life は 655Myr かかってテストが 2 倍重くなった
      width: 48, height: 24, seed: "hadean-01", shared: false,
      startEpoch: "hadean", climateCouplingYears: 200_000,
    })
    for (let i = 0; i < 1200 && a.life.clades.length === 0; i++) a.advance(400_000, OPT)
    expect(a.life.clades.length).toBeGreaterThan(0)   // 生命がいない時点で測っても意味が無い
    for (let i = 0; i < 120; i++) a.advance(400_000, OPT)

    const b = loadWorld(saveWorld(a))
    expect(fingerprint(b)).toEqual(fingerprint(a))
    for (let i = 0; i < 60; i++) { a.advance(400_000, OPT); b.advance(400_000, OPT) }
    expect(fingerprint(b)).toEqual(fingerprint(a))
    // クレードの中身まで見る（数だけ合っていても中身が違うことがある）
    expect(JSON.stringify(b.life.snapshot())).toEqual(JSON.stringify(a.life.snapshot()))
  }, 180_000)

  it("★移住を有効にしても往復して 1 ビットも違わない（到達の場）", () => {
    // ★**既定が無効な機構は、既定のままではテストを一度も通らない**
    //   （`CLAUDE.md` の 39）。`reach` はレーン付きの新しい場なので、
    //   保存し忘れると「復元後に系統が別の場所にいる」形で壊れる
    const mk = () => {
      const w = new World({
        width: 48, height: 24, seed: "hadean-01", shared: false,
        startEpoch: "hadean", climateCouplingYears: 200_000,
      })
      w.life.params.dispersalKmPerYear = 0.001
      w.life.params.dispersalBarrierLeak = 0.05
      w.life.params.dispersalCost = 0.04
      return w
    }
    const a = mk()
    for (let i = 0; i < 1200 && a.life.clades.length === 0; i++) a.advance(400_000, OPT)
    expect(a.life.clades.length).toBeGreaterThan(0)
    for (let i = 0; i < 60; i++) a.advance(400_000, OPT)
    // 到達の場が**全球 1 ではない**こと（1 なら機構が効いていない）
    const reach = a.store.f32("reach").read
    let ones = 0, zeros = 0
    for (let i = 0; i < a.grid.cellCount; i++) {
      const v = reach[a.life.clades[0]!.lane * a.grid.cellCount + i]!
      if (v > 0.999) ones++
      else if (v < 1e-6) zeros++
    }
    expect(ones + zeros).toBeGreaterThan(0)
    expect(ones).toBeLessThan(a.grid.cellCount)   // ★どこかには届いていない

    const b = loadWorld(saveWorld(a))
    b.life.params.dispersalKmPerYear = 0.001
    b.life.params.dispersalBarrierLeak = 0.05
    b.life.params.dispersalCost = 0.04
    expect(fingerprint(b)).toEqual(fingerprint(a))
    for (let i = 0; i < 40; i++) { a.advance(400_000, OPT); b.advance(400_000, OPT) }
    expect(fingerprint(b)).toEqual(fingerprint(a))
  }, 180_000)

  it("形式が違うセーブは黙って読み込まない", () => {
    const w = new World({ width: 32, height: 16, seed: "snap-ver", shared: false })
    const bytes = saveWorld(w)
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(4, 999, true)
    expect(() => loadWorld(bytes)).toThrow(/形式/)
    bytes[0] ^= 0xff
    expect(() => loadWorld(bytes)).toThrow(/セーブデータ/)
  })
})

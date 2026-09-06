import { describe, it, expect } from "vitest"
import { World } from "./world"

/**
 * ★**GPU が例外を投げても惑星が止まらないこと。**
 *
 * 2026-09-06 のユーザ報告: WebGPU の検証エラー
 * （`Buffer already has an outstanding map pending`）が `solveClimateAsync`
 * から上まで飛び、worker の `tick` ごと死んで**時間が二度と進まなくなった**。
 * 安全網は「変な数字」しか見ておらず、**例外は素通り**していた。
 *
 * ★この環境（headless・GPU 無し）では本物の WebGPU を再現できないので、
 * **投げるバックエンドを刺して**同じ経路を通す。
 */
describe("気候バックエンドの安全網", () => {
  const mk = () => new World({ width: 32, height: 16, seed: "fallback", shared: false })

  it("★例外を投げるバックエンドでも解が返り、惑星は止まらない", async () => {
    const w = mk()
    let calls = 0
    w.climateBackend = {
      solve: async () => {
        calls++
        throw new Error("WebGPU 検証エラー: Buffer already has an outstanding map pending")
      },
      destroy: () => {},
    } as never
    const s = await w.solveClimateAsync()
    expect(calls).toBe(1)
    expect(Number.isFinite(s.meanT)).toBe(true)      // CPU が解いた
    expect(w.climateBackend).toBeNull()              // 二度と使わない
    expect(w.climateBackendError).toContain("map pending")  // 黙らない
  })

  it("★落ちた後も進み続ける（ここが「時間が止まる」の本体）", async () => {
    const w = mk()
    w.climateBackend = {
      solve: async () => { throw new Error("boom") },
      destroy: () => {},
    } as never
    const y0 = w.globals.yearsElapsed
    for (let i = 0; i < 3; i++) await w.advanceAsync(100_000, { maxOuter: 4 })
    expect(w.globals.yearsElapsed).toBeGreaterThan(y0)
  })

  it("★同じ場を 2 本の solve が同時に書かない（GPU の二重 map の本体）", async () => {
    // ★ユーザ報告のスタックは 2 本あった ——
    //   `onmessage → refreshAsync` と `tick`。同時に走ると同じバッファに
    //   `mapAsync` が二重に掛かって落ちる。GPU 固有ではなく、
    //   **同じ場を 2 本が同時に書く**という穴
    const w = mk()
    let inFlight = 0, maxInFlight = 0
    w.climateBackend = {
      solve: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        // 正しい形の結果を返す（安全網に落とされないように）
        return { meanT: 15, converged: true, clampedCells: 0, imbalance: 0,
          radiative: {}, gradient: 0 }
      },
      destroy: () => {},
    } as never
    await Promise.all([w.solveClimateAsync(), w.solveClimateAsync(),
      w.solveClimateAsync()])
    expect(maxInFlight).toBe(1)          // ★同時に 1 本だけ
    expect(w.climateBackend).not.toBeNull()
  })


  it("★climateIdle は飛んでいる solve を待つ（場を差し替える前に呼ぶ）", async () => {
    const w = mk()
    let finished = false
    w.climateBackend = {
      solve: async () => {
        await new Promise((r) => setTimeout(r, 20))
        finished = true
        return { meanT: 15, converged: true, clampedCells: 0, imbalance: 0,
          radiative: {}, gradient: 0 }
      },
      destroy: () => {},
    } as never
    const p = w.solveClimateAsync()
    await w.climateIdle()
    expect(finished).toBe(true)     // ★待たずに戻ったら差し替えが壊れる
    await p
  })

  it("★飛んでいる solve が、復元した場を上書きしない", async () => {
    // ユーザ報告「ロードした瞬間、全球凍結して生命が全部しんだ」の形。
    // 前の状態の solve が `applySnapshot` の**後**に完了すると、
    // 復元した温度を古い値で塗りつぶし、氷アルベドの暴走に落ちる
    const w = mk()
    const T = w.store.f32("temperature").read
    w.climateBackend = {
      solve: async () => {
        await new Promise((r) => setTimeout(r, 20))
        T.fill(150)                 // ★古い温度を書き戻す（GPU の finish 相当）
        return { meanT: 15, converged: true, clampedCells: 0, imbalance: 0,
          radiative: {}, gradient: 0 }
      },
      destroy: () => {},
    } as never
    const p = w.solveClimateAsync()
    await w.climateIdle()           // ★これを飛ばすと下で 150 に塗られる
    T.fill(288)                     // 復元に相当
    await p
    expect(T[0]).toBe(288)
  })

  it("数字がおかしいだけなら 8 回までは様子を見る（例外と区別する）", async () => {
    const w = mk()
    w.climateBackend = {
      solve: async () => ({
        meanT: Number.NaN, converged: false, clampedCells: 0, imbalance: 0,
      }),
      destroy: () => {},
    } as never
    await w.solveClimateAsync()
    expect(w.climateBackend).not.toBeNull()   // 1 回目では切らない
    expect(w.climateBackendFailures).toBe(1)
  })
})

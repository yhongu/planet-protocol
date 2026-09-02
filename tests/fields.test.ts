import { describe, it, expect } from "vitest"
import { Grid } from "../src/core/grid"
import { FieldStore, type FieldSpec } from "../src/core/fields"

const SPECS: readonly FieldSpec[] = [
  { name: "a", kind: "f32", doubleBuffered: true },
  { name: "b", kind: "f32", doubleBuffered: false },
  { name: "c", kind: "u8", doubleBuffered: false },
  { name: "multi", kind: "f32", doubleBuffered: true, lanes: 4 },
]

describe("FieldStore", () => {
  const grid = new Grid(64, 32)

  it("場の長さが正しい", () => {
    const s = new FieldStore(grid, SPECS, { shared: false })
    expect(s.f32("a").read.length).toBe(grid.cellCount)
    expect(s.f32("multi").read.length).toBe(grid.cellCount * 4)
    expect(s.u8("c").read.length).toBe(grid.cellCount)
  })

  it("ping-pong が read/write を入れ替える (docs/04-8.5 規則2)", () => {
    const s = new FieldStore(grid, SPECS, { shared: false })
    const a = s.f32("a")
    expect(a.read).not.toBe(a.write)
    a.read[0] = 1
    a.write[0] = 2
    s.swap()
    expect(a.read[0]).toBe(2)
    expect(a.write[0]).toBe(1)
  })

  it("doubleBuffered=false の場は swap の影響を受けない", () => {
    const s = new FieldStore(grid, SPECS, { shared: false })
    const b = s.f32("b")
    expect(b.read).toBe(b.write)
    b.read[5] = 42
    s.swap()
    expect(b.read[5]).toBe(42)
    expect(b.write[5]).toBe(42)
  })

  it("場どうしが重ならない（オフセット計算の検証）", () => {
    const s = new FieldStore(grid, SPECS, { shared: false })
    s.f32("a").read.fill(1)
    s.f32("a").write.fill(2)
    s.f32("b").read.fill(3)
    s.f32("multi").read.fill(4)
    s.f32("multi").write.fill(5)
    s.u8("c").read.fill(0)
    expect(s.f32("a").read.every((v) => v === 1)).toBe(true)
    expect(s.f32("a").write.every((v) => v === 2)).toBe(true)
    expect(s.f32("b").read.every((v) => v === 3)).toBe(true)
    expect(s.f32("multi").read.every((v) => v === 4)).toBe(true)
    expect(s.f32("multi").write.every((v) => v === 5)).toBe(true)
  })

  it("未知の場を要求すると失敗する", () => {
    const s = new FieldStore(grid, SPECS, { shared: false })
    expect(() => s.f32("nope")).toThrow()
    expect(() => s.f32("c")).toThrow()   // u8 を f32 として要求
  })
})

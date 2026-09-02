/**
 * ゲノムの記号表現（docs/02 §2.2b）。
 *
 * ★**この検査の主眼は「収斂と相同を見分けられること」**である。
 * `docs/02` §1.6 の中心的な設計判断「機能は収斂する、系統は収斂しない」を
 * 表示できるかどうかが、ゲノムを実体として持つ唯一の理由だから。
 */
import { describe, it, expect } from "vitest"
import { Rng, Stream } from "../src/core/rng"
import {
  GENE_KINDS, TRAIT_COUNT, CAPABILITY_THRESHOLD, EARTH_MUTATION,
  createGenome, cloneGenome, addGene, decodeGenome, createPhenotype,
  mutate, spliceFrom, sharesOrigin, hasCapability, seedGenome, OriginCounter,
} from "../src/sim/genome"

const kindOf = (n: string) => GENE_KINDS.indexOf(n as never)

describe("ゲノム", () => {
  it("デコードは形質を 0..1 に収め、遺伝子量で強くなる（飽和する）", () => {
    const oc = new OriginCounter()
    const g = createGenome()
    const k = kindOf("photosynthesis")
    const ph = createPhenotype()
    addGene(g, k, 255, oc.issue())
    const one = decodeGenome(g, ph).traits[k]
    addGene(g, k, 255, oc.issue())
    const two = decodeGenome(g, ph).traits[k]
    expect(one).toBeGreaterThan(0.5)
    expect(two).toBeGreaterThan(one)      // 重複で強くなる
    expect(two).toBeLessThan(1)           // が、飽和して 1 は超えない
    for (let t = 0; t < TRAIT_COUNT; t++) {
      expect(ph.traits[t]).toBeGreaterThanOrEqual(0)
      expect(ph.traits[t]).toBeLessThanOrEqual(1)
    }
  })

  it("能力ビットは閾値を超えた遺伝子で立つ", () => {
    const oc = new OriginCounter()
    const g = createGenome()
    const k = kindOf("capMulticellular")
    const ph = createPhenotype()
    addGene(g, k, CAPABILITY_THRESHOLD - 1, oc.issue())
    expect(hasCapability(decodeGenome(g, ph), k)).toBe(false)
    addGene(g, k, CAPABILITY_THRESHOLD, oc.issue())
    expect(hasCapability(decodeGenome(g, ph), k)).toBe(true)
  })

  it("★相同: 分岐した 2 系統は、受け継いだ能力を同じ由来で持つ", () => {
    const oc = new OriginCounter()
    const anc = createGenome()
    const k = kindOf("capMotility")
    addGene(anc, k, 200, oc.issue())
    const a = cloneGenome(anc), b = cloneGenome(anc)
    const rng = new Rng("split", Stream.Evolution)
    for (let i = 0; i < 50; i++) { mutate(a, rng, EARTH_MUTATION, oc); mutate(b, rng, EARTH_MUTATION, oc) }
    expect(sharesOrigin(a, b, k)).toBe(true)
  })

  it("★収斂: 独立に獲得した同じ能力は、由来が違う", () => {
    const oc = new OriginCounter()
    const k = kindOf("capSkeleton")
    const a = createGenome(), b = createGenome()
    // 別々の「発明」なので由来 id は別々に振られる
    addGene(a, k, 200, oc.issue())
    addGene(b, k, 200, oc.issue())
    const pa = decodeGenome(a, createPhenotype())
    const pb = decodeGenome(b, createPhenotype())
    // **能力としては同じ**
    expect(hasCapability(pa, k)).toBe(true)
    expect(hasCapability(pb, k)).toBe(true)
    // **由来は違う** = 収斂進化
    expect(sharesOrigin(a, b, k)).toBe(false)
  })

  it("★合流: 取り込んだ断片は相手の由来を保つ（内部共生・水平伝播）", () => {
    const oc = new OriginCounter()
    const host = createGenome(), donor = createGenome()
    const k = kindOf("capOxygenicPhotosynthesis")
    const donorOrigin = oc.issue()
    addGene(donor, k, 220, donorOrigin)
    addGene(host, kindOf("bodySize"), 100, oc.issue())
    const rng = new Rng("splice", Stream.Evolution)
    const moved = spliceFrom(host, donor, rng, EARTH_MUTATION, 1)
    expect(moved).toBe(1)
    expect(hasCapability(decodeGenome(host, createPhenotype()), k)).toBe(true)
    // 取り込んだ側に**提供者の由来が残る**
    expect(sharesOrigin(host, donor, k)).toBe(true)
  })

  it("決定論: 同じ seed・同じ順序なら同じゲノムになる", () => {
    const build = () => {
      const oc = new OriginCounter()
      const g = seedGenome("vent", oc)
      const rng = new Rng("det", Stream.Evolution)
      for (let i = 0; i < 200; i++) mutate(g, rng, EARTH_MUTATION, oc)
      return g
    }
    const a = build(), b = build()
    expect(a.length).toBe(b.length)
    for (let i = 0; i < a.length; i++) {
      expect(a.kind[i]).toBe(b.kind[i])
      expect(a.value[i]).toBe(b.value[i])
      expect(a.origin[i]).toBe(b.origin[i])
    }
  })

  it("起源の経路が最初の代謝を縛る（§2.8）", () => {
    const oc = new OriginCounter()
    const ph = createPhenotype()
    const vent = decodeGenome(seedGenome("vent", oc), ph)
    const vT = vent.traits[kindOf("tempOptimum")]
    const vP = vent.traits[kindOf("photosynthesis")]
    const coast = decodeGenome(seedGenome("coast", oc), createPhenotype())
    const cT = coast.traits[kindOf("tempOptimum")]
    const cP = coast.traits[kindOf("photosynthesis")]
    // 熱水起源は高温に適応し、光合成を持たない
    expect(vT).toBeGreaterThan(cT)
    expect(vP).toBe(0)
    expect(cP).toBeGreaterThan(0)
    // 温泉起源は最初から陸に耐える
    const spring = decodeGenome(seedGenome("hotspring", oc), createPhenotype())
    expect(hasCapability(spring, kindOf("capLandTolerance"))).toBe(true)
  })

  it("ゲノムの長さは上限を超えない（計算量の門）", () => {
    const oc = new OriginCounter()
    const g = seedGenome("coast", oc)
    const rng = new Rng("cap", Stream.Evolution)
    for (let i = 0; i < 20000; i++) mutate(g, rng, EARTH_MUTATION, oc)
    expect(g.length).toBeLessThanOrEqual(EARTH_MUTATION.maxGenes)
    expect(g.length).toBeGreaterThan(0)
  })
})

describe("生命の起源からゲノムまで", () => {
  it("起源の経路が LUCA のゲノムに反映される（惑星 → 化学 → 遺伝子）", async () => {
    const { World } = await import("../src/sim/world")
    const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
    const w = new World({
      width: 64, height: 32, seed: "audit", shared: false,
      startEpoch: "hadean", climateCouplingYears: 200_000,
    })
    while (w.life.clades.length === 0 && w.globals.yearsElapsed < 1.5e9) {
      w.advance(400_000, OPT)
    }
    const luca = w.life.clades[0]
    expect(luca).toBeDefined()
    expect(luca.bornYear).toBe(w.prebiotic.state.originYear)
    expect(luca.genome.length).toBeGreaterThan(0)
    // 由来 id は世界にひとつの発行元から出ている（収斂と相同の判定の前提）。
    // ★**遺伝子の数とは比べない。** 重複は由来を引き継ぐ（＝相同）ので、
    // 遺伝子数が発行済み id 数を超えることがある。実際 2026-09-01 に
    // 「issued 5 >= 遺伝子 6」で落ちた——LUCA 誕生と同じ 400kyr の中で
    // 重複が 1 回起きただけで、不変条件の書き方の方が誤っていた。
    // 正しくは「すべての id が発行済みの範囲に収まっている」こと
    let maxOrigin = 0
    for (let i = 0; i < luca.genome.length; i++) {
      const o = luca.genome.origin[i]
      expect(o).toBeGreaterThan(0)
      if (o > maxOrigin) maxOrigin = o
    }
    expect(w.life.origins.issued).toBeGreaterThanOrEqual(maxOrigin)
    const site = w.prebiotic.state.originSite
    console.log(`  起源 ${(luca.bornYear / 1e6).toFixed(0)}Myr  経路 ${site}` +
      `  遺伝子 ${luca.genome.length} 個  最適温度 ${luca.phenotype.traits[0].toFixed(3)}`)
    if (site === "vent") {
      // 熱水起源は光合成を持たない（§2.8 が下流の代謝を縛る）
      expect(luca.phenotype.traits[GENE_KINDS.indexOf("photosynthesis")]).toBe(0)
    }
  }, 120_000)
})

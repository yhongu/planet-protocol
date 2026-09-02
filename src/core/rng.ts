/**
 * 決定論的な擬似乱数と整数ハッシュ。
 *
 * docs/04-6 の規約:
 *   - Math.random() はシミュレーション層で全面禁止（リプレイと seed 共有の前提）
 *   - サブシステムごとに独立した乱数ストリームを持つ
 *     （あるサブシステムの乱数消費回数が変わっても他が壊れないように）
 *
 * xoshiro128** を使う。32bit 演算のみで構成されるので、
 * JS / WGSL / 他言語で同一の出力が得られる（GPU 移植を見据えている）。
 */

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0

/** 文字列 seed を 32bit 整数に潰す（FNV-1a）。 */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** splitmix32。状態の初期化に使う。 */
function splitmix32(state: number): () => number {
  let s = state >>> 0
  return () => {
    s = (s + 0x9e3779b9) >>> 0
    let z = s
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0
    return (z ^ (z >>> 15)) >>> 0
  }
}

export class Rng {
  private s0 = 0
  private s1 = 0
  private s2 = 0
  private s3 = 0

  /**
   * @param seed      惑星の seed
   * @param streamId  サブシステム識別子。同じ seed でも別ストリームになる。
   *                  `Stream` の定数を使うこと。
   */
  constructor(seed: number | string, streamId = 0) {
    const base = typeof seed === "string" ? hashSeed(seed) : seed >>> 0
    // seed と streamId を混ぜてから splitmix32 で 4 語を生成する。
    const mixed = Math.imul(base ^ Math.imul(streamId + 1, 0x9e3779b9), 0x85ebca6b) >>> 0
    const sm = splitmix32(mixed)
    this.s0 = sm()
    this.s1 = sm()
    this.s2 = sm()
    this.s3 = sm()
    // 全ゼロ状態は退化するので回避
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1
  }

  /** 32bit 符号なし整数 */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0
    const t = (this.s1 << 9) >>> 0
    this.s2 ^= this.s0
    this.s3 ^= this.s1
    this.s1 ^= this.s2
    this.s0 ^= this.s3
    this.s2 ^= t
    this.s3 = rotl(this.s3, 11)
    this.s0 >>>= 0
    this.s1 >>>= 0
    this.s2 >>>= 0
    this.s3 >>>= 0
    return result
  }

  /** [0, 1) の float。24bit 精度（float32 の仮数に収まる）。 */
  nextFloat(): number {
    return (this.nextU32() >>> 8) / 16777216
  }

  /** [lo, hi) の float */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.nextFloat()
  }

  /** [0, n) の整数 */
  int(n: number): number {
    return Math.floor(this.nextFloat() * n)
  }

  /** 標準正規分布（Box-Muller）。キャッシュせず毎回 2 個消費する（消費数を一定に保つため）。 */
  normal(): number {
    const u = Math.max(this.nextFloat(), 1e-12)
    const v = this.nextFloat()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
}

/**
 * サブシステムごとの乱数ストリーム識別子。
 * 新しいサブシステムを足すときはここに追加し、既存の値は【変えない】こと
 * （変えると過去の seed が再現しなくなる）。
 */
export const Stream = {
  Terrain: 0,
  Tectonics: 1,
  Mantle: 2,
  Evolution: 3,
  Ecology: 4,
  Events: 5,
  Society: 6,
} as const

/**
 * 3D 整数格子ハッシュ。値ノイズの格子点値に使う。
 * 状態を持たないので並列化可能で、GPU にそのまま移植できる。
 * 戻り値は [0, 1)。
 */
export function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0
  h = Math.imul(h ^ (ix | 0), 0x85ebca6b) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h ^ (iy | 0), 0xc2b2ae35) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  h = Math.imul(h ^ (iz | 0), 0x27d4eb2f) >>> 0
  h = (h ^ (h >>> 15)) >>> 0
  return (h >>> 8) / 16777216
}

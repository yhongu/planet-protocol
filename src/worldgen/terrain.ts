/**
 * M0 の初期地形生成。
 *
 * **これは仮の実装である。** M4（固体地球）でプレートテクトニクスに置き換わる。
 * ここでの目的は、後続のマイルストーンが動かせる「それらしい惑星」を用意することと、
 * グリッド・ノイズ・描画の土台が正しいことを確かめること。
 *
 * 設計上の要点:
 *   - 単位球上の 3D ノイズなので東西の継ぎ目が原理的に出ない（noise.ts 参照）
 *   - 海面は「陸地面積比が目標値になる高さ」として【面積重み付き分位点】で決める。
 *     閾値を手で決め打ちすると、seed ごとに陸地面積が大きくばらついてしまう。
 *   - 分位点はヒストグラムで求める。これは GPU では整数 atomics のヒストグラムに
 *     そのまま対応する（docs/04-8.4a）。
 */

import type { Grid } from "../core/grid"
import type { FieldStore } from "../core/fields"
import { hashSeed, Stream } from "../core/rng"
import { fbm, ridgedFbm, warp } from "./noise"

export interface TerrainOptions {
  /** 目標の陸地面積比。現在の地球は約 0.29 */
  landFraction: number
  /** 大陸の数の目安を決める基本周波数。小さいほど大きな大陸になる */
  continentFrequency: number
  /** 大陸の縁の入り組み具合 */
  warpAmount: number
  maxMountain: number
  maxDepth: number
}

export const DEFAULT_TERRAIN: TerrainOptions = {
  landFraction: 0.29,
  continentFrequency: 1.35,
  warpAmount: 0.32,
  maxMountain: 7800,
  maxDepth: 6000,
}

const HIST_BINS = 4096

/** 大陸棚がポテンシャル差のどこまでを占めるか */
const SHELF_WIDTH = 0.05
/** 大陸棚の外縁の水深 [m]。実際の棚端は -130 〜 -200m */
const SHELF_DEPTH = 170
/** 深海への落ち方。小さいほど斜面が急になり、深海平原が卓越する */
const ABYSS_EXPONENT = 0.34
/** 尾根の鋭さ。大きいほど山が孤立し、小さいほど高地が広がる */
const RIDGE_SHARPNESS = 1.8

/**
 * 面積重み付き分位点を求める。
 * ヒストグラムを使うので O(n)。`sort` を使わないのは、
 * 大きな配列のソートが遅いことに加え、GPU 移植を見据えているため。
 */
function areaWeightedQuantile(
  grid: Grid, values: Float32Array, q: number, lo: number, hi: number,
): number {
  const bins = new Float64Array(HIST_BINS)
  const scale = HIST_BINS / (hi - lo)
  const { W, H } = grid
  // 行ごとに畳んでから加重する（grid.globalMean と同じ固定順序）
  for (let y = 0; y < H; y++) {
    const w = grid.areaWeight[y]
    const row = y * W
    for (let x = 0; x < W; x++) {
      let b = Math.floor((values[row + x] - lo) * scale)
      if (b < 0) b = 0
      else if (b >= HIST_BINS) b = HIST_BINS - 1
      bins[b] += w
    }
  }
  let cum = 0
  for (let b = 0; b < HIST_BINS; b++) {
    const next = cum + bins[b]
    if (next >= q) {
      // ビン内を線形補間する
      const frac = bins[b] > 0 ? (q - cum) / bins[b] : 0
      return lo + ((b + frac) / HIST_BINS) * (hi - lo)
    }
    cum = next
  }
  return hi
}

export interface TerrainResult {
  seaLevelPotential: number
  landFraction: number
  meanElevation: number
}

export function generateTerrain(
  grid: Grid, store: FieldStore, seed: string | number,
  opts: TerrainOptions = DEFAULT_TERRAIN,
): TerrainResult {
  const base = typeof seed === "string" ? hashSeed(seed) : seed >>> 0
  // 地形は Terrain ストリームを使う（docs/04-6: サブシステムごとに独立した乱数）
  const s = (base ^ (Stream.Terrain * 0x9e3779b9)) >>> 0
  const sContinent = s >>> 0
  const sMountain = (s ^ 0x68bc21eb) >>> 0
  const sProvince = (s ^ 0x3c6ef372) >>> 0

  const n = grid.cellCount
  const { sphere } = grid

  // --- 1. 大陸性ポテンシャルを計算する ---
  const potential = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const p: [number, number, number] = [sphere[i * 3], sphere[i * 3 + 1], sphere[i * 3 + 2]]
    const wp = warp(p, sContinent, opts.warpAmount, 1.9)
    potential[i] = fbm(wp[0], wp[1], wp[2], sContinent, {
      octaves: 6,
      frequency: opts.continentFrequency,
      lacunarity: 2.1,
      gain: 0.5,
    })
  }

  // --- 2. 目標の陸地面積比になる海面を分位点で決める ---
  const seaLevelPotential = areaWeightedQuantile(
    grid, potential, 1 - opts.landFraction, -1, 1,
  )

  // --- 3. ポテンシャルを標高 [m] に変換する ---
  const elev = store.f32("elevation").read
  const crust = store.u8("crustType").read
  const landSpan = Math.max(1e-6, 1 - seaLevelPotential)
  const seaSpan = Math.max(1e-6, seaLevelPotential + 1)

  for (let i = 0; i < n; i++) {
    const p: [number, number, number] = [sphere[i * 3], sphere[i * 3 + 1], sphere[i * 3 + 2]]
    const t = potential[i] - seaLevelPotential

    if (t >= 0) {
      const landness = t / landSpan                       // 0..1
      // 造山帯を「まだら」にする。一様に山だらけにならないようにする低周波マスク。
      // M4 でプレート境界に置き換わるまでの繋ぎ。
      const province = fbm(p[0], p[1], p[2], sProvince, { octaves: 3, frequency: 2.2 })
      const mask = Math.max(0, Math.min(1, (province + 0.15) * 1.6))
      const ridge = ridgedFbm(p[0], p[1], p[2], sMountain, {
        octaves: 5, frequency: 6.5, lacunarity: 2.2, gain: 0.55,
      })
      // 大陸の内側ほど高い台地 + 造山帯の尾根
      // 台地: 大陸の内側ほど高い
      const platform = Math.pow(landness, 0.75) * 900
      // 造山帯: 尾根の鋭さを指数で調整する。
      // landness への依存を弱くしてあるのは、実際の高山（ヒマラヤ、アンデス）が
      // 大陸の内側ではなく衝突帯・縁辺にできるため。M4 でプレート境界に置き換わる。
      const mountain =
        Math.pow(ridge, RIDGE_SHARPNESS) * mask *
        Math.pow(landness, 0.30) * opts.maxMountain
      elev[i] = platform + mountain
      crust[i] = 1
    } else {
      const d = Math.min(1, -t / seaSpan)                 // 0..1
      // 大陸棚 → 大陸斜面 → 深海平原、という二段の落ち方を作る。
      // 実際の海底地形は【二峰性】で、面積の大半を -4000 〜 -5500m の深海平原が占める
      // （地球の平均水深は -3688m）。指数を小さくして斜面を急にし、
      // 早い段階で深海平原に達するようにする。
      const shelf = Math.min(1, d / SHELF_WIDTH)
      const abyss = Math.pow(
        Math.max(0, (d - SHELF_WIDTH) / (1 - SHELF_WIDTH)), ABYSS_EXPONENT,
      )
      elev[i] = -(shelf * SHELF_DEPTH + abyss * (opts.maxDepth - SHELF_DEPTH))
      // 大陸棚までは大陸地殻とみなす
      crust[i] = d < SHELF_WIDTH * 0.8 ? 1 : 0
    }
  }

  // ping-pong の書き込み面にも同じ内容を入れておく（初期状態を両面で揃える）
  store.f32("elevation").write.set(elev)

  return {
    seaLevelPotential,
    landFraction: grid.areaFractionWhere(elev, (v) => v >= 0),
    meanElevation: grid.globalMean(elev),
  }
}

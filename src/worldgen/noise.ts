/**
 * 単位球上でサンプルする 3D 値ノイズ。
 *
 * **なぜ 3D か** — 東西の継ぎ目を消すため。
 * 2D ノイズを緯度経度平面に直接張ると x=0 と x=W-1 の境界で必ず継ぎ目が出る。
 * セルの単位球上の座標で 3D ノイズをサンプルすれば、経度が一周して自然に一致する。
 * 極の特異点も生じず、地物の大きさが球面上で一様になる（＝地図上では極付近で
 * 東西に引き伸ばされる。これは正しい振る舞い）。
 *
 * 状態を持たない整数ハッシュのみで構成しているので、GPU にそのまま移植できる
 * （docs/04-8.5 規則 3: カーネルは純関数）。
 */

import { hash3 } from "../core/rng"

/** Ken Perlin の smootherstep。1階・2階微分が端点でゼロ。 */
function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/** 3D 値ノイズ。戻り値は概ね [-1, 1]。 */
export function noise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = smootherstep(x - ix)
  const fy = smootherstep(y - iy)
  const fz = smootherstep(z - iz)

  const c000 = hash3(ix, iy, iz, seed)
  const c100 = hash3(ix + 1, iy, iz, seed)
  const c010 = hash3(ix, iy + 1, iz, seed)
  const c110 = hash3(ix + 1, iy + 1, iz, seed)
  const c001 = hash3(ix, iy, iz + 1, seed)
  const c101 = hash3(ix + 1, iy, iz + 1, seed)
  const c011 = hash3(ix, iy + 1, iz + 1, seed)
  const c111 = hash3(ix + 1, iy + 1, iz + 1, seed)

  const x00 = c000 + (c100 - c000) * fx
  const x10 = c010 + (c110 - c010) * fx
  const x01 = c001 + (c101 - c001) * fx
  const x11 = c011 + (c111 - c011) * fx
  const y0 = x00 + (x10 - x00) * fy
  const y1 = x01 + (x11 - x01) * fy
  return (y0 + (y1 - y0) * fz) * 2 - 1
}

export interface FbmOptions {
  octaves: number
  frequency: number
  /** 各オクターブで周波数を何倍にするか */
  lacunarity?: number
  /** 各オクターブで振幅を何倍にするか */
  gain?: number
}

/** 通常の fBm。戻り値は概ね [-1, 1]。 */
export function fbm(
  x: number, y: number, z: number, seed: number, o: FbmOptions,
): number {
  const lacunarity = o.lacunarity ?? 2.0
  const gain = o.gain ?? 0.5
  let f = o.frequency
  let amp = 1
  let sum = 0
  let norm = 0
  for (let i = 0; i < o.octaves; i++) {
    // オクターブごとに seed をずらす（同じ格子を再利用すると相関が出る）
    sum += amp * noise3(x * f, y * f, z * f, (seed + i * 0x9e3779b9) >>> 0)
    norm += amp
    f *= lacunarity
    amp *= gain
  }
  return sum / norm
}

/**
 * リッジノイズ。山脈状の尾根を作る。戻り値は [0, 1]。
 * 各オクターブで 1-|n| を取り、二乗して尾根を鋭くする。
 */
export function ridgedFbm(
  x: number, y: number, z: number, seed: number, o: FbmOptions,
): number {
  const lacunarity = o.lacunarity ?? 2.0
  const gain = o.gain ?? 0.5
  let f = o.frequency
  let amp = 1
  let sum = 0
  let norm = 0
  for (let i = 0; i < o.octaves; i++) {
    const n = noise3(x * f, y * f, z * f, (seed + i * 0x85ebca6b) >>> 0)
    const r = 1 - Math.abs(n)
    sum += amp * r * r
    norm += amp
    f *= lacunarity
    amp *= gain
  }
  return sum / norm
}

/**
 * ドメインワープ。座標そのものをノイズで歪めることで、
 * 単純な fBm にありがちな「等方的で退屈な」見た目を壊し、
 * 大陸の縁に自然な入り組みを作る。
 */
export function warp(
  p: [number, number, number], seed: number, amount: number, frequency: number,
): [number, number, number] {
  const [x, y, z] = p
  const wx = noise3(x * frequency, y * frequency, z * frequency, (seed ^ 0x1b56c4e9) >>> 0)
  const wy = noise3(x * frequency, y * frequency, z * frequency, (seed ^ 0x7f4a7c15) >>> 0)
  const wz = noise3(x * frequency, y * frequency, z * frequency, (seed ^ 0x2545f491) >>> 0)
  return [x + wx * amount, y + wy * amount, z + wz * amount]
}

/**
 * 等緯度経度グリッド。
 *
 * docs/01-2.1:
 *   - x 方向は巡回（東西ループ）
 *   - y 方向は極で閉じる
 *   - セル `(x, y)` の緯度: φ = (0.5 - (y + 0.5) / H) * π   （y=0 が北極側）
 *   - セル面積: area(y) = R² · (2π/W) · (sin φ_top − sin φ_bottom)
 *
 * **面積の緯度依存を必ず使うこと。** 単純平均を取ると極域の重みが過大になり、
 * 全球平均がすべて狂う（docs/01-2.1 が名指しで警告している典型バグ）。
 */

export const EARTH_RADIUS_M = 6.371e6

export class Grid {
  readonly W: number
  readonly H: number
  readonly cellCount: number

  /** セル中心の緯度 [rad]。長さ H */
  readonly latRad: Float64Array
  /** セル中心の緯度 [deg]。長さ H */
  readonly latDeg: Float64Array
  /** sin(セル中心緯度)。EBM の日射分布などで使う。長さ H */
  readonly sinLat: Float64Array
  /** 行 y の 1 セルあたりの面積 [m²]。長さ H */
  readonly cellArea: Float64Array
  /** 行 y の 1 セルあたりの面積を全球で正規化したもの（総和が 1）。長さ H */
  readonly areaWeight: Float64Array

  /** 事前計算した単位球上の座標。ノイズのシームレス生成に使う。長さ cellCount*3 */
  readonly sphere: Float32Array

  constructor(W: number, H: number) {
    if (W % 8 !== 0 || H % 8 !== 0) {
      // docs/04-8.5 規則 10: ワークグループ 8×8 に自然に割れるようにする
      throw new Error(`Grid dims must be multiples of 8 (got ${W}x${H})`)
    }
    this.W = W
    this.H = H
    this.cellCount = W * H

    this.latRad = new Float64Array(H)
    this.latDeg = new Float64Array(H)
    this.sinLat = new Float64Array(H)
    this.cellArea = new Float64Array(H)
    this.areaWeight = new Float64Array(H)

    const R2 = EARTH_RADIUS_M * EARTH_RADIUS_M
    const dLon = (2 * Math.PI) / W
    let total = 0
    for (let y = 0; y < H; y++) {
      const phiTop = (0.5 - y / H) * Math.PI
      const phiBot = (0.5 - (y + 1) / H) * Math.PI
      const phiC = (0.5 - (y + 0.5) / H) * Math.PI
      this.latRad[y] = phiC
      this.latDeg[y] = (phiC * 180) / Math.PI
      this.sinLat[y] = Math.sin(phiC)
      this.cellArea[y] = R2 * dLon * (Math.sin(phiTop) - Math.sin(phiBot))
      total += this.cellArea[y] * W
    }
    for (let y = 0; y < H; y++) this.areaWeight[y] = this.cellArea[y] / total

    // 単位球上の座標（ノイズをシームレスにするため。docs/04-8.5 規則 9 の代替）
    this.sphere = new Float32Array(this.cellCount * 3)
    for (let y = 0; y < H; y++) {
      const cp = Math.cos(this.latRad[y])
      const sp = Math.sin(this.latRad[y])
      for (let x = 0; x < W; x++) {
        const lon = ((x + 0.5) / W) * 2 * Math.PI
        const i = (y * W + x) * 3
        this.sphere[i] = cp * Math.cos(lon)
        this.sphere[i + 1] = sp
        this.sphere[i + 2] = cp * Math.sin(lon)
      }
    }
  }

  /** 東西ループを考慮したセル添字。ホットループでは使わず、halo か端の特別扱いで回すこと。 */
  idx(x: number, y: number): number {
    const xw = ((x % this.W) + this.W) % this.W
    const yc = y < 0 ? 0 : y >= this.H ? this.H - 1 : y
    return yc * this.W + xw
  }

  /** x のみラップ（y は呼び出し側で保証されている場合） */
  wrapX(x: number): number {
    return ((x % this.W) + this.W) % this.W
  }

  /** 全球の総表面積 [m²] */
  get totalArea(): number {
    let s = 0
    for (let y = 0; y < this.H; y++) s += this.cellArea[y] * this.W
    return s
  }

  /**
   * 面積重み付き全球平均。
   *
   * docs/04-8.5 規則 5: `Array.prototype.reduce` を使わず、
   * 行ごとの逐次和 → 行の固定順序での加重和、という【固定順序】で畳む。
   * GPU では「ワークグループ = 1 行」の階層リダクションにそのまま対応する。
   */
  globalMean(field: Float32Array): number {
    const { W, H } = this
    let acc = 0
    for (let y = 0; y < H; y++) {
      const row = y * W
      let rowSum = 0
      for (let x = 0; x < W; x++) rowSum += field[row + x]
      acc += (rowSum / W) * this.areaWeight[y] * W
    }
    return acc
  }

  /** 条件を満たすセルの面積割合（例: 陸地面積比）。globalMean と同じ固定順序で畳む。 */
  areaFractionWhere(field: Float32Array, pred: (v: number) => boolean): number {
    const { W, H } = this
    let acc = 0
    for (let y = 0; y < H; y++) {
      const row = y * W
      let n = 0
      for (let x = 0; x < W; x++) if (pred(field[row + x])) n++
      acc += (n / W) * this.areaWeight[y] * W
    }
    return acc
  }
}

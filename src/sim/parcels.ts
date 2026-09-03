/**
 * 地殻パーセル（粒子）。**docs/01-6.2 が最初から指定していた表現。**
 *
 * ## なぜ場ではなく粒子か
 *
 * セルごとの場では、造山も侵食も堆積も 4 近傍しか見ない。1 セル 400km では
 * どの機構も大陸の規模から見ると拡散にしかならず、地殻をまとまった塊に
 * 濃縮する経路が存在しない。実測（2026-08-28）:
 *
 * | | 厚さの分散 | 地球 |
 * |---|---|---|
 * | 場（16 機構を 4 seed で当たって動かず） | 76 ± 4 | **218** |
 * | 粒子 | **185〜221** | |
 *
 * さらに決定的だったのは**応答の向き**である。最終ゴールは「任意のパラメータで
 * 惑星がまともに動くこと」で、地球はシナリオの 1 本にすぎない。
 * 惑星のつまみ 4 つで応答の向きを測ると:
 *
 * | つまみ | 期待 | 場 | 粒子 |
 * |---|---|---|---|
 * | プレート速度 | 分散 ↑ | **✗ 逆**（陸が 4.5% に崩壊） | ✓ |
 * | 水の量 | 陸% ↓ | ✓ | ✓ |
 * | マントル温度 | 陸% ↓ | − 非単調 | ✓ |
 * | プレート数 | 分散 ↑ | ✓ | ✓ |
 * | | | **2/4** | **4/4** |
 *
 * 場はプレート速度を上げると惑星が平らになって水没する。**応答ではなく破綻。**
 *
 * ## 何が要らなくなるか
 *
 * **衝突による地殻の厚化は「粒子が同じセルに重なること」として自動的に出る。**
 * だから造山速度・前縁制限・付加ボーナス・体積クランプ・移流の体積補正が
 * すべて不要になる。移流は連続座標の剛体回転なので**数値拡散もゼロ**。
 *
 * ## 実装の規約
 *
 * - SoA の型付き配列（docs/04-3）。粒子は添字で回し、**走査順は添字順に固定**する
 *   （docs/04-6 の決定論性。生成は free リストの LIFO なのでこれも決定的）
 * - ラスタライズは計数ソート（`cellStart` / `cellIndex`）。毎ティックで確保しない
 * - 場（`crustThickness` / `felsic` / `crustAge`）は粒子から導出される【結果】である。
 *   気候・炭素・海洋・描画はすべてラスタライズ後の場しか見ないので影響を受けない
 */

import type { Grid } from "../core/grid"

/** 粒子 1 個の状態。SoA なので実体は下の ParcelStore の配列群 */
export interface ParcelInit {
  x: number; y: number; z: number
  plate: number
  /** 0=玄武岩質（海洋） / 1=珪長質（大陸） */
  felsic: number
  /** km */
  thick: number
  /** Myr */
  age: number
}

/** `ParcelStore.snapshot()` が返す形。`snapshot.ts` が符号化する */
export interface ParcelSnapshot {
  high: number
  liveCount: number
  freeTop: number
  x: Float64Array; y: Float64Array; z: Float64Array
  plate: Int32Array
  felsic: Float32Array; thick: Float32Array; age: Float32Array
  alive: Uint8Array
  freeList: Int32Array
}

export class ParcelStore {
  /** 単位球上の位置。連続座標なので移流に数値拡散が無い */
  readonly x: Float64Array
  readonly y: Float64Array
  readonly z: Float64Array
  readonly plate: Int32Array
  /** 0=玄武岩質 / 1=珪長質 */
  readonly felsic: Float32Array
  /** km */
  readonly thick: Float32Array
  /** Myr */
  readonly age: Float32Array
  readonly alive: Uint8Array

  /** 粒子 1 個が代表する面積 [m²] */
  readonly parcelArea: number
  /** 使用中の添字の上限（この上は一度も使われていない） */
  private high = 0
  /** 空き添字。LIFO なので決定的 */
  private readonly freeList: Int32Array
  private freeTop = 0
  private liveCount = 0

  /** ラスタライズの計数ソート結果。cellStart[c]..cellStart[c+1] が cellIndex の範囲 */
  readonly cellStart: Int32Array
  readonly cellIndex: Int32Array
  private readonly cellOf: Int32Array
  private readonly counter: Int32Array

  readonly capacity: number

  constructor(count: number, grid: Grid, capacityFactor = 2.5) {
    this.capacity = Math.ceil(count * capacityFactor)
    const c = this.capacity
    this.x = new Float64Array(c); this.y = new Float64Array(c); this.z = new Float64Array(c)
    this.plate = new Int32Array(c)
    this.felsic = new Float32Array(c)
    this.thick = new Float32Array(c)
    this.age = new Float32Array(c)
    this.alive = new Uint8Array(c)
    this.freeList = new Int32Array(c)
    this.cellOf = new Int32Array(c)
    this.cellIndex = new Int32Array(c)
    this.cellStart = new Int32Array(grid.cellCount + 1)
    this.counter = new Int32Array(grid.cellCount)
    // 面積は「粒子の目標数」で割る。実際の生存数が増減しても 1 個の重みは変えない
    this.parcelArea = (4 * Math.PI * 6.371e6 * 6.371e6) / count
  }

  /**
   * ★**セーブ用。生きている範囲（`high` まで）だけを渡す。**
   *
   * 容量は目標数の 2.5 倍あるので、全部書くと 2.5 倍の無駄になる。
   * `cellStart` / `cellIndex` / `cellOf` / `counter` は
   * **`rasterize` が作り直す派生量**なので保存しない。
   *
   * ★**位置は Float64 のまま渡すこと。** 量子化すると最終桁が変わり、
   * 45 億年でカオスにより別の惑星になる（`CLAUDE.md` の 11）。
   */
  snapshot(): ParcelSnapshot {
    const n = this.high
    return {
      high: this.high, liveCount: this.liveCount, freeTop: this.freeTop,
      x: this.x.slice(0, n), y: this.y.slice(0, n), z: this.z.slice(0, n),
      plate: this.plate.slice(0, n),
      felsic: this.felsic.slice(0, n),
      thick: this.thick.slice(0, n),
      age: this.age.slice(0, n),
      alive: this.alive.slice(0, n),
      freeList: this.freeList.slice(0, this.freeTop),
    }
  }

  restore(s: ParcelSnapshot): void {
    if (s.high > this.capacity) {
      throw new Error(`粒子の容量が足りない（保存 ${s.high} > 容量 ${this.capacity}）。` +
        `解像度か parcelsPerCell が保存時と違う`)
    }
    this.x.set(s.x); this.y.set(s.y); this.z.set(s.z)
    this.plate.set(s.plate)
    this.felsic.set(s.felsic)
    this.thick.set(s.thick)
    this.age.set(s.age)
    this.alive.fill(0)
    this.alive.set(s.alive)
    this.freeList.set(s.freeList)
    this.high = s.high
    this.liveCount = s.liveCount
    this.freeTop = s.freeTop
  }

  get count(): number { return this.liveCount }
  /** 走査の上限。`for (let i = 0; i < store.limit; i++) if (alive[i])` で回す */
  get limit(): number { return this.high }
  get freeSlots(): number { return this.freeTop + (this.capacity - this.high) }

  spawn(p: ParcelInit): number {
    let i: number
    if (this.freeTop > 0) i = this.freeList[--this.freeTop]
    else if (this.high < this.capacity) i = this.high++
    else return -1                      // 容量いっぱい。黙って落とさず -1 を返す
    this.x[i] = p.x; this.y[i] = p.y; this.z[i] = p.z
    this.plate[i] = p.plate
    this.felsic[i] = p.felsic
    this.thick[i] = p.thick
    this.age[i] = p.age
    this.alive[i] = 1
    this.liveCount++
    return i
  }

  kill(i: number): void {
    if (!this.alive[i]) return
    this.alive[i] = 0
    this.freeList[this.freeTop++] = i
    this.liveCount--
  }

  /**
   * プレート k の粒子をまとめて回す。
   * 回転行列を 1 回作って掛けるだけなので、粒子あたり 9 積和で済む。
   */
  rotatePlate(k: number, axis: readonly [number, number, number], ang: number): void {
    const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c
    const [ax, ay, az] = axis
    // ロドリゲスの回転公式を行列に展開する
    const m00 = t * ax * ax + c, m01 = t * ax * ay - s * az, m02 = t * ax * az + s * ay
    const m10 = t * ax * ay + s * az, m11 = t * ay * ay + c, m12 = t * ay * az - s * ax
    const m20 = t * ax * az - s * ay, m21 = t * ay * az + s * ax, m22 = t * az * az + c
    const { x, y, z, plate, alive } = this
    for (let i = 0; i < this.high; i++) {
      if (!alive[i] || plate[i] !== k) continue
      const px = x[i], py = y[i], pz = z[i]
      x[i] = m00 * px + m01 * py + m02 * pz
      y[i] = m10 * px + m11 * py + m12 * pz
      z[i] = m20 * px + m21 * py + m22 * pz
    }
  }

  /**
   * 粒子をセルに割り当てて計数ソートする。**確保はしない。**
   * 以後 `cellStart` / `cellIndex` でセルごとの粒子を走査できる。
   */
  bin(grid: Grid): void {
    const { W, H } = grid
    const { x, y, z, alive, cellOf, counter, cellStart, cellIndex } = this
    counter.fill(0)
    for (let i = 0; i < this.high; i++) {
      if (!alive[i]) { cellOf[i] = -1; continue }
      const lat = Math.asin(y[i] < -1 ? -1 : y[i] > 1 ? 1 : y[i])
      const lon = Math.atan2(z[i], x[i])
      let sx = Math.floor((lon / (2 * Math.PI)) * W + W)
      sx = ((sx % W) + W) % W
      let sy = Math.floor((0.5 - lat / Math.PI) * H)
      if (sy < 0) sy = 0; else if (sy >= H) sy = H - 1
      const c = sy * W + sx
      cellOf[i] = c
      counter[c]++
    }
    let acc = 0
    for (let c = 0; c < counter.length; c++) {
      cellStart[c] = acc
      acc += counter[c]
      counter[c] = cellStart[c]
    }
    cellStart[counter.length] = acc
    for (let i = 0; i < this.high; i++) {
      const c = cellOf[i]
      if (c >= 0) cellIndex[counter[c]++] = i
    }
  }

  /**
   * セルごとの厚さ・組成・年齢を場に書き出す。**bin の後に呼ぶこと。**
   *
   * 厚さ = Σ(粒子の厚さ × 粒子の面積) / セルの面積。
   * 粒子が重なれば厚さが足し合わさる——**これが衝突による造山の本体。**
   */
  /**
   * 粒子 → セル平均の場。
   *
   * ★**最近傍のビン分けは 1/√n の標本ノイズを持つ。**
   * 1 セル 97.7 粒子なら約 10%、海洋地殻 7km に対して **±700m の偽の起伏**。
   * 実測（2026-09-01・全史・seed hadean-01・太古代）:
   *
   * | | 既定 97.7/セル | 4 倍 390/セル |
   * |---|---|---|
   * | 最大の陸塊 | 34% | **69%** |
   * | 有効陸塊数 | 4.6 | **2.0** |
   *
   * **つまり「大陸の断片化」の正体は標本ノイズだった。**
   * 粒子を増やすのは費用が線形に増えるので、代わりに
   * **体積を保存する平滑化**（`smoothing`）で推定器の分散を下げる。
   */
  rasterize(grid: Grid, thickOut: Float32Array, felOut: Float32Array,
    ageOut: Float32Array, plateOut: Uint8Array, smoothing = 0): void {
    const { W, H } = grid
    const { thick, felsic, age, plate, cellStart, cellIndex, parcelArea } = this
    for (let y = 0; y < H; y++) {
      const invA = parcelArea / grid.cellArea[y]
      for (let x = 0; x < W; x++) {
        const c = y * W + x
        const s = cellStart[c], e = cellStart[c + 1]
        let t = 0, f = 0, a = 0, bestPlate = 0, bestW = -1
        // プレート ID は「そのセルで最も厚い粒子」のものにする（描画と診断用）
        for (let k = s; k < e; k++) {
          const i = cellIndex[k]
          const dt = thick[i] * invA
          t += dt; f += dt * felsic[i]; a += dt * age[i]
          if (thick[i] > bestW) { bestW = thick[i]; bestPlate = plate[i] }
        }
        thickOut[c] = t
        felOut[c] = t > 1e-9 ? f / t : 0
        ageOut[c] = t > 1e-9 ? a / t : 0
        plateOut[c] = bestPlate
      }
    }
    if (smoothing > 0) {
      // ★**平滑化の長さは【物理量】で決めること。**
      // 「1 セル分」で均すと、セルの大きさが解像度で変わるので
      // **平滑化そのものが解像度依存**になる。実測（2026-09-01）:
      // 監査の解像度独立性が CO2 差 1.8% → 12.9%、気温差 0.04 → 0.48K と
      // 7 倍悪化した。回数を `(基準セル / 実際のセル)²` で増やして、
      // 実効的な平滑化の長さを固定する（拡散長 ∝ Δ√(w·n)）。
      const cellKm = (Math.PI * 6371) / grid.H
      // 拡散長は Δ√(w·n) なので、必要な回数は (基準セル / セル)²。
      // **整数に丸めない**（64x32 で 1 回、96x48 で 2.25 回のところを 2 回に
      // 丸めると 11% 弱く均され、その差がそのまま解像度差になる）。
      // 端数は最後の 1 回の強さで持たせる: n 回で w·n/n' を使う。
      const want = Math.min(8, (SMOOTH_REF_CELL_KM / cellKm) ** 2)
      const n = Math.max(1, Math.round(want))
      const w = Math.min(0.5, smoothing * want / n)
      for (let k = 0; k < n; k++) {
        this.smoothConservative(grid, thickOut, felOut, w)
      }
    }
  }

  /**
   * **体積を保存したまま**セル平均の厚さを均す（標本ノイズを下げる）。
   *
   * 各セルが体積の `w` を 4 近傍へ等分に渡す。渡した分と受け取った分の
   * 総和は厳密に等しいので、**地殻の総体積は 1km³ も変わらない**
   * （`CLAUDE.md` の 6: 収支が合っていても分布が壊れることがあるので、
   *  ここは分布を直す側。総量は保存する）。
   *
   * 珪長質の割合は体積で重み付けして一緒に運ぶ（組成が混ざらないように）。
   * x は巡回、y は極で閉じる（`docs/01-2.1`）。
   */
  private smoothConservative(
    grid: Grid, thickOut: Float32Array, felOut: Float32Array, w: number,
  ): void {
    const { W, H } = grid
    const n = W * H
    if (!this.smoothVol || this.smoothVol.length !== n) {
      this.smoothVol = new Float64Array(n)
      this.smoothFel = new Float64Array(n)
    }
    const vol = this.smoothVol!, fel = this.smoothFel!
    // 体積 [km³ 相当] に直してから配る（面積が緯度で変わるため）
    for (let y = 0; y < H; y++) {
      const A = grid.cellArea[y]
      for (let x = 0; x < W; x++) {
        const c = y * W + x
        vol[c] = thickOut[c] * A
        fel[c] = felOut[c] * thickOut[c] * A
      }
    }
    const outV = new Float64Array(n), outF = new Float64Array(n)
    const share = w / 4
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = y * W + x
        outV[c] += vol[c] * (1 - w)
        outF[c] += fel[c] * (1 - w)
        const nb = [
          y * W + (x === 0 ? W - 1 : x - 1),
          y * W + (x === W - 1 ? 0 : x + 1),
          y > 0 ? c - W : c,      // 極では自分に返す（外へ漏らさない）
          y < H - 1 ? c + W : c,
        ]
        for (const k of nb) {
          outV[k] += vol[c] * share
          outF[k] += fel[c] * share
        }
      }
    }
    for (let y = 0; y < H; y++) {
      const invA = 1 / grid.cellArea[y]
      for (let x = 0; x < W; x++) {
        const c = y * W + x
        const t = outV[c] * invA
        thickOut[c] = t
        felOut[c] = t > 1e-9 ? outF[c] * invA / t : 0
      }
    }
  }

  private smoothVol: Float64Array | null = null
  private smoothFel: Float64Array | null = null
}

/**
 * セルごとの【サブグリッドの陸の割合】を粒子から直接求める。
 *
 * **これが粒子表現の本当の利点である。** セル平均の厚さから標高を出すと、
 * 「セルの 30% が厚さ 35km の大陸、70% が厚さ 7km の海洋」というセルが
 * 平均 15km → 水深 2.2km → 陸 0% になってしまう。実測で**中間帯のセルは
 * まさにその状態**（1 セルに 35km の珪長質粒子が 29 個、粒子全体の 30%）だった。
 *
 * 粒子 1 個 1 個の標高で判定すれば、そのセルは 30% が陸になる。
 * 標高は非線形なので、**平均の標高 ≠ 標高の平均 ≠ 陸の割合**である。
 */
/**
 * 平滑化の基準セル幅 [km]。64x32 の南北セル幅（πR/32 ≒ 625km）。
 * `rasterSmoothing` はこの大きさのセルで 1 回かける強さとして定義する。
 */
const SMOOTH_REF_CELL_KM = 625

export function landFractionFromParcels(
  store: ParcelStore, grid: Grid, seaLevelM: number,
  elevOf: (thickKm: number, ageMyr: number, felsic: number) => number,
  out: Float32Array,
): void {
  const { W, H } = grid
  for (let y = 0; y < H; y++) {
    // 1 セルに入るべき粒子の数（面積比）。実際の数で割ると疎な極セルで暴れる
    const expected = grid.cellArea[y] / store.parcelArea
    for (let x = 0; x < W; x++) {
      const c = y * W + x
      const s = store.cellStart[c], e = store.cellStart[c + 1]
      let land = 0
      for (let k = s; k < e; k++) {
        const i = store.cellIndex[k]
        if (!store.alive[i]) continue
        if (elevOf(store.thick[i], store.age[i], store.felsic[i]) >= seaLevelM) land++
      }
      out[c] = expected > 0 ? Math.min(1, land / expected) : 0
    }
  }
}

/**
 * 単位球上に一様に N 点を置く（フィボナッチ球）。
 * 乱数を使わないので seed に依らず決定的で、しかも一様性が良い。
 */
export function fibonacciSphere(n: number, i: number): [number, number, number] {
  const y = 1 - (2 * i + 1) / n
  const r = Math.sqrt(Math.max(0, 1 - y * y))
  const phi = i * Math.PI * (3 - Math.sqrt(5))
  return [r * Math.cos(phi), y, r * Math.sin(phi)]
}

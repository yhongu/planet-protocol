/**
 * 水循環・河川・侵食。docs/01-5。
 *
 * 物理的な大気大循環は解かない（GCM は不可能）。
 * 3 セル循環を緯度プロファイルとして与え、そこに【東西方向の水蒸気移流】を重ねる。
 *
 * 移流を入れるのが要点で、これ 1 本で
 *   - 大陸内陸の乾燥（海から遠いほど水蒸気が尽きる）
 *   - 山脈の風下の雨陰（風上で降らせた分だけ水蒸気が減る）
 * の両方が同じ機構から出る。docs/01-5.2 では別々の係数として書いていたが、
 * 移流にまとめた方が素直で、しかも結果が良い。
 *
 * 侵食は stream power law:  E = K * Q^m * S^n
 * これが M2 の供給律速（docs/01-4.2）の入力になる。
 * 「降水が変わると侵食が変わり、サーモスタットの強さが変わる」という
 * docs/01-6.6c の負のループがここで繋がる。
 */

import type { FieldSpec } from "../core/fields"
import { fastExp } from "../core/fastmath"
import { EARTH_RADIUS_M } from "../core/grid"
import type { World } from "./world"
import type { Subsystem } from "./loop"

export const HYDRO_FIELDS: readonly FieldSpec[] = [
  { name: "precip", kind: "f32", doubleBuffered: false, comment: "mm/yr" },
  { name: "runoff", kind: "f32", doubleBuffered: false, comment: "mm/yr" },
  { name: "discharge", kind: "f32", doubleBuffered: false, comment: "m³/yr。集水積算" },
  { name: "soilMoisture", kind: "f32", doubleBuffered: false, comment: "0..1" },
]

export interface HydroParams {
  /** 全球平均降水量 [mm/yr]。現在の地球は約 1000 */
  meanPrecip: number
  /**
   * 温度による水循環の強化のスケール [K]。globalScale ∝ exp((T-T0)/precipTempScale)。
   *
   * 【線形にしてはいけない】。docs/01-5.2 には (1 + 0.07*(T-15)) と書いたが、
   * これだと T = 0.2degC 付近で負になり、氷期に降水がゼロになる（実際に踏んだ）。
   *
   * また 0.07/K は水蒸気量（Clausius-Clapeyron）の値であって、降水の値ではない。
   * 降水はエネルギー律速なので 2〜3%/K。最終氷期の全球降水は
   * 気温 -5K に対して 10〜15% 減だったとされる。exp 形で 35K スケールを使う。
   */
  precipTempScale: number
  /** 温度スケーリングの下限・上限（数値的な暴走を防ぐ） */
  precipScaleMin: number
  precipScaleMax: number
  /** 海上での水蒸気の補給速度（100km あたりの回復率） */
  moistureRechargePer100km: number
  /**
   * 陸上での水蒸気の減衰長 [km]。
   * セル幅から 1 セルあたりの減衰率を導くので、格子解像度に依存しない。
   */
  moistureDecayKm: number
  /**
   * 陸上で降った水のうち、再蒸発して風下に持ち越される割合。
   * これが無いと大陸内陸が乾きすぎる（陸上平均 129mm/yr になった）。
   * アマゾンでは降水の 3〜5 割が陸からの再蒸発によるものとされる。
   */
  landRecycling: number
  /** 南北方向の輸送による水蒸気の下限。移流だけだと内陸がゼロになる */
  moistureFloor: number
  /** 地形性降水の強さ [1/m]。風上斜面でどれだけ余計に降るか */
  orographic: number
  /** 地形性降水の増分の上限（セル平均としての妥当性を保つ） */
  orographicMax: number
  /** 蒸発散の基準値 [mm/yr] と温度依存 */
  /**
   * 流出と侵食を【セル内の陸の割合】で重み付けするか。1 = する / 0 = 2026-08-30 以前。
   *
   * **地殻を粒子表現にしたとき、状態は粒子になったが判定はセル平均のまま
   * 残った箇所が 4 つあった**——陸の判定・熱水のマスク・海嶺の充填、そしてここ。
   *
   * 【なぜ要るか】`tectonics.subgridLand` を有効にすると、部分的に陸のセルが
   * **風化の【需要】には面積で参加するのに、侵食による【供給】が伴わない**
   * （`elev < sea` で侵食ゼロにしていた）。供給律速の割合が 0% → 17.2% に上がり、
   * サーモスタットが弱って**顕生代 CO2 が 1342 → 8491ppm** に飛んだ（実測）。
   *
   * ここを陸の割合で重み付けすれば需要と供給の面積基準が揃う。
   *
   * **D8 の経路探索と窪地埋めは分数化しない。** 河川網は離散的な
   * トポロジーを要求するので、セル平均の標高で解いたままにする。
   *
   * ★**既定は 0。これだけでは足りなかった**（2026-08-30 実測）。
   *
   * | 顕生代 CO2 | 既定 | subgridLand のみ | + この機構 | 地球 |
   * |---|---|---|---|---|
   * | ppm | 1342 | 8491 | **8093** | 300〜3000 |
   * | 監査 | 23P/2W/1F | 21P/4W/1F | 20P/5W/1F | |
   *
   * 需要と供給の面積基準を揃えても CO2 はほとんど戻らない。
   * 32Myr の短いランでは CO2 の解像度差が 0.1976 → 0.1311 と改善するが、
   * **供給律速の割合の解像度差は 0.2855 → 0.5828 と倍悪化する**
   * （`landFraction` 自身が持つ解像度依存を侵食に持ち込むため）。
   *
   * 【確かめたこと】基準状態では `landFraction` の平均 28.80% が
   * `subgridLand` の 0/1 で一致し、標高の閾値（29.01%）とも合う。
   * **較正の食い違いではない。問題は時間発展の過程にある。**
   *
   * ---
   * ★**D8 も分数化した（`subgridLandThreshold`）。解像度は大きく改善したが、
   * 炭素の較正が追いつかない。**
   *
   * 3 つ（`subgridLand` + この機構 + D8 の閾値判定）を有効にした実測:
   *
   * |                    | 既定      | 3 つ有効     | 地球 |
   * |--------------------|-----------|-------------|------|
   * | CO2 の解像度差     | 0.1976（99%） | **0.1092（55%）** | 契約 <0.2 |
   * | 監査の FAIL        | 1         | **0**       | |
   * | 陸の平均標高 [m]   | 1315      | **1163**    | 840  |
   * | 顕生代の気温       | 17.7      | 14.4（PASS） | 17〜20 |
   * | 顕生代 CO2 [ppm]   | 1342      | **16045**   | 300〜3000 |
   * | 監査               | 23P/2W/1F | 21P/5W/0F   | |
   *
   * **狙いは達成した**——解像度の余裕が 99% → 55%、しかも**刻み依存性の
   * FAIL が消えた**（炭素と気候の結合の数値誤差にも効いた）。
   *
   * **だが顕生代 CO2 がサブグリッド化を進めるほど単調に悪化する**
   * （1342 → 8491 → 8093 → 16045）。陸をサブグリッドにすると風化の【需要】が
   * 増えるのに【供給】（侵食）が追いつかず、供給律速でサーモスタットが弱る。
   * **侵食を割合で重み付けしても D8 を分数化してもこの不均衡は残る。**
   *
   * ---
   * ★**侵食の lf 二重計上を修正した（実在するバグ）。効果は大きいが足りない。**
   *
   * | | 顕生代 CO2 | CO2 の解像度差 |
   * |---|---|---|
   * | 二重計上あり | 16045ppm | 0.1092（使用率 55%） |
   * | **修正後** | **8174ppm** | 0.2062（103%） |
   * | 既定 | 1342 | 0.1976（99%） |
   *
   * ---
   * ★★**2026-08-30: ここまでの実測はすべて【気候のアルベドの欠陥】を
   * 含んでいた。** `climate.ts` の `albedoPass` が `landFraction` を
   * 真偽値として使っていたので、サブグリッドを有効にすると
   * **全球平均が 3.2K 下がる寒冷バイアス**が乗っていた。直した後の値で
   * 議論すること（上の表は経緯として残す）。
   *
   * ---
   * ★★★**本当の原因は「河川網が消えていた」ことだった**（2026-08-30・決着）。
   *
   * 顕生代の陸の面積を lf の区間で分けると（64x32・全史・seed audit）:
   *
   * | 区間 | 面積% | 侵食/較正基準 | 流量0% | 供給律速% |
   * |---|---|---|---|---|
   * | lf<0.1 | 10.7 | 0.001 | 100 | 98 |
   * | 0.1-0.5 | **86.9** | 0.001 | **100** | 97 |
   * | 0.5-0.9 | 2.3 | 0.46 | 73 | 72 |
   * | lf>=0.9 | **0.00** | — | — | — |
   *
   * **顕生代には lf>=0.5 のセルがほぼ存在しない。** 粒子ごとの標高で数えると
   * 陸は lf≈0.3 のセルに広く散る（総量はセル平均と一致: 15.8% vs 15.5%）。
   * 厚さの分布が右に裾を引くので、**セル平均の標高は海面を超えるのに
   * 個々の粒子の過半数は超えない。** つまり `elev >= sea` と `lf >= 0.5` は
   * 別の集合で、後者はずっと狭い。
   *
   * その結果 `subgridLandThreshold: 0.5` で **陸の 99.4% が河川網から外れ、
   * 流量ゼロ・侵食は下限だけ（較正基準の 0.001 倍）**になっていた。
   * 風化の需要には面積で参加するのに供給が伴わないので、
   * 供給律速が 53〜62% まで上がってサーモスタットが壊れた。
   *
   * 直したのは 2 つ:
   *   1. D8 の陸判定を経路と同じ場に戻す（`subgridLandThreshold` を 0 に）
   *   2. **網に入らない部分的な陸も、自分の降雨分の流量を持つ**（`routeFlow`）
   *
   * 顕生代（64x32・全史・2 seed。供給律速の較正目標は 25%）:
   *
   * | 構成 | CO2 ppm | 気温℃ | 供給律速% | 侵食/基準 |
   * |---|---|---|---|---|
   * | 既定（サブグリッドなし） | 1180 / 685 | 18.5 / 17.1 | 2.5 / 3.0 | 1.74 / 1.71 |
   * | thr0.5・局所流量なし | 8482 / 7183 | 23.8 / 22.5 | 53 / 62 | 0.012 / 0.063 |
   * | + 局所流量（thr 0.5） | 969 / 699 | 16.1 / 16.5 | 32.6 / 29.4 | 0.49 / 0.62 |
   * | **+ 局所流量（thr 0）** | **907 / 691** | 16.9 / 15.5 | **27.9 / 27.0** | 0.50 / 0.65 |
   *
   * **既定の 2.5% は「サーモスタットが強すぎる」側の外れ**であって、
   * サブグリッドの 27% の方が較正の意図どおり。
   */
  subgridHydrology: number
  /**
   * 河川網のトポロジーを決める陸の割合の閾値。**0 以下なら経路と同じ
   * 【セル平均の標高】で陸を決める（既定）。**
   *
   * **D8 は離散的なトポロジーを要求する**（どのセルからどのセルへ流れるか）。
   * 面積は分数にできても、経路は分数にできない。そこで
   * **「トポロジーは離散・面積は分数」**という分け方にする:
   *
   *   - 経路と窪地埋め: 陸セルを離散に決める
   *   - 流出と侵食の量: `landFraction` で重み付けする（分数）
   *
   * ★**離散側の基準は経路と揃えること。** 経路と窪地埋めは `elevation` から
   * 作った `filled` で解くので、陸判定だけ `landFraction` にすると
   * **別の集合**になる。0.5 にすると顕生代の陸の 99.4% が網から外れ、
   * 侵食が下限だけに落ちてサーモスタットが壊れた
   * （`subgridHydrology` のコメントの実測表）。
   *
   * 0 より大きい値を入れると「セルの割合が閾値以上なら陸」に切り替わる。
   * 実測では 0.5 は 0 より一貫して悪い（供給律速 32.6/29.4% vs 27.9/27.0%）。
   */
  subgridLandThreshold: number
  petBase: number
  petPerK: number

  /** stream power law の指数 */
  streamM: number
  streamN: number
  /**
   * 傾斜を【距離で割って無次元にする】。0 で従来（セル間の標高差 [m] のまま）。
   *
   * ★**2026-08-31 に見つけた単位の欠落。** `computeErosion` の傾斜は
   * `sqrt(dx² + dy²) * 0.5` で、dx・dy は隣のセルとの**標高の差 [m]**。
   * **セル幅で割っていないので無次元になっていない。**
   * 格子を細かくすると隣どうしの標高差が機械的に小さくなるので、
   * 傾斜がそのぶん小さくなる（`streamN` は 1.0 なので侵食に比例で効く）。
   *
   * 実測（seed audit・現在の地球で較正した `erosionRef`）:
   * 96x48 で 3.238e3、144x72 で **1.855e3**（1.75 倍。セル幅の比は 1.5）。
   *
   * さらに**東西方向のセル幅は緯度で cos φ 倍**変わるので、
   * 従来の式は**極ほど傾斜を過小評価**する。
   *
   * 【効き方】侵食は `carbon.ts` では `ero / erosionRef`、`tectonics.ts` では
   * `ero / eroMean` と**どちらも正規化して使う**ので、一様な倍率は打ち消える。
   * 変わるのは**分布の形**（どこが削れるか）だけ。
   */
  slopePerDistance: number
  /** 氷河侵食の強さ（氷床の縁で強い） */
  glacialErosion: number
  /**
   * 侵食の下限（全球平均に対する比）。
   *
   * 流出がゼロの超乾燥域でも、風成侵食や岩石の物理的崩壊で
   * 新鮮な岩石はわずかに露出する。厳密にゼロにすると、
   * それらのセルが【常に】供給律速になり、較正が目標割合に到達できなくなる。
   */
  erosionFloor: number
}

export const EARTH_HYDRO: HydroParams = {
  meanPrecip: 1110,
  precipTempScale: 35,
  precipScaleMin: 0.15,
  precipScaleMax: 3.0,
  moistureRechargePer100km: 0.22,
  moistureDecayKm: 1400,
  landRecycling: 0.42,
  moistureFloor: 0.26,
  orographic: 0.0011,
  orographicMax: 0.45,
  subgridHydrology: 1,
  subgridLandThreshold: 0,
  petBase: 300,
  petPerK: 42,
  streamM: 0.5,
  streamN: 1.0,
  slopePerDistance: 0,
  glacialErosion: 2.5,
  erosionFloor: 0.02,
}

/**
 * 3 セル循環による帯状の降水プロファイル（相対値）。
 * ITCZ（赤道、多雨）、亜熱帯高圧帯（±30 度、乾燥）、
 * 中緯度低圧帯（±55 度、多雨）、極（乾燥）。
 */
const ZONAL_PROFILE: readonly (readonly [number, number])[] = [
  [0, 1.00], [10, 0.86], [20, 0.46], [30, 0.30], [40, 0.56],
  [50, 0.76], [60, 0.70], [70, 0.44], [80, 0.28], [90, 0.20],
]

export function zonalPrecipShape(latDeg: number): number {
  const a = Math.abs(latDeg)
  for (let i = 1; i < ZONAL_PROFILE.length; i++) {
    const [l1, v1] = ZONAL_PROFILE[i]
    if (a <= l1) {
      const [l0, v0] = ZONAL_PROFILE[i - 1]
      return v0 + ((v1 - v0) * (a - l0)) / (l1 - l0)
    }
  }
  return ZONAL_PROFILE[ZONAL_PROFILE.length - 1][1]
}

/**
 * 卓越風の東西成分。緯度帯から決める（動的には解かない）。
 * 貿易風は東風（-1）、偏西風は西風（+1）、極偏東風は東風（-1）。
 * 戻り値は風が吹いていく向き（+1 なら西から東へ）。
 */
export function prevailingWind(latDeg: number): number {
  const a = Math.abs(latDeg)
  if (a < 30) return -1      // 貿易風: 東寄りの風 -> 西へ流れる
  if (a < 60) return 1       // 偏西風: 西寄りの風 -> 東へ流れる
  return -1                  // 極偏東風
}

/**
 * 窪地埋めの微小勾配 [m]。
 * 1000 セルの経路でも 1m しか持ち上がらないので地形への影響は無視できる。
 */
const FILL_EPSILON = 0.001

export class Hydrology implements Subsystem {
  readonly name = "hydrology"
  // 準静的なので毎ティック解き直すだけでよい。
  // ここに小さい値を入れると SimLoop の刻みを支配してしまい、
  // 地質時間が進まなくなる（実際に 40Myr 要求が 0.8Myr しか進まなくなった）。
  // 河川網と降水は 10^4〜10^5 年スケールでしか変わらないので、
  // 炭素循環のサブステップ（25,000 年）ごとに走らせる必要はない。
  // D8 のソートと窪地埋めが毎サブステップ走ると地質時間の計算が 16 倍遅くなる。
  // 1 サブステップしかないとき（ゲーム中の通常速度）は SimLoop が毎ティック呼ぶ。
  readonly preferredStepYears = 250_000
  readonly maxStepYears = 1e9

  params: HydroParams
  /** 標高の降順に並べたセル添字。D8 の集水積算に使う */
  private order: Int32Array | null = null
  private downstream: Int32Array | null = null
  /** 窪地を埋めた標高。流路探索はこちらを使う */
  private filled: Float32Array | null = null
  /**
   * 帯状プロファイルの面積重み平均を 1 にする係数。
   * 正規化を忘れると全球平均降水が profile の平均分だけ小さくなる
   * （実際に 1000 -> 585 mm/yr になった）。
   */
  private shapeNorm = 1

  /** ★セーブ用。`shapeNorm` は最初の 1 回だけ較正される（`=== 1` が合図）*/
  snapshot(): number { return this.shapeNorm }
  restore(v: number): void { this.shapeNorm = v }

  constructor(params: Partial<HydroParams> = {}) {
    this.params = { ...EARTH_HYDRO, ...params }
  }

  update(world: World): void {
    if (this.shapeNorm === 1) this.calibrateShape(world)
    this.computePrecip(world)
    this.computeRunoff(world)
    this.routeFlow(world)
    this.computeErosion(world)
  }

  /** 帯状プロファイルの面積重み平均が 1 になるよう正規化する */
  private calibrateShape(world: World): void {
    const { H } = world.grid
    let acc = 0
    for (let y = 0; y < H; y++) {
      acc += zonalPrecipShape(world.grid.latDeg[y]) * world.grid.areaWeight[y] * world.grid.W
    }
    this.shapeNorm = acc > 0 ? 1 / acc : 1
  }

  /**
   * 降水。帯状プロファイル × 温度による強化 × 東西方向の水蒸気移流。
   *
   * 移流は行ごとに 1 次元で解く。経度は巡回しているので、
   * 収束するまで数周させる（3 周で十分）。
   */
  private computePrecip(world: World): void {
    const { W, H } = world.grid
    const p = this.params
    const elev = world.store.f32("elevation").read
    const ice = world.store.f32("iceFraction").read
    const precip = world.store.f32("precip").read
    const sea = world.globals.seaLevel
    const meanT = world.stats?.meanT ?? 14.5
    const globalScale = p.meanPrecip * Math.min(p.precipScaleMax,
      Math.max(p.precipScaleMin, fastExp((meanT - 14.5) / p.precipTempScale)))

    const R = 6.371e6
    for (let y = 0; y < H; y++) {
      const lat = world.grid.latDeg[y]
      const shape = zonalPrecipShape(lat) * this.shapeNorm
      const dir = prevailingWind(lat)
      const row = y * W
      // セルの東西幅 [km]。これで減衰率を決めるので解像度に依存しない
      const cellKm = ((2 * Math.PI * R * Math.cos(world.grid.latRad[y])) / W) / 1000
      const dropPerCell = 1 - fastExp(-cellKm / p.moistureDecayKm)
      const rechargePerCell = 1 - fastExp(-(cellKm / 100) * p.moistureRechargePer100km)
      const start = dir > 0 ? 0 : W - 1
      let moisture = 1

      for (let pass = 0; pass < 3; pass++) {
        for (let k = 0; k < W; k++) {
          const x = ((start + dir * k) % W + W) % W
          const i = row + x
          if (elev[i] < sea) {
            // 海上では蒸発で水蒸気が回復する
            moisture += (1 - moisture) * rechargePerCell
            if (pass === 2) precip[i] = globalScale * shape * moisture
            continue
          }
          // 陸上: 風上斜面で余計に降る（地形性降水）
          const xUp = ((x - dir) % W + W) % W
          const rise = Math.max(0, elev[i] - Math.max(elev[row + xUp], sea))
          // 地形性降水の増分には上限を置く。
          // 1 セルが 100km 級なので、点の記録（1万 mm/yr）がセル平均で出るのはおかしい。
          const oro = Math.min(p.orographicMax, p.orographic * rise)
          const frac = Math.min(0.9, dropPerCell + oro)
          const fallen = moisture * frac
          // 降った分の一部は再蒸発して風下に持ち越される
          moisture = Math.max(p.moistureFloor, moisture - fallen * (1 - p.landRecycling))
          if (pass === 2) {
            // 氷床の上は実効降水ゼロ扱い（docs/01-5.2）
            precip[i] = globalScale * shape * (fallen / dropPerCell) * (1 - ice[i])
          }
        }
      }
    }
  }

  /** 流出 = 降水 - 蒸発散。土壌水分も更新する。 */
  private computeRunoff(world: World): void {
    const { W, H } = world.grid
    const p = this.params
    const elev = world.store.f32("elevation").read
    const precip = world.store.f32("precip").read
    const runoff = world.store.f32("runoff").read
    const sm = world.store.f32("soilMoisture").read
    const T = world.store.f32("surfaceTemp").read
    const sea = world.globals.seaLevel
    // セル内の陸の割合。`subgridHydrology` が 0 なら 0/1 と同じ値が入っている
    const lf = world.store.f32("landFraction").read
    const sub = p.subgridHydrology > 0

    for (let y = 0; y < H; y++) {
      const row = y * W
      for (let x = 0; x < W; x++) {
        const i = row + x
        const f = sub ? lf[i] : (elev[i] >= sea ? 1 : 0)
        if (f <= 0) { runoff[i] = 0; sm[i] = 1; continue }
        // 可能蒸発散。温度が高いほど大きい
        const pet = p.petBase + p.petPerK * Math.max(0, T[i])
        const et = Math.min(precip[i], pet)
        // 【陸の割合で重み付け】。セルの 3 割が陸なら流出も 3 割
        runoff[i] = f * Math.max(0, precip[i] - et)
        sm[i] = pet > 0 ? Math.min(1, precip[i] / pet) : 1
      }
    }
  }

  /**
   * D8 流下方向と集水積算。
   *
   * docs/04-8.3: これは依存グラフの走査なので GPU が最も苦手な処理。
   * 河川網は地質時間スケールでしか変わらないので CPU に残すのが正解。
   * 標高の降順に処理すれば 1 パスで積算できる（O(n log n) はソートのみ）。
   */
  private routeFlow(world: World): void {
    const { W, H } = world.grid
    const n = world.grid.cellCount
    const elev = world.store.f32("elevation").read
    const runoff = world.store.f32("runoff").read
    const discharge = world.store.f32("discharge").read
    const sea = world.globals.seaLevel
    // 【トポロジーは離散・面積は分数】（`subgridLandThreshold`）
    const lf = world.store.f32("landFraction").read
    const sub = this.params.subgridHydrology > 0
    const thr = this.params.subgridLandThreshold
    // 閾値が 0 以下なら【経路と同じ場】＝セル平均の標高で陸を決める。
    // 経路と窪地埋めは `elev` から作った `filled` で解くので、
    // 陸判定だけ `lf` にすると別の集合になる（下のコメントの実測）。
    const isLand = (i: number) => sub && thr > 0 ? lf[i] >= thr : elev[i] >= sea

    if (!this.order || this.order.length !== n) {
      this.order = new Int32Array(n)
      this.downstream = new Int32Array(n)
      this.filled = new Float32Array(n)
    }
    const order = this.order
    const down = this.downstream!
    const filled = this.filled!

    this.fillDepressions(world, filled)

    // 流下方向: 8 近傍で最も急に下るセル（窪地を埋めた面で探す）
    for (let y = 0; y < H; y++) {
      const row = y * W
      for (let x = 0; x < W; x++) {
        const i = row + x
        if (!isLand(i)) { down[i] = -1; continue }
        let best = -1
        let bestDrop = 0
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= H) continue
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue
            const xx = ((x + dx) % W + W) % W
            const j = yy * W + xx
            const dist = dx !== 0 && dy !== 0 ? 1.4142135 : 1
            const drop = (filled[i] - filled[j]) / dist
            // 同値は添字順で決定論的に選ぶ（docs/04-6）
            if (drop > bestDrop || (drop === bestDrop && best >= 0 && j < best)) {
              bestDrop = drop; best = j
            }
          }
        }
        down[i] = best
      }
    }

    // 埋めた標高の降順。同値は添字順（決定論的）
    const arr = new Array<number>(n)
    for (let i = 0; i < n; i++) arr[i] = i
    arr.sort((a, b) => filled[b] - filled[a] || a - b)
    order.set(arr)

    // ★**網に入らない部分的な陸も、自分の降った雨の分だけは流量を持つ。**
    //
    // セルの 3 割が陸で平均標高が海面下、というセルは河川網の外だが、
    // その陸に降った雨は【セルの中で直接海へ出る】。ここを 0 にすると
    // 侵食が下限だけになり、風化の需要には面積で参加するのに
    // 供給が伴わない——顕生代の陸の 99.4% がそれだった（実測）。
    for (let i = 0; i < n; i++) {
      const y = (i / W) | 0
      const local = sub ? lf[i] > 0 : elev[i] >= sea
      discharge[i] = local ? (runoff[i] / 1000) * world.grid.cellArea[y] : 0
    }
    for (let k = 0; k < n; k++) {
      const i = order[k]
      const j = down[i]
      if (j >= 0 && isLand(j)) discharge[j] += discharge[i]
    }
  }

  /**
   * 窪地埋め (priority-flood)。
   *
   * ノイズで作った地形には窪地が大量にあり、そのままだと D8 の流れが
   * 途中で止まって河川網ができない（上位 1% のセルが全流量の 16% しか
   * 集めなかった。まともな河川網なら 40% 以上になる）。
   *
   * 海から始めて標高の低い順に外向きに広げ、各セルの「埋めた標高」を
   * そこに至る経路上の最大標高にする。これで窪地のないなだらかな面が得られる。
   * 優先度付きキュー（二分ヒープ）が要るので O(n log n)。
   *
   * docs/04-8.3: これは本質的に逐次的な処理なので GPU には移植しない。
   * 河川網は地質時間スケールでしか変わらないため CPU に残すのが正解。
   */
  private fillDepressions(world: World, filled: Float32Array): void {
    const { W, H } = world.grid
    const n = world.grid.cellCount
    const elev = world.store.f32("elevation").read
    const sea = world.globals.seaLevel
    // 経路と同じ基準で海を決める（`subgridLandThreshold`）
    const lf = world.store.f32("landFraction").read
    const sub = this.params.subgridHydrology > 0
    const thr = this.params.subgridLandThreshold
    const isSea = (i: number) => sub ? lf[i] < thr : elev[i] < sea

    const visited = new Uint8Array(n)
    // 二分ヒープ（キー = 埋めた標高、値 = セル添字）
    const key = new Float64Array(n + 1)
    const val = new Int32Array(n + 1)
    let size = 0
    const push = (k: number, v: number) => {
      let i = ++size
      key[i] = k; val[i] = v
      while (i > 1) {
        const par = i >> 1
        if (key[par] <= key[i]) break
        const tk = key[par], tv = val[par]
        key[par] = key[i]; val[par] = val[i]; key[i] = tk; val[i] = tv
        i = par
      }
    }
    const pop = (): number => {
      const top = val[1]
      key[1] = key[size]; val[1] = val[size]; size--
      let i = 1
      for (;;) {
        const l = i << 1, r = l + 1
        let m = i
        if (l <= size && key[l] < key[m]) m = l
        if (r <= size && key[r] < key[m]) m = r
        if (m === i) break
        const tk = key[m], tv = val[m]
        key[m] = key[i]; val[m] = val[i]; key[i] = tk; val[i] = tv
        i = m
      }
      return top
    }

    // 海はそのまま。海を種にして外へ広げる。
    for (let i = 0; i < n; i++) {
      if (isSea(i)) { filled[i] = elev[i]; visited[i] = 1; push(elev[i], i) }
      else filled[i] = elev[i]
    }
    // 海が一つも無い惑星では最も低い陸を種にする
    if (size === 0) {
      let lo = 0
      for (let i = 1; i < n; i++) if (elev[i] < elev[lo]) lo = i
      visited[lo] = 1; push(elev[lo], lo)
    }

    while (size > 0) {
      const i = pop()
      const y = (i / W) | 0, x = i % W
      const base = filled[i]
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= H) continue
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const j = yy * W + ((x + dx) % W + W) % W
          if (visited[j]) continue
          visited[j] = 1
          // 経路上の最大標高まで持ち上げる = 窪地が埋まる。
          // ただし【微小勾配 EPS を足す】こと。等高で埋めると窪地が平坦域になり、
          // D8 が流下先を見つけられず流れがそこで止まる（典型的な失敗）。
          const lift = base + FILL_EPSILON
          filled[j] = elev[j] > lift ? elev[j] : lift
          push(filled[j], j)
        }
      }
    }
  }

  /**
   * stream power law による侵食。E = K * Q^m * S^n
   *
   * これが M2 の供給律速の入力になる（docs/01-4.2）。
   * 氷河侵食を別枠で加える —— 氷期には侵食が跳ね上がり、
   * 供給律速だった土地が速度論律速に戻る。
   */
  private computeErosion(world: World): void {
    const { W, H } = world.grid
    const p = this.params
    const elev = world.store.f32("elevation").read
    const ice = world.store.f32("iceFraction").read
    const discharge = world.store.f32("discharge").read
    const ero = world.store.f32("erosionRate").read
    const sea = world.globals.seaLevel
    const lf = world.store.f32("landFraction").read
    const sub = p.subgridHydrology > 0
    let mx = 0, rawSum = 0, rawN = 0

    // セルの幅 [m]。傾斜を無次元にするために割る（`slopePerDistance`）。
    // 東西は緯度で cos φ 倍変わる。極では 0 に落ちるので、
    // 南北のセル幅を下限にして発散を止める（そこは南北の傾斜が支配する）
    const phys = p.slopePerDistance > 0
    const dyM = (Math.PI * EARTH_RADIUS_M) / H
    for (let y = 0; y < H; y++) {
      const row = y * W
      const rowN = y > 0 ? row - W : row
      const rowS = y < H - 1 ? row + W : row
      // 東西のセル幅は cos φ で縮む。**ここを `dyM` で下限すると
      // kx = ky になって「一様な倍率」にしかならず、侵食は正規化して
      // 使われるので【何も変わらない】**（実測で緯度帯の取り分が完全に同一）。
      // 極の特異点を避けるためだけに cos φ に小さな下限を置く
      const dxM = (2 * Math.PI * EARTH_RADIUS_M
        * Math.max(0.1, Math.cos(world.grid.latRad[y]))) / W
      // 中央差分なので 2 セルぶんの距離で割る。従来の 0.5 と同じ役目
      const kx = phys ? 1 / (2 * dxM) : 0.5
      const ky = phys ? 1 / (2 * dyM) : 0.5
      for (let x = 0; x < W; x++) {
        const i = row + x
        const f = sub ? lf[i] : (elev[i] >= sea ? 1 : 0)
        if (f <= 0) { ero[i] = 0; continue }
        const xe = x + 1 === W ? 0 : x + 1
        const xw = x === 0 ? W - 1 : x - 1
        const dx = (elev[row + xe] - elev[row + xw]) * kx
        const dy = (elev[rowS + x] - elev[rowN + x]) * ky
        const slope = Math.sqrt(dx * dx + dy * dy)

        // 流量は m³/yr のオーダーなので対数的に潰してから累乗する
        const q = Math.max(0, discharge[i]) / 1e9
        const fluvial = Math.pow(q, p.streamM) * Math.pow(slope, p.streamN)
        // 氷河侵食: 氷の縁（氷があり、かつ傾斜がある）で強い
        const glacial = p.glacialErosion * ice[i] * slope
        // ★**侵食は【単位陸地面積あたり】の速度。陸の割合を掛けてはいけない。**
        //
        // `carbon.ts` は `supplyRate = sBase * ero[i] * invEroRef` として使い、
        // 面積の重みは別途 `landFraction` で掛けている。ここでも掛けると
        // **lf の二重計上**になり、部分的に陸のセルが「単位陸地面積あたりの
        // 侵食が lf 倍だけ少ない」ように見えて供給律速と誤判定される。
        // 実測: サブグリッド化を進めるほど顕生代 CO2 が単調に悪化した
        // （1342 → 8491 → 8093 → 16045ppm）原因がこれ。
        //
        // **流出（runoff）の重み付けは正しい。** discharge はセル全体の面積を
        // 掛けた【総量】なので、陸が 3 割なら流量も 3 割になる。
        ero[i] = fluvial + glacial
        if (ero[i] > mx) mx = ero[i]
        rawSum += ero[i]
        rawN++
      }
    }

    // 下限を足す。厳密にゼロのセルを残さない（較正の到達性のため）
    const floor = rawN > 0 ? (rawSum / rawN) * p.erosionFloor : 0
    for (let i = 0; i < ero.length; i++) {
      const f = sub ? lf[i] : (elev[i] >= sea ? 1 : 0)
      if (f > 0) ero[i] += floor
    }
    void mx
  }
}

/** 参考: 温度から可能蒸発散を返す（デバッグ・検証用） */
export function potentialET(p: HydroParams, tC: number): number {
  return p.petBase + p.petPerK * Math.max(0, tC)
}

/** 参考: Clausius-Clapeyron 的な水蒸気量の温度依存 */
export function saturationScale(tC: number): number {
  return fastExp(tC / 16)
}

/**
 * 惑星の全体状態。シミュレーションの外側の入れ物。
 *
 * docs/04-4 の sim/loop.ts に相当する駆動部は loop.ts にある。
 * ここはサブシステムと場と台帳を束ねる。
 */

import { Grid } from "../core/grid"
import { FieldStore, type FieldSpec } from "../core/fields"
import { Ledger } from "../core/ledger"
import { generateTerrain, DEFAULT_TERRAIN, type TerrainOptions } from "../worldgen/terrain"
import { Climate, M1_FIELDS, type ClimateStats, type SolveOptions } from "./climate"
import { CarbonCycle, CARBON_FIELDS, type CarbonParams } from "./carbon"
import { Hydrology, HYDRO_FIELDS, type HydroParams } from "./hydrology"
import { Mantle, MODE_TRAITS, type MantleParams } from "./mantle"
import {
  Tectonics, TECTONIC_FIELDS, OC_REF_THICK_KM, type TectonicParams,
} from "./tectonics"
import { Ocean, OCEAN_FIELDS, type OceanParams } from "./ocean"
import { Prebiotic, PREBIOTIC_FIELDS, type PrebioticParams } from "./prebiotic"
import { Life, LIFE_FIELDS } from "./life"
import { GENE_KINDS } from "./genome"
import { Oxygen, type OxygenParams } from "./oxygen"
import { SimLoop, epochAt, resolveSpeed, type EpochDef, type StepReport } from "./loop"
import {
  EARTH_PARAMS, earthGlobals, HADEAN_START, solarConstantForElapsed, ch4FromOxygen,
  type PlanetParams, type PlanetGlobals,
} from "./state"
import {
  recordClimateContributions, snapshotClimate, type ClimateSnapshot,
} from "./climateLedger"

/** 現時点で存在する全フィールド。マイルストーンごとに増える */
export const WORLD_FIELDS: readonly FieldSpec[] =
  [...M1_FIELDS, ...CARBON_FIELDS, ...HYDRO_FIELDS, ...TECTONIC_FIELDS, ...OCEAN_FIELDS,
    ...PREBIOTIC_FIELDS, ...LIFE_FIELDS]

/**
 * ★**陸の面積割合。物理が食べているのと同じ量を返す。**
 *
 * 気候のアルベド（`climate.ts`）も炭素の風化（`carbon.ts`）も、
 * **サブグリッドの `landFraction`** を読んでいる。ところが測定の側は
 * ずっと `elevation >= seaLevel`（セル平均の離散判定）を見ていた。
 *
 * ★**2 つは「まとまった陸が消えると」開く。** 実測（96x48・4 seed・全史）:
 *
 * | | 冥王代 | 原生代 | 顕生代 |
 * |---|---|---|---|
 * | 一致度（lf ÷ elev） | 1.00〜1.12 | **最大 3.48** | 1.2〜1.6 |
 * | `landFraction` | 26〜29% | 約 21% | 15.5〜19.8% |
 * | `elevation >= 海面` | 25〜29% | **5.3% まで落ちる** | 12〜19% |
 *
 * 理由は `CLAUDE.md` の 23 と同じ —— **半分が厚い地殻・半分が薄い**セルでは、
 * セル平均の標高は海面を下回るのに、粒子の半分は海面より上にある。
 *
 * だから**測るのはこちら**。定義を 1 か所に置く（2 つあったのが原因なので）。
 */
export function landAreaFraction(world: World): number {
  const { W, H } = world.grid
  const lf = world.store.f32("landFraction").read
  let a = 0, tot = 0
  for (let y = 0; y < H; y++) {
    const aw = world.grid.areaWeight[y]
    for (let x = 0; x < W; x++) { a += lf[y * W + x] * aw; tot += aw }
  }
  return tot > 0 ? a / tot : 0
}

/**
 * 参考: セル平均の標高で切った陸（**測定の基準にはしないこと**）。
 * 上の食い違いを見張るカナリアとして残す。
 */
export function landAreaByElevation(world: World): number {
  return world.grid.areaFractionWhere(
    world.store.f32("elevation").read, (v) => v >= world.globals.seaLevel)
}

/** 惑星の総年齢 [yr]。地球は 45.4 億年 */
export const PLANET_AGE_YEARS = 4.54e9

/**
 * 気候と炭素循環の結合間隔の上限 [yr]。docs/01-3.5, docs/01-6.5c。
 *
 * 気候は準静的（100 年で平衡）なので毎ティック解き直せばよい、と考えていたが、
 * 【何年ごとに解き直すか】が結果を変える。炭素は 25 kyr ごとに CO2 を動かし、
 * 風化は温度に指数で依存するので、古い温度を使うと誤差が効く。
 *
 * 実測（CO2 4 倍の摂動からの回復、300 万年後の CO2）:
 *   結合間隔 5〜50 kyr  -> 306〜311 ppm（収束）
 *   結合間隔 60〜250 kyr -> 302〜624 ppm（散らばる）
 *
 * 以前は結合間隔が呼び出し側の要求年数そのものだった。
 * ワーカーは years = yearsPerSecond x 実測フレーム時間 で進めるので、
 * 【マシンの速さで物理が 2 倍変わっていた】。
 * ここで上限を切ることで、フレーム時間に依らず誤差が有界になる。
 */
export const CLIMATE_COUPLING_YEARS = 50_000

/** 気候ソルバの差し替え口。GPU 版がこれを満たす。 */
export interface ClimateBackend {
  solve(store: FieldStore, p: PlanetParams, g: PlanetGlobals): Promise<ClimateStats>
}

/** タイムラインに刻まれる出来事（docs/03-5.6） */
/**
 * 氷期の状態がこれだけ続いて初めて出来事にする [yr]。
 *
 * ★**ヒステリシスだけでは足りなかった**（`detectGlaciation` の説明）。
 * 地質学でいう氷期は数千万年〜数億年続く（ヒューロニアン氷期は約 3 億年）。
 * 20Myr なら、実測で見つかった 4Myr 周期の極限周期は刻まれず、
 * 本物の氷期だけが残る。
 */
const GLACIATION_HOLD_YEARS = 20e6

export interface WorldEvent {
  year: number
  kind: "tectonicMode" | "lip" | "supercontinent" | "impact" | "milestone"
  text: string
  /**
   * 絵の識別子（`public/icons/<code>.png`）。
   *
   * ★**本文の日本語で絵を選ばないこと。** 文言を直した瞬間に絵が消える。
   * 出す側が機械可読な名前を付ける。絵が無ければ UI 側が黙って落とす
   * （`docs/07-art-spec.md`）。
   */
  code?: string
}

export interface WorldOptions {
  width: number
  height: number
  seed: string
  terrain?: Partial<TerrainOptions>
  params?: Partial<PlanetParams>
  carbon?: Partial<CarbonParams>
  hydro?: Partial<HydroParams>
  mantle?: Partial<MantleParams>
  tectonics?: Partial<TectonicParams>
  ocean?: Partial<OceanParams>
  prebiotic?: Partial<PrebioticParams>
  oxygen?: Partial<OxygenParams>
  /** マントルの初期温度 [degC]。高いほどプレートテクトニクスの開始が遅れる */
  initialMantleTempC?: number
  /**
   * 惑星の初期状態。既定は "present"。
   *
   * "present": 現在の地球。太陽定数 1361 W/m²、CO2 280ppm、マントル 1350℃。
   *            **較正の基準状態**であり、テストと較正はこれを使う。
   *            太陽光度は固定（時間発展させない）。
   * "hadean":  45.4 億年前の冥王代。暗い太陽 974 W/m²、CO2 0.1 bar、
   *            マグマオーシャン。**ゲームはここから始まる。**
   *            太陽光度は経過年数に応じて明るくなる。
   *
   * 【なぜ既定が "present" か】
   * `World` の既定＝較正済みの地球という位置づけを保つため。
   * 既定を冥王代にすると「現在の地球が再現される」というテストが
   * 冥王代の惑星を検査することになってしまう。
   */
  startEpoch?: "present" | "hadean"
  /**
   * 太陽光度を経過年数に応じて変化させるか。
   * 省略時は startEpoch に従う（hadean なら true、present なら false）。
   */
  evolvingSun?: boolean
  /**
   * 固体地球（マントル・テクトニクス）を回すか。既定 true。
   * false にすると地形が固定される。
   * 炭素循環など個別のサブシステムを単体で検証するときに使う。
   */
  enableTectonics?: boolean
  /**
   * 気候と炭素の結合間隔 [yr]。省略時は CLIMATE_COUPLING_YEARS（5 万年）。
   * CO2 の平衡値に依存しない検証では大きくしてよい（その分速くなる）。
   */
  climateCouplingYears?: number
  shared?: boolean
}

export class World {
  readonly grid: Grid
  readonly store: FieldStore
  readonly climate: Climate
  readonly carbon: CarbonCycle
  readonly hydrology: Hydrology
  readonly mantle: Mantle
  readonly tectonics: Tectonics
  readonly ocean: Ocean
  /** 前生命化学（生命が生まれるまで）。docs/02 §2.0 */
  readonly prebiotic: Prebiotic
  /** 生命。docs/02 §2 */
  readonly life: Life
  /** 酸素。docs/02 §3.1。生命が動かす */
  readonly oxygen: Oxygen
  readonly loop = new SimLoop()
  readonly ledger = new Ledger()
  params: PlanetParams
  globals: PlanetGlobals
  /** ★この惑星の seed。セーブとロードに要る（決定論の入口） */
  readonly seed: string
  stats: ClimateStats | null = null
  lastStep: StepReport | null = null
  /** 主要な出来事の記録。タイムライン UI が読む */
  readonly events: WorldEvent[] = []
  /** 太陽光度を経過年数に応じて変化させるか */
  evolvingSun = false
  readonly planetAgeYears = PLANET_AGE_YEARS

  private prevSnapshot: ClimateSnapshot | null = null

  constructor(opts: WorldOptions) {
    this.grid = new Grid(opts.width, opts.height)
    this.store = new FieldStore(this.grid, WORLD_FIELDS,
      opts.shared === false ? { shared: false } : {})
    this.climate = new Climate(this.grid)
    this.carbon = new CarbonCycle(opts.carbon)
    this.hydrology = new Hydrology(opts.hydro)
    const hadean = opts.startEpoch === "hadean"
    this.mantle = new Mantle(opts.mantle,
      opts.initialMantleTempC ?? (hadean ? HADEAN_START.mantleTempC : 1350))
    this.seed = opts.seed
    this.tectonics = new Tectonics(opts.seed, opts.tectonics)
    this.ocean = new Ocean(opts.ocean)
    this.prebiotic = new Prebiotic(opts.seed, opts.prebiotic)
    this.life = new Life(opts.seed)
    this.oxygen = new Oxygen(opts.oxygen)
    this.params = { ...EARTH_PARAMS, ...opts.params }
    this.globals = earthGlobals()
    // 【較正は必ず「現在の地球」の内部熱流で行う】★2026-08-28
    //
    // 内部熱流は気候の強制項なので、較正の後に変えると
    // 「較正時と実行時で違う気候」になり基準状態が定常でなくなる
    // （後ろに置いていて 3Myr で CO2 が 280 -> 759ppm に流れた）。
    //
    // かといって【この時点のマントルの値】を使ってもいけない。
    // 冥王代開始ではマントルが 2250℃ で 285 W/m² あり、
    // 地表 168℃ の状態を「定常な現在の地球」として較正してしまう
    // （実測: 顕生代の CO2 が 2.6e12 ppm、気温 117℃ で暴走した）。
    //
    // 較正は現在の地球の値（約 0.059 W/m²）で行い、
    // 冥王代の値は applyHadeanStart で入れる。
    this.globals.internalHeatFlux = this.mantle.presentFluxWm2
    generateTerrain(this.grid, this.store, opts.seed, { ...DEFAULT_TERRAIN, ...opts.terrain })

    // 温帯の初期プロファイルから始める。一様な初期値より収束が速く、
    // かつスノーボール分枝に落ちにくい。
    const T = this.store.f32("temperature").read
    for (let y = 0; y < this.grid.H; y++) {
      const v = 28 - 50 * this.grid.sinLat[y] * this.grid.sinLat[y]
      for (let x = 0; x < this.grid.W; x++) T[y * this.grid.W + x] = v
    }
    this.store.f32("albedo").read.fill(0.3)

    // 生成された地形から地殻の厚さと年齢を逆算する。
    // これ以降の地形はテクトニクスが作る。
    this.initCrustFromTerrain()
    this.tectonics.init(this)

    // 順序が重要:
    //   マントル -> テクトニクス（地形）-> 気候 -> 水循環（降水は温度に依存）
    //   -> 侵食 -> 炭素の較正（風化は侵食に依存）
    this.solveClimate()
    this.hydrology.update(this)
    this.ocean.update(this, 0)
    // 炭素循環の較正は【必ず現在の地球の状態で】行う。
    // 「現在の地球は定常である」が火山脱ガス量の定義だから（carbon.ts recalibrate）。
    // 冥王代の状態で較正すると、その凍った惑星が定常だと宣言することになる。
    this.carbon.recalibrate(this)
    // 海洋も【現在の地球】で較正する（ocean.ts の recalibrate）。
    // 炭素と同じく「現在の地球はこうなっている」を定数の定義に使うので、
    // 冥王代の状態で呼んではいけない。
    this.ocean.recalibrate(this)

    if (opts.climateCouplingYears !== undefined) {
      this.climateCouplingYears = opts.climateCouplingYears
    }
    this.evolvingSun = opts.evolvingSun ?? hadean
    if (hadean) this.applyHadeanStart()

    if (opts.enableTectonics !== false) this.loop.add(this.mantle).add(this.tectonics)
    // 順序: 水循環 -> 海洋（熱塩循環が降水と流出を読む）-> 炭素
    // 前生命化学は熱水（海洋）と陸・火山（テクトニクス）と気温を読むので最後
    this.loop.add(this.hydrology).add(this.ocean).add(this.carbon).add(this.prebiotic).add(this.life).add(this.oxygen)
  }

  /**
   * 較正が済んだあとで、初期状態を冥王代に飛ばす。
   *
   * 較正の後に置くのが重要（上のコメント参照）。
   */
  private applyHadeanStart(): void {
    this.globals.yearsElapsed = 0
    this.globals.co2 = HADEAN_START.co2
    this.globals.ch4 = HADEAN_START.ch4
    // ★冥王代に生物圏は無い。メタンの供給は非生物起源（蛇紋岩化）だけ。
    // これを 1 のままにすると、生命がいなくても無酸素なら CH4 が上限に張り付く
    this.globals.biosphereProxy = 0
    // 冥王代を無酸素にするのは、酸素の機構が有効なときだけ。
    // O2 を下げると CH4 が上限まで上がるので、上げ返す機構（光合成）が
    // 無いまま下げると惑星が凍る（`oxygen.ts` の `enabled` のコメント）
    if (this.oxygen.params.enabled > 0) this.globals.o2 = HADEAN_START.o2
    // マグマオーシャン期に液体の海は無い。水は水蒸気として大気にある
    this.globals.oceanWaterFraction = HADEAN_START.oceanWaterFraction
    this.globals.steamFraction = HADEAN_START.steamFraction
    // 較正が済んだのでマントルの実際の値に切り替える（マグマオーシャンは 285 W/m²）
    this.globals.internalHeatFlux = this.mantle.surfaceFluxWm2
    this.applySun()
    this.solveClimate()
    this.hydrology.update(this)
    this.ocean.update(this, 0)
    this.events.push({
      year: 0, kind: "milestone", code: "ev-hadean",
      text: `冥王代の開始: 太陽は現在の ${(this.globals.solarConstant / 1361 * 100).toFixed(0)}%、` +
        `CO₂ ${(HADEAN_START.co2 / 1e4).toFixed(1)}%、マグマオーシャン。水はすべて水蒸気`,
    })
  }

  /** 初期地形（ノイズ生成）から地殻の厚さ・年齢・組成を逆算する */
  private initCrustFromTerrain(): void {
    const elev = this.store.f32("elevation").read
    const thick = this.store.f32("crustThickness").read
    const age = this.store.f32("crustAge").read
    const fel = this.store.f32("felsic").read
    const tp = this.tectonics.params
    const comp = tp.crustComposition > 0
    // 【現在の地球の値を使う】。ここはノイズで作った地形からの逆算なので、
    // その地形が前提にしている現在の地球の海洋地殻（7km）で戻す。
    // 初期マントル温度（冥王代なら 2250℃）で計算すると 40km になり、
    // 海底が海面より上に出る。海嶺が実際に厚い地殻を作るのは
    // モバイルリッドに入ってからで、それは tectonics が担当する。
    const hOc = OC_REF_THICK_KM
    for (let i = 0; i < elev.length; i++) {
      const km = elev[i] / 1000
      if (km >= 0) {
        // Airy アイソスタシーの逆算。組成があれば珪長質（大陸）
        thick[i] = Math.max(tp.continentThreshold + 1, (km + 4.8) / 0.1515)
        age[i] = 0
        fel[i] = 1
      } else if (comp) {
        // 【組成あり】海面下は 2 種類に分かれる:
        //   浅い（> −2.6km）= 引き伸ばされた大陸縁。珪長質のまま薄い
        //   深い（< −2.6km）= 玄武岩質の海洋地殻。厚さはマントル温度が決める
        // 境目は海嶺頂部の深さ 2.6km。滑らかに繋ぐ。
        const t = Math.min(1, Math.max(0, (-km - 2.6) / 1.2))
        const f = 1 - t * t * (3 - 2 * t)          // smoothstep で 1 -> 0
        fel[i] = f
        if (f > 0.5) {
          // 大陸縁: アイリー均衡の逆算（珪長質の係数 0.1515）
          thick[i] = Math.max(tp.riftFloorKm, (km + 4.8) / 0.1515)
        } else {
          thick[i] = hOc
        }
        // 年齢-深度関係の逆算: depth = 2600 + 350*sqrt(age)
        const d = -km * 1000
        age[i] = Math.min(tp.maxOceanAge, Math.pow(Math.max(0, d - 2600) / 350, 2))
      } else {
        thick[i] = Math.max(0, tp.continentThreshold * (1 + km / 3))
        fel[i] = 0
        const d = -km * 1000
        age[i] = Math.min(tp.maxOceanAge, Math.pow(Math.max(0, d - 2600) / 350, 2))
      }
    }
    this.store.f32("crustThickness").write.set(thick)
    this.store.f32("crustAge").write.set(age)
    this.store.f32("felsic").write.set(fel)
  }

  /**
   * LIP（巨大火成岩岩石区）を発生させる。docs/01-6.3。
   *
   * ランダムイベントではなく、大陸が LLSVP の縁（PGZ）を通過したときに起きる。
   * つまり【予測可能な大量絶滅】になる。プレイヤーは数千万年先の危機を見て、
   * 大陸を逃がすか、生物圏を強靭化するかを選べる。
   */
  triggerLip(exposureFraction: number): void {
    const co2Pulse = 600 + 2600 * Math.min(1, exposureFraction * 6)
    this.globals.co2 += co2Pulse
    this.ledger.add("co2", co2Pulse, "volcanism.lip")
    this.events.push({
      year: this.globals.yearsElapsed,
      kind: "lip", code: "ev-lip",
      text: `巨大火成岩岩石区の噴出（CO₂ +${co2Pulse.toFixed(0)} ppm）`,
    })
  }

  get tectonicMode() {
    return this.mantle.state.mode
  }

  get tectonicTraits() {
    return MODE_TRAITS[this.mantle.state.mode]
  }

  get epoch(): EpochDef {
    return epochAt(this.globals.yearsElapsed, PLANET_AGE_YEARS)
  }

  /** 現在のエポックと速度倍率から、1 実時間秒あたりの進行年数を返す */
  yearsPerSecond(multiplier: number): number {
    return resolveSpeed(this.epoch, multiplier)
  }

  /**
   * 気候を平衡まで解き、寄与を台帳に積む（commit はしない）。
   *
   * docs/01-3.5: 地質エポックでは気候は常に平衡にあるので、
   * 時間積分ではなく平衡解を求めるのが正しく、かつ速い。
   */
  /**
   * 気候と炭素の結合間隔 [yr]。既定は CLIMATE_COUPLING_YEARS。
   *
   * 【精度と速度の交換】これを大きくすると気候ソルバの呼び出しが減って速くなるが、
   * 炭素が古い温度で風化を計算するため CO2 の平衡値がずれる。
   * 実測では 50 kyr 以下なら 1.5% 以内に収まり、それ以上だと最大 2 倍ずれる。
   * CO2 の値に依存しない検証（テクトニクスの体積収支など）では緩めてよい。
   */
  climateCouplingYears = CLIMATE_COUPLING_YEARS

  /**
   * 気候の計算を差し替えるための口。null なら CPU 版を使う。
   * GPU バックエンドはここに刺す（src/gpu/gpuClimate.ts）。
   */
  climateBackend: ClimateBackend | null = null

  solveClimate(opts?: Partial<SolveOptions>): ClimateStats {
    return this.afterClimate(this.climate.solve(this.store, this.params, this.globals, {
      dtYears: null, cgTol: 1e-2, ...opts,
    }))
  }

  /**
   * 気候を GPU で解く。backend が無ければ CPU に落ちる。
   *
   * GPU 版は非同期にならざるを得ない（読み戻しが Promise なので）。
   * 同期版はそのまま残してあるので、テストとスクリプトは影響を受けない。
   */
  /**
   * GPU の解が信用できなかった回数。閾値を超えたら二度と GPU を使わない。
   * **物理ではなく実行環境の話**なので、決定論の対象外（表示にだけ出す）。
   */
  climateBackendFailures = 0

  async solveClimateAsync(opts?: Partial<SolveOptions>): Promise<ClimateStats> {
    if (!this.climateBackend) return this.solveClimate(opts)
    const s = await this.climateBackend.solve(this.store, this.params, this.globals)
    // ★**安全網: GPU の解が信用できなければ CPU で解き直す。**
    //
    // CPU 版の擬似時間発展には安全装置がある（残差が悪化したら差し戻して
    // 刻みを縮める、収束を判定する）。**GPU 版は反復回数を固定していて
    // それが無い**ので、冥王代のような平衡から遠い場面で別の枝に落ちる。
    // 実測（2026-08-31）: ブラウザで温度が上限の 500℃ に張り付いた。
    // CPU 版は同じ設定・同じ格子で 200Myr 安定だった。
    //
    // ここで拾えば、**どちらのバックエンドでも惑星は壊れない**。
    if (s.clampedCells > 0 || !s.converged || !Number.isFinite(s.meanT)
      || Math.abs(s.imbalance) > 1) {
      this.climateBackendFailures++
      // 何度も外すなら、その環境では GPU を使う意味が無い
      if (this.climateBackendFailures >= 8) this.climateBackend = null
      return this.solveClimate(opts)
    }
    return this.afterClimate(s)
  }

  /** 気候を解いた後の共通処理: 統計の保存と寄与台帳への記録 */
  private afterClimate(s: ClimateStats): ClimateStats {
    this.stats = s
    const snap = snapshotClimate(s.meanT, s.radiative)
    if (this.prevSnapshot) {
      recordClimateContributions(this.ledger, this.prevSnapshot, snap, this.params.B)
    }
    this.prevSnapshot = snap
    return s
  }

  /**
   * 時間を進める。
   *
   * 1. サブシステム（炭素循環など）を時間積分する
   * 2. 新しい大気組成で気候を平衡まで解き直す
   * 3. 台帳を確定する
   *
   * 気候を後に置くのは、気候が【準静的】だから（docs/01-3.5）。
   * 炭素の応答時定数 20 万年に対し、気候は 100 年で平衡に達する。
   */
  advance(years: number, opts?: Partial<SolveOptions>): StepReport {
    // 実際に観測された変化はティック全体で取る。
    // サブステップごとに observed を置くと、最後のサブステップ分しか残らず
    // 残差が巨大な disequilibrium として出てしまう（実際にこれを踏んだ）。
    const co2Before = this.globals.co2
    // 気候と炭素の結合間隔に上限を切る（CLIMATE_COUPLING_YEARS 参照）。
    // 呼び出し側の刻みが結果を変えないようにするため。
    const report = this.chunked(years, opts)
    this.lastStep = report
    this.finishTick(co2Before)
    return report
  }

  /** 結合間隔の上限ごとに区切って進める。気候は区切りごとに解き直す。 */
  private chunked(years: number, opts?: Partial<SolveOptions>): StepReport {
    let advanced = 0, substeps = 0, throttled = false
    const fired: Record<string, number> = {}
    let remaining = years
    let guard = 0
    while (remaining > 1 && guard++ < 4096) {
      const q = Math.min(this.climateCouplingYears, remaining)
      // エアロゾルは指数的に減衰する（成層圏の滞留時間は数年）
      this.decayAerosol(q)
      const r = this.loop.advance(this, q)
      advanced += r.yearsAdvanced
      substeps += r.substeps
      throttled = throttled || r.throttled
      for (const k of Object.keys(r.fired)) fired[k] = (fired[k] ?? 0) + r.fired[k]
      if (this.evolvingSun) this.applySun()
      this.relaxCcn(q)
      this.solveClimate(opts)
      if (r.yearsAdvanced <= 0) break
      remaining -= r.yearsAdvanced
    }
    if (advanced === 0) {
      // 要求が小さすぎて何も進まなかった場合も気候だけは更新する
      this.decayAerosol(years)
      if (this.evolvingSun) this.applySun()
      this.relaxCcn(years)
      this.solveClimate(opts)
    }
    return { yearsAdvanced: advanced, yearsRequested: years, substeps, throttled, fired }
  }

  /**
   * advance と同じだが、気候を GPU バックエンドで解く。
   * backend が無ければ同期版と全く同じ結果になる。
   */
  async advanceAsync(years: number, opts?: Partial<SolveOptions>): Promise<StepReport> {
    const co2Before = this.globals.co2
    this.decayAerosol(years)
    const report = this.loop.advance(this, years)
    this.lastStep = report
    if (this.evolvingSun) this.applySun()
    this.relaxCcn(years)
    await this.solveClimateAsync(opts)
    this.finishTick(co2Before)
    return report
  }

  /**
   * 実効の太陽定数を計算し直す（docs/01-2.4）。
   *
   * 主系列星は水素が減るにつれて明るくなる。45 億年で 1.4 倍。
   * 冥王代は現在の 72%（974 W/m²）で、これが「暗い太陽のパラドクス」の出発点。
   *
   * `evolvingSun` が false の世界（較正の基準状態）では基準を 1361 に固定する。
   * その場合スクリプトやテストが `solarConstant` を直接触るので、
   * advance からは呼ばない（上書きしてしまうため）。
   */
  applySun(): void {
    const base = this.evolvingSun ? solarConstantForElapsed(this.globals.yearsElapsed) : 1361
    this.globals.solarConstant = base * this.globals.solarMultiplier
    // CH4 は O2 が決める（光化学）。`state.ts` の `ch4FromOxygen` を読むこと。
    // **これが無いと CH4 が初期値のまま 45 億年固定される。** CO2 だけが
    // 落ちるので CH4/CO2 比が上がり、有機ヘイズが太古代ではなく顕生代に点灯した
    if (this.params.ch4FromOxygen > 0) {
      this.globals.ch4 = ch4FromOxygen(this.params, this.globals.o2,
        this.globals.biosphereProxy, this.globals.co2)
    }
  }

  /**
   * 生物起源の CCN によるアルベドのずれを、目標へ緩和する。
   *
   * ★**気候の刻みごとに呼ぶこと。** 目標（`ccnAlbedoTarget`）は生命が
   * 100 万年ごとに更新するので、そのまま使うと**階段状に飛ぶ**。
   * 対話中の気候ソルバは Newton を 8 回で打ち切っているので飛びを吸収できず、
   * **太古代の残差が 4.3 W/m² になった**（他の時代の 770 倍。2026-09-02 の実測）。
   *
   * 物理的にもこちらが正しい ——
   * 生物圏が 100 万年で瞬間的に入れ替わるわけではない。
   */
  relaxCcn(years: number): void {
    const g = this.globals
    const tau = this.life.params.ccnRelaxYears
    if (!(tau > 0)) { g.ccnAlbedoShift = g.ccnAlbedoTarget; return }
    const k = 1 - Math.exp(-years / tau)
    g.ccnAlbedoShift += (g.ccnAlbedoTarget - g.ccnAlbedoShift) * k
  }

  /**
   * 氷期の出入りをタイムラインに刻む。
   *
   * ★**「45 億年を眺めて面白いか」は、出来事がどれだけ刻まれるかで決まる。**
   * 実測（2026-09-01・全史・seed audit）で出来事は **31 件しかなく**、
   * 中盤は 0.5Gyr に 1 件、間隔の最大は 646Myr（×20 で 5 分の無音）だった。
   * 惑星では氷期が何度も来ているのに**報告していなかった**。
   *
   * 閾値は実測の分布から決める（氷の P5 0.045 / 中央 0.245 / P95 0.453）。
   * ヒステリシスを付けて、閾値付近の振動で連発しないようにする。
   */
  private lastEpochId = ""
  private glaciationState = 0
  /** 変わろうとしている状態と、そうなった年（続いて初めて刻む） */
  private glaciationPending = 0
  private glaciationPendingSince = 0   // 0=未判定 1=氷期 -1=温暖期
  /**
   * 時代の変わり目をタイムラインに刻む。
   *
   * ★**地質年代の境界そのものが出来事**。出来事が薄いことへの答えの 1 つで、
   * しかも**必ず 4 回起きる**ので、どの惑星でも骨組みになる。
   */
  private detectEpoch(): void {
    const now = this.epoch.id
    if (this.lastEpochId === "") { this.lastEpochId = now; return }
    if (now === this.lastEpochId) return
    this.lastEpochId = now
    this.events.push({
      year: this.globals.yearsElapsed, kind: "milestone",
      code: `epoch-${now}`,
      text: `${this.epoch.label}に入った（平均 ${this.stats!.meanT.toFixed(1)}℃・` +
        `CO₂ ${this.globals.co2.toFixed(0)}ppm）`,
    })
  }

  private detectGlaciation(): void {
    // 海が無ければ氷も無い（マグマオーシャン期）
    if (this.globals.oceanWaterFraction < 0.05) {
      this.glaciationState = 0
      this.glaciationPending = 0
      return
    }
    const ice = this.stats?.iceFraction ?? 0
    // 閾値の判定（ヒステリシス: 0.36 で入り、0.16 で明ける）
    let raw = this.glaciationState
    if (this.glaciationState === 0) raw = ice > 0.40 ? 1 : -1
    else if (this.glaciationState < 0 && ice > 0.36) raw = 1
    else if (this.glaciationState > 0 && ice < 0.16) raw = -1
    if (raw === this.glaciationState) { this.glaciationPending = 0; return }

    // ★★**状態が続いて初めて出来事にする。**
    //
    // ヒステリシスだけでは足りなかった。実測（2026-09-02・seed audit・全史）で
    // **1100〜1300Myr に閾値の跨ぎが 118 回**あり、全出来事 192 件のうち
    // 133 件がこの区間に集中していた。中身は**約 4Myr 周期の極限周期**:
    //
    //   氷 0.358 / -3.8℃ → 0.4Myr 後に 氷 0.173 / +5.5℃ → また戻る
    //   その間 CO2 は 17,400〜20,500（18%）しか動いていない
    //
    // ★**モデルとしては正しい。** 氷アルベドの分岐（`docs/01`）の双安定領域に
    // 系が乗っていて、炭素循環がわずかに押すたびに枝を飛び移っている。
    // ただし**毎ステップ平衡を解いている**ので、実際には数万年かけて進む
    // 氷床の前進・後退が一瞬の切り替えに見える。
    //
    // ★**地質学でいう氷期は数千万年〜数億年続くもの**で、ヒューロニアン氷期は
    // 約 3 億年、その中に何度も前進と後退がある。**数百万年の往復を
    // 1 件ずつ報告するのが誤り**なので、状態が `GLACIATION_HOLD_YEARS`
    // 続いて初めて刻む。
    const now = this.globals.yearsElapsed
    if (this.glaciationPending !== raw) {
      this.glaciationPending = raw
      this.glaciationPendingSince = now
      return
    }
    if (now - this.glaciationPendingSince < GLACIATION_HOLD_YEARS) return

    this.glaciationState = raw
    this.glaciationPending = 0
    this.events.push(raw > 0 ? {
      year: now, kind: "milestone", code: "ev-icehouse",
      text: `氷期に入った（氷 ${(ice * 100).toFixed(0)}%・平均 ${this.stats!.meanT.toFixed(1)}℃）`,
    } : {
      year: now, kind: "milestone", code: "ev-greenhouse",
      text: `氷期が明けた（氷 ${(ice * 100).toFixed(0)}%・平均 ${this.stats!.meanT.toFixed(1)}℃）`,
    })
  }

  /**
   * 海進・海退をタイムラインに刻む。
   *
   * 大陸に海が乗る／引くのは地質学的に大きな出来事（浅海の生息域が
   * 現れたり消えたりする）。**しかも海面は連続的に動くので、
   * 何も起きない時代の空白を埋めるのに向いている。**
   * 閾値は実測の分布から（海面 P25 -1365m / 中央 -927m / P75 -486m）。
   */
  private seaState = 0

  /**
   * ★**セーブ用。** 出来事の検出はどれも「前回どうだったか」を持っている。
   * これを落とすと、復元した直後に**同じ出来事がもう一度出る**
   * （氷期・海進・時代の変わり目）。
   */
  snapshot(): Record<string, unknown> {
    return {
      stats: this.stats,
      evolvingSun: this.evolvingSun,
      climateCouplingYears: this.climateCouplingYears,
      // ★サブシステムの端数の持ち越し。**「いつ発火するか」そのもの**
      loop: this.loop.snapshot(),
      lastEpochId: this.lastEpochId,
      glaciationState: this.glaciationState,
      glaciationPending: this.glaciationPending,
      glaciationPendingSince: this.glaciationPendingSince,
      seaState: this.seaState,
    }
  }

  restore(v: Record<string, unknown>): void {
    const g = v as {
      stats: ClimateStats | null; evolvingSun: boolean; climateCouplingYears: number
      loop: Record<string, number>
      lastEpochId: string; glaciationState: number
      glaciationPending: number; glaciationPendingSince: number; seaState: number
    }
    this.stats = g.stats
    this.evolvingSun = g.evolvingSun
    this.climateCouplingYears = g.climateCouplingYears
    this.loop.restore(g.loop)
    this.lastEpochId = g.lastEpochId
    this.glaciationState = g.glaciationState
    this.glaciationPending = g.glaciationPending
    this.glaciationPendingSince = g.glaciationPendingSince
    this.seaState = g.seaState
  }
  private detectSeaLevel(): void {
    // ★**液体の海が無いときに「海進・海退」と言ってはいけない。**
    // マグマオーシャン期は海面が -5069m になるので、門が無いと
    // 開始直後に「海退」が出る（2026-09-01 の smoke で発覚）
    if (this.globals.oceanWaterFraction < 0.05) { this.seaState = 0; return }
    const s = this.globals.seaLevel
    if (this.seaState === 0) { this.seaState = s > -900 ? 1 : -1; return }
    if (this.seaState < 0 && s > -520) {
      this.seaState = 1
      this.events.push({
        year: this.globals.yearsElapsed, kind: "milestone", code: "ev-transgression",
        text: `海進: 海面が ${s.toFixed(0)}m まで上がり、大陸の縁が浅海になった`,
      })
    } else if (this.seaState > 0 && s < -1330) {
      this.seaState = -1
      this.events.push({
        year: this.globals.yearsElapsed, kind: "milestone", code: "ev-regression",
        text: `海退: 海面が ${s.toFixed(0)}m まで下がり、大陸棚が陸になった`,
      })
    }
  }

  private finishTick(co2Before: number): void {
    this.detectEpoch()
    this.detectGlaciation()
    this.detectSeaLevel()
    this.ledger.observed("co2", this.globals.co2 - co2Before)
    this.ledger.commit(this.globals.yearsElapsed)
  }

  private decayAerosol(years: number): void {
    if (this.globals.aerosolForcing > 1e-6) {
      this.globals.aerosolForcing *= Math.exp(-years / this.globals.aerosolDecayYears)
      if (this.globals.aerosolForcing < 1e-6) {
        this.globals.aerosolForcing = 0
        this.globals.aerosolDecayYears = 2
      }
    }
  }

  /**
   * 介入。docs/03-2.2 の介入カタログ。
   * フェーズ1 では Ω 経済（M7）がまだ無いので、コストなしで直接効かせる。
   */
  /**
   * プレイヤーの介入。
   *
   * ★**`cell` が来たら「そこ」に効かせる**（`docs/03-2.2`）。
   * 全球にしか効かない介入は「惑星をいじっている」感じがしない。
   * 大気（CO₂・エアロゾル）は混ざるので全球のまま、
   * 地殻に対する作用（洪水玄武岩・掘削・造山・プレート）は局所に効く。
   *
   * `cell` を省いたときの挙動は従来どおり（テストと監査が使う）。
   */
  intervene(kind: string, magnitude = 1, cell?: number, geneKind?: number): void {
    const n = this.grid.cellCount
    const c = cell !== undefined && cell >= 0 && cell < n ? cell : undefined
    const where = c === undefined ? "" : `・${this.placeLabel(c)}`
    switch (kind) {
      case "volcano": {
        // 巨大噴火。CO2 と成層圏エアロゾルの両方を出す。
        const co2 = 120 * magnitude
        this.globals.co2 += co2
        this.globals.aerosolForcing += 6 * magnitude
        this.ledger.add("co2", co2, "volcanism.hotspot")
        const km3 = c === undefined ? 0 : this.tectonics.eruptAt(this, c, magnitude)
        this.events.push({
          year: this.globals.yearsElapsed, kind: "milestone", code: "ev-lip",
          text: `介入: 巨大噴火${where}（CO₂ +${co2.toFixed(0)} ppm` +
            (km3 > 0 ? `、玄武岩 ${(km3 / 1e6).toFixed(2)}e6 km³` : "") +
            `、エアロゾル −${(6 * magnitude).toFixed(0)} W/m²（数年で消える））`,
        })
        break
      }
      case "impact": {
        // 隕石衝突。ダストによる強い短期の寒冷化。
        this.globals.aerosolForcing += 40 * magnitude
        this.globals.aerosolDecayYears = 6
        this.globals.co2 += 40 * magnitude
        const km3 = c === undefined ? 0 : this.tectonics.craterAt(this, c, magnitude)
        this.events.push({
          year: this.globals.yearsElapsed, kind: "impact", code: "ev-impact",
          text: `介入: 隕石衝突${where}（ダスト冬 −${(40 * magnitude).toFixed(0)} W/m²・6 年` +
            (km3 > 0 ? `、掘削 ${(km3 / 1e3).toFixed(0)}e3 km³` : "") + `）`,
        })
        break
      }
      case "plateNudge": {
        // プレートに力を加える。超大陸を割る／集める向きを変える。
        const pid = c === undefined ? -1 : this.tectonics.nudgePlateAt(this, c, magnitude)
        if (pid < 0) this.tectonics.nudgePlates(magnitude)
        this.events.push({
          year: this.globals.yearsElapsed, kind: "tectonicMode", code: "ev-tectonic-mode",
          text: pid < 0
            ? `介入: すべてのプレートに力を加えた`
            : `介入: プレート ${pid} に力を加えた${where}`,
        })
        break
      }
      // --- 神の手（生命への介入。`docs/03-2.2`）---
      //
      // ★**能力を与えるのではなく勾配を傾ける。** 巨大噴火が CO₂ を足すのであって
      // 気温を決めないのと同じ作法。押しても不利なら選択が戻すので、
      // **効いたかどうかが後から分かる**。
      case "nudgeTrait": {
        if (c === undefined || geneKind === undefined) break
        const id = this.life.nudgeTrait(this, c, geneKind, 60 * magnitude)
        this.events.push({
          year: this.globals.yearsElapsed, kind: "milestone", code: "ev-speciation",
          text: id < 0
            ? `介入: 傾向を押そうとしたが、そこに生命がいない${where}`
            : `介入: クレード ${id} の ${GENE_KINDS[geneKind]} を押した${where}`,
        })
        break
      }
      case "injectGene": {
        if (c === undefined || geneKind === undefined) break
        const id = this.life.injectGene(this, c, geneKind, 200 * magnitude)
        this.events.push({
          year: this.globals.yearsElapsed, kind: "milestone", code: "ev-origin",
          text: id < 0
            ? `介入: 遺伝子を投入しようとしたが、そこに生命がいない${where}`
            : `介入: クレード ${id} に ${GENE_KINDS[geneKind]} を投入した${where}`,
        })
        break
      }
      case "transferGenes": {
        if (c === undefined) break
        const [src, dst, moved] = this.life.transferGenes(this, c, 2)
        this.events.push({
          year: this.globals.yearsElapsed, kind: "milestone", code: "ev-speciation",
          text: moved > 0
            ? `介入: 水平伝播 クレード ${src} → ${dst}（遺伝子 ${moved} 個）${where}`
            : src < 0
              ? `介入: 水平伝播できなかった${where}（同じマスに 2 系統いない）`
              : `介入: 水平伝播できなかった${where}（渡せる遺伝子が無い）`,
        })
        break
      }
      case "uplift": {
        // 造山を促す。サーモスタットを直す唯一の梃子（docs/01-6.6c）
        if (c === undefined) {
          this.carbon.params.erosionFactor =
            Math.min(4, this.carbon.params.erosionFactor * (1 + 0.5 * magnitude))
          this.events.push({
            year: this.globals.yearsElapsed, kind: "milestone", code: "ev-tectonic-mode",
            text: `介入: 造山を促した（侵食 ${this.carbon.params.erosionFactor.toFixed(2)}倍）`,
          })
        } else {
          const km3 = this.tectonics.upliftAt(this, c, magnitude)
          this.events.push({
            year: this.globals.yearsElapsed, kind: "milestone", code: "ev-tectonic-mode",
            text: km3 > 0
              ? `介入: 地殻を寄せた${where}（${(km3 / 1e3).toFixed(0)}e3 km³ を中心へ）`
              : `介入: 地殻を寄せられなかった${where}（周りに厚い地殻が無い）`,
          })
        }
        break
      }
    }
  }

  /** セル番号を「緯度 経度」の読める形にする（出来事の本文に入れる） */
  private placeLabel(c: number): string {
    const W = this.grid.W
    const y = (c / W) | 0, x = c - y * W
    const lat = this.grid.latDeg[y]
    const lon = ((x + 0.5) / W) * 360 - 180
    const ns = lat >= 0 ? "N" : "S"
    const ew = lon >= 0 ? "E" : "W"
    return `${Math.abs(lat).toFixed(0)}°${ns} ${Math.abs(lon).toFixed(0)}°${ew}`
  }

  /** 時間を進めずに気候だけ解き直す（介入直後など） */
  refresh(opts?: Partial<SolveOptions>): ClimateStats {
    const s = this.solveClimate(opts)
    this.ledger.commit(this.globals.yearsElapsed)
    return s
  }

  /** refresh の GPU 版 */
  async refreshAsync(opts?: Partial<SolveOptions>): Promise<ClimateStats> {
    const s = await this.solveClimateAsync(opts)
    this.ledger.commit(this.globals.yearsElapsed)
    return s
  }
}

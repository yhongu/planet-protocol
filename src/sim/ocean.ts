/**
 * 海洋循環。docs/01-6.7。
 *
 * 海洋循環の調整時間は約 1000 年で、本作のタイムスケール（10⁵〜10⁹ 年）から
 * 見れば気候と同じく【準静的】である。時間積分ではなく平衡解を解く。
 * 1 セル 300km 級では中規模渦も解けないので 3D GCM は過剰かつ無意味。
 *
 * 3 つの部品:
 *   (c) 海底熱水   … 既存の `divergence` から導く。新しい計算はほぼ要らない
 *   (b) 熱塩循環   … Stommel 1961 の 2 箱。**ヒステリシスを持つ**
 *   (a) 風成循環   … スヴェルドラップ平衡。気候ソルバの PCG を流用する
 *
 * ★M5（生命）がこれらを使う。一次生産の分布は湧昇が、海洋無酸素事変は
 * 熱塩循環の停止が、生命の起源地は熱水噴出孔が決める。
 */

import type { FieldSpec } from "../core/fields"
import type { World } from "./world"
import { Tectonics } from "./tectonics"
import type { Subsystem } from "./loop"
import { EARTH_RADIUS_M } from "../core/grid"

/** 地球の表面積 [m²]。面積重みは総和 1 に正規化してあるので換算に要る */
const EARTH_SURFACE_M2 = 4 * Math.PI * EARTH_RADIUS_M * EARTH_RADIUS_M

export const OCEAN_FIELDS: readonly FieldSpec[] = [
  {
    name: "ventFlux", kind: "f32", doubleBuffered: false,
    comment: "W/m²。海嶺の熱水フラックス（新生海洋地殻の冷却で運ばれる熱）",
  },
  {
    name: "upwelling", kind: "f32", doubleBuffered: false,
    comment: "m/yr。エクマン湧昇（正 = 湧昇、負 = 沈降）",
  },
  {
    name: "oceanU", kind: "f32", doubleBuffered: false,
    comment: "m/yr。東向きの水平流速（深さ平均）",
  },
  {
    name: "oceanV", kind: "f32", doubleBuffered: false,
    comment: "m/yr。北向きの水平流速（深さ平均）",
  },
  {
    name: "phosphateSupply", kind: "f32", doubleBuffered: false,
    comment: "mol-P/m²/yr。表層へのリンの供給（湧昇 × 深層濃度 + 河川）",
  },
  {
    name: "dic", kind: "f32", doubleBuffered: false,
    comment: "mol-C/m³。表層の溶存無機炭素（大気と平衡・溶解ポンプ）",
  },
]

/** 熱塩循環の枝。ヒステリシスがあるので【どちらに居るか】が状態になる */
export type ThermohalineMode = "thermal" | "haline" | "off"

/** ユリウス年の秒数。年 <-> 秒の換算はここに一本化する */
export const SEC_PER_YEAR = 3.15576e7

/**
 * 現在の地球で【深層に届く】有機炭素のフラックス [mol-C/m²/yr]。
 * 1.5 Gt-C/yr を海の面積 3.6e14 m² で割った値。
 * 生命がいないので既定では使わないが、テストと M5 の目安になる。
 * この値で深層酸素が 0.16 mol/m³ になり、観測（約 0.15）に一致する。
 */
export const MODERN_DEEP_CARBON_FLUX = 0.35

export interface OceanParams {
  /**
   * 海嶺で作られる海洋地殻の厚さ [km]。
   *
   * 地球ではほぼ一定の 7±1 km。マントルの部分溶融量で決まり、
   * 拡大速度にはほとんど依らない。**場の crustThickness を使ってはいけない**——
   * あちらは水深を表すために薄くしてあり（`initCrustFromTerrain`）、
   * 海嶺で生産されるマグマの厚さではない。
   */
  oceanCrustThicknessKm: number
  /**
   * 新生海洋地殻 1 m³ が海水に渡しうる熱 [J/m³]。
   *
   *   ρ(2900) × [ c_p(1000) × ΔT(1200K) + 潜熱(4e5) ] = 4.6e9 J/m³
   *
   * 地球の地殻生産 20 km³/yr（3.4 km²/yr × 6km）に掛けると 2.9 TW。
   * 観測される軸部の熱水熱流量 2.8±1 TW（Elderfield & Schultz 1996）と
   * 一致する。**つまりマグマの熱はほぼ全部が熱水として出ている**ので、
   * ここに追加の分配係数は要らない。
   */
  crustEnthalpy: number
  /**
   * 熱水が海水に渡る割合。1.0 = マグマの熱が全部熱水になる。
   * 上のとおり地球では 1.0 でよい。診断のために露出しておく。
   */
  /**
   * 脱ガスの正規化に使う海洋地殻の生産量で、**海洋の面積を割合で数える**。
   * 0 なら従来（セル平均の珪長質を 0.5 で切る真偽値）。
   *
   * `fel` は【割合】なので、閾値で切ると格子を細かくするほどセルが純粋になり、
   * 海洋と判定される面積が系統的に増える。実測（seed audit・40x800kyr）で
   * 96x48 対 144x72 の生産量が +15%、それが脱ガスに乗って
   * **CO2 の解像度差が 0.44**（上限 0.2）になっていた。
   * `climate.ts` の `albedoPass` と同じ欠陥（`CLAUDE.md` の 21）。
   */
  ventOceanicFraction: number
  hydrothermalFraction: number

  // --- (b) 熱塩循環（Stommel 1961 の 2 箱） ---
  /**
   * 低緯度箱と高緯度箱の境目 [deg]。地球の亜熱帯収束はおよそ 40〜45 度。
   * 南北両半球をまとめて 1 つの高緯度箱として扱う（|lat| で切る）。
   */
  latSplitDeg: number
  /** 海水の熱膨張係数 [1/K] */
  alphaT: number
  /** 海水の塩分収縮係数 [1/psu] */
  betaS: number
  /** 基準塩分 [psu] */
  refSalinity: number
  /** 現在の地球の海水の総体積 [m³]。oceanWaterFraction で比例させる */
  oceanVolume: number
  /**
   * 流量係数 [m³/s]。q = k·(αΔT − βΔS)。**recalibrate が上書きする。**
   * ここの既定値は較正が走らなかった場合の保険にすぎない。
   */
  hydraulicK: number
  /**
   * 高緯度箱に入った淡水のうち、**転覆流が運び出さなければならない割合**。
   * **recalibrate が上書きする。**
   *
   * 場から診断できるのは「高緯度の正味の淡水流入」だけだが、その全部が
   * 熱塩循環で戻るわけではない。実際には風成の環流（(a) で入れる）が
   * かなりの部分を運ぶ。2 箱モデルには環流が無いので、全部を転覆流に
   * 背負わせると塩分差が過大になり、**現在の地球が塩分枝に落ちる**
   * （実測: ΔS が 6.8 psu になり q が −13.8 Sv に反転した）。
   */
  freshwaterEfficiency: number
  /**
   * 箱の温度が大気の平衡値に緩和する時定数 [yr]。
   *
   * 混合層だけなら数十年だが、ここでの箱は全層なので実効的にはもっと長い。
   * 100 年にすると現在の地球で ΔT が大気の ΔT* の 78% になる。
   */
  tempRelaxYears: number
  /**
   * 較正の目標: 現在の地球の全球深層水形成量 [Sv]。
   * NADW 約 15 + AABW 約 15。**AMOC だけの 15 ではない**——
   * ここの箱は全球なので、南極底層水も含めた 30 が対応する量。
   */
  targetOverturningSv: number
  /**
   * 較正の目標: 現在の地球の低緯度 − 高緯度の表層塩分差 [psu]。
   * 熱帯 36.5 に対し高緯度 34.9 前後。
   */
  targetDeltaS: number
  /**
   * 高緯度箱への淡水流入の外部異常 [Sv]。既定 0。
   *
   * **ヒステリシスを測る唯一のつまみ。** 正で高緯度を淡水化し、
   * 熱塩循環を止める向きに効く。介入（氷床融解）とテストが使う。
   */
  freshwaterAnomalySv: number
  /** 熱塩循環の積分の内部刻み [yr]。準静的なので平衡まで回す */
  thermohalineSubstepYears: number
  /** 内部反復の上限。これに当たるのは異常なので diag に出す */
  thermohalineMaxIters: number

  // --- (a) 風成循環（スヴェルドラップ平衡） ---
  /**
   * 帯状の風応力の振幅 [N/m²]。貿易風と偏西風のピーク値。
   * 地球では 0.05〜0.2 N/m²。
   */
  windStress: number
  /**
   * 東岸（＝大陸の西海岸）に沿う赤道向きの風応力 [N/m²]。
   *
   * **3 セル循環は東西一様なので、この風は原理的に出てこない。**
   * 実際には亜熱帯高気圧が海盆の上に居座り、その東の縁——つまり海盆の
   * 東岸——で赤道向きの風が吹く。これがカリフォルニア・ペルー・ベンゲラ・
   * カナリアの湧昇を作り、**外洋の一次生産の大半を担っている**。
   * 陸海コントラストの効果としてパラメタライズする
   * （水循環が水蒸気移流をパラメタライズしているのと同じ扱い）。
   */
  coastalWindStress: number
  /** 東岸風の海側への減衰長 [km]。亜熱帯高気圧の東縁の幅 */
  coastalWindDecayKm: number
  /** 東岸風が最も強い緯度 [deg] と幅 [deg]。亜熱帯高気圧の位置 */
  coastalWindLatDeg: number
  coastalWindLatWidth: number
  /**
   * コリオリ因子の下限を決める緯度 [deg]。
   *
   * エクマン輸送は 1/f を含むので赤道で発散する。1/f -> f/(f²+f_min²) と
   * 正則化し、その f_min をこの緯度で決める（南北輸送のピークがこの緯度に来る）。
   *
   * **物理的には 2〜5 度**（赤道波導の幅）だが、1 セルが 3.75 度（96x48）の
   * 格子ではピークが 1 セルに収まらず、**行の当たり方で全球の総湧昇が
   * 10% 動く**（実測 96→256 で 306→350 Sv）。ピークを 2 セル以上に広げると
   * 96x48 以上で総量が揃う（同 221→230 Sv、ばらつき 4%）。
   *
   * つまりこれは「この解像度で赤道帯をどれだけ塗るか」の値である。
   * 格子を 512x256 まで上げるとき（docs/05 M8）は下げ直すこと。
   */
  minCoriolisLatDeg: number
  /**
   * スヴェルドラップ平衡を信じる緯度の上限 [deg]。ここから外は 0 へ落とす。
   *
   * β = 2Ω cosφ/R は極でゼロになるので V = curl(τ)/(ρβ) が発散する。
   * 実測: 上限を置かないと 85 度の行が 250 Sv を叩き出し、
   * **環流の強さが極の数値発散で決まってしまう**（しかも解像度依存）。
   * 実際の極域の循環はスヴェルドラップ平衡ではなく、境界流と対流が決める。
   */
  sverdrupMaxLatDeg: number
  /** 上限の手前で滑らかに落とす幅 [deg] */
  sverdrupTaperDeg: number
  /** 海水の密度 [kg/m³] */
  waterDensity: number
  /** 速度に直すときの最小水深 [m]。大陸棚で発散させないため */
  minDepthM: number

  // --- リンと酸素（M5 生命の土台。docs/01-3.3, docs/01-4.6） ---
  /**
   * 現在の地球の、河川からの反応性リンの供給量 [mol-P/yr]。
   * 観測は 0.1〜0.3 Tmol/yr。その下限を採る。
   */
  phosphateInputRef: number
  /**
   * 海洋のリンの滞留時間 [yr]。埋没で失われるまでの時間。
   * 観測は 2〜10 万年。3 万年にすると現在の在庫が
   * 1e11 × 3e4 = 3e15 mol となり、観測（2.9e15 mol）に一致する。
   */
  phosphateResidenceYears: number
  /**
   * **深層へ入る**有機炭素のフラックス [mol-C/m²/yr]。深層の酸素を食う量。
   *
   * 【輸出生産そのものではない】。水深 100m の輸出生産は現在の地球で
   * 10 Gt-C/yr（2.3 mol/m²/yr）だが、その大半は上部 1000m で呼吸されて
   * 表層に戻る。深層（1000m 以深）に届くのは 1〜2 Gt-C/yr で、
   * 面積で割ると約 0.35（`MODERN_DEEP_CARBON_FLUX`）。
   * ここに 2.3 を入れると現在の地球が全球無酸素になる（実際にやった）。
   *
   * **既定は 0。生命がいないので有機物が沈まない。** これは正しい——
   * 生命のいない海の深層は酸素で飽和する。**M5 の生命がここを上書きする。**
   */
  deepCarbonFlux: number
  /** 有機物の呼吸に要る O2 と C の比。レッドフィールド比では約 1.4 */
  o2PerCarbon: number
  /** 深層が占める体積の割合。表層混合層は薄いのでほぼ全部 */
  deepVolumeFraction: number
  /** 低酸素とみなす閾値 [mol-O2/m³]。60 μmol/kg 相当 */
  hypoxicThreshold: number

  // --- 海洋炭素（DIC） ---
  /**
   * 現在の地球の平均 DIC [mol-C/m³]。2.3 mmol/kg × 1.027 = 2.36。
   * 総量 2.36 × 1.335e18 = 3.15e18 mol = 37,800 Gt-C（大気の 64 倍）。
   */
  dicRef: number
  /**
   * レヴェル因子。DIC が pCO2 に応じてどれだけ動くかを決める緩衝係数。
   *   d(DIC)/DIC = (1/R)·d(pCO2)/pCO2
   * 観測は 8〜15（高 CO2 ほど大きい＝緩衝が効かない）。
   * ここでは **carbon.ts の Meff = 21 Gt-C/ppm と整合する値**を採る:
   *   Meff = 2.12 + DIC[Gt-C]/(R·pCO2) = 2.12 + 37800/(280R) = 21  ->  R = 7.2
   */
  revelleFactor: number
  /** 溶解ポンプの温度依存 [1/K]。冷たい水ほど DIC が高い（表層で ±10%） */
  dicTempSensitivity: number
}

export const EARTH_OCEAN: OceanParams = {
  oceanCrustThicknessKm: 7,
  crustEnthalpy: 2900 * (1000 * 1200 + 4e5),
  hydrothermalFraction: 1,
  ventOceanicFraction: 2,

  latSplitDeg: 45,
  alphaT: 1.7e-4,
  betaS: 7.6e-4,
  refSalinity: 35,
  oceanVolume: 1.335e18,
  hydraulicK: 1.7e10,
  freshwaterEfficiency: 0.5,
  tempRelaxYears: 100,
  targetOverturningSv: 30,
  targetDeltaS: 1.6,
  freshwaterAnomalySv: 0,
  thermohalineSubstepYears: 25,
  thermohalineMaxIters: 8000,

  windStress: 0.1,
  coastalWindStress: 0.06,
  coastalWindDecayKm: 800,
  coastalWindLatDeg: 25,
  coastalWindLatWidth: 20,
  minCoriolisLatDeg: 8,
  sverdrupMaxLatDeg: 72,
  sverdrupTaperDeg: 12,
  waterDensity: 1027,
  minDepthM: 200,

  phosphateInputRef: 1e11,
  phosphateResidenceYears: 30_000,
  deepCarbonFlux: 0,
  o2PerCarbon: 1.4,
  deepVolumeFraction: 0.9,
  hypoxicThreshold: 0.06,

  dicRef: 2.36,
  revelleFactor: 7.2,
  dicTempSensitivity: 0.004,
}

/** 海洋の全球スカラー。台帳と UI が読む */
export interface OceanState {
  /** 熱水の総熱流量 [W]。現在の地球は約 2.9e12（2.9 TW） */
  ventPower: number
  /**
   * 熱水が出ている海底の【有効】面積率 [0..1]。
   *
   * 単純に「フラックス > 0 のセル」を数えてはいけない。剛体回転の発散は
   * 中心差分の丸め誤差でプレート内部にも微小な正値を残すので、
   * 海底の 36% が「熱水域」になってしまう（実測）。
   *
   * 逆シンプソン（有効陸塊数と同じ流儀。docs/01-6.5c）で強度重みを付ける:
   *   有効面積 = (Σ f·A)² / Σ f²·A
   * 弱い裾は f² が効かないのでほとんど数えない。
   *
   * **これは解像度独立ではない**（実測 64/96/128 で 8.8 / 6.9 / 5.7%）。
   * 海嶺は【線】なので、セルを細かくすれば面積は減り続けるのが正しい。
   * 物理的に不変なのは総出力 `ventPower` と生産量 `crustProduction` の方で、
   * こちらは 2.28 / 2.41 / 2.51 TW と 15.5 / 16.4 / 17.0 km³/yr に収まる。
   * 判定に使うのは総量、地図に使うのが面積、と分けること。
   */
  ventArea: number
  /** 新生海洋地殻の生産量 [km³/yr]。現在の地球は約 20 */
  crustProduction: number
  /**
   * **モデルが実際に作った**新生海洋地殻の生産量 [km³/yr]。
   *
   * `crustProduction` は `divergence` からの【見積もり】で、
   * こちらは粒子で実際に置いた量（`spreadRate` の総和）。
   * 2026-08-31 に海嶺の充填を直した結果、実測の方が解像度独立になった
   * （32Myr で 96x48 対 144x72 が **+0.03%**。見積もりは +15%）。
   * 脱ガスの正規化はこちらを使う（`carbon.ts` の `degassingFromActualCrust`）。
   */
  crustProductionActual: number

  // --- (b) 熱塩循環 ---
  /** 低緯度箱 − 高緯度箱の水温差 [K]。状態変数 */
  deltaT: number
  /** 低緯度箱 − 高緯度箱の塩分差 [psu]。状態変数 */
  deltaS: number
  /** 転覆流量 [Sv]。正 = 高緯度で沈む（熱塩枝）。現在の地球は約 15 */
  overturningSv: number
  /** 深層の換気速度。現在の地球を 1 とした相対値。無酸素事変の判定に使う */
  ventilation: number
  /** どちらの枝に居るか */
  thermohalineMode: ThermohalineMode
  /** 大気が押しつける水温差 [K]（診断） */
  deltaTAtm: number
  /** 高緯度箱への正味の淡水流入 [Sv]（診断） */
  freshwaterSv: number
  /** 内部反復が上限に当たった回数（0 でないと平衡に達していない） */
  thermohalineStalls: number

  // --- (a) 風成循環 ---
  /** 全球の湧昇の総量 [Sv]。∫max(0,w)dA。解像度独立であるべき量 */
  upwellingSv: number
  /** 全球の沈降の総量 [Sv]。湧昇と釣り合うはず（エクマン輸送は発散だから） */
  downwellingSv: number
  /** 西岸境界流の総輸送量 [Sv]。地球の湾流は約 30 Sv */
  westernBoundarySv: number
  /** 環流の最大流線関数 [Sv]。亜熱帯環流の強さ */
  gyreStrengthSv: number

  // --- リンと酸素 ---
  /** 海洋のリンの総在庫 [mol]。現在の地球は約 2.9e15 */
  phosphateInventory: number
  /** 深層のリン濃度 [mol/m³]。現在の地球は約 2.2e-3 */
  phosphateDeep: number
  /** 河川からのリンの供給 [mol/yr] */
  phosphateInput: number
  /** 埋没によるリンの損失 [mol/yr] */
  phosphateBurial: number
  /** 表層海水の酸素飽和濃度 [mol/m³]。水温と大気の pO2 で決まる */
  surfaceOxygen: number
  /** 深層の酸素濃度 [mol/m³]。換気と有機物の呼吸の差し引き */
  deepOxygen: number
  /** 深層が無酸素になっている度合い [0..1]。メデア機構の入力 */
  anoxicFraction: number
  /** 深層水の年齢 [yr]。V_deep / |q| */
  ventilationAgeYears: number

  // --- 海洋炭素 ---
  /** 海洋の溶存無機炭素の総量 [mol-C]。現在の地球は 3.15e18（大気の 64 倍） */
  dicInventory: number
  /** 表層の平均 DIC [mol-C/m³] */
  dicSurface: number
  /** 深層の DIC [mol-C/m³]。生物ポンプが無いので今は表層と同じ */
  dicDeep: number
  /**
   * この DIC から導かれる実効リザーバ [Gt-C/ppm]（診断）。
   *
   * **carbon.ts の `Meff` と比べるための量。** 一致していれば、
   * 集約された Meff と明示的な DIC が同じ緩衝を表していることになる。
   * ずれたら、どちらかが現実から外れている。
   */
  impliedMeff: number
}

export class Ocean implements Subsystem {
  readonly name = "ocean"
  /**
   * 熱水はプレート運動でしか変わらないので、テクトニクスと同じ刻みでよい。
   * 熱塩循環（(b)）は内部で平衡まで反復するので、外側の刻みには依存しない。
   */
  readonly preferredStepYears = 500_000
  readonly maxStepYears = 1e9

  params: OceanParams
  readonly state: OceanState = {
    ventPower: 0, ventArea: 0, crustProduction: 0, crustProductionActual: 0,
    // 現在の地球の値から始める。冥王代は液体の海が無いので 0 に落ちる
    deltaT: 20, deltaS: 1.5, overturningSv: 0, ventilation: 0,
    thermohalineMode: "thermal", deltaTAtm: 0, freshwaterSv: 0, thermohalineStalls: 0,
    upwellingSv: 0, downwellingSv: 0, westernBoundarySv: 0, gyreStrengthSv: 0,
    phosphateInventory: 0, phosphateDeep: 0, phosphateInput: 0, phosphateBurial: 0,
    surfaceOxygen: 0, deepOxygen: 0, anoxicFraction: 0, ventilationAgeYears: 0,
    dicInventory: 0, dicSurface: 0, dicDeep: 0, impliedMeff: 0,
  }

  /**
   * リンの収支の台帳 [mol]。監査（`npm run audit`）が閉じているか検査する。
   * **新しい保存量を足す時点で収支検査も足す**（docs/01-6.5c の約束）。
   */
  readonly phosphorusBudget = { input: 0, burial: 0, initial: 0 }

  /** 低緯度箱・高緯度箱の海面水温 [degC]。酸素の溶解度に使う */
  private boxTempL = 25
  private boxTempH = 5

  /** 作業用バッファ。ティックループ内で確保しない（docs/04-8.5 規則 7） */
  private tauX: Float32Array | null = null
  private tauY: Float32Array | null = null
  private ekX: Float32Array | null = null
  private ekY: Float32Array | null = null
  private psi: Float32Array | null = null
  private scratch: Float32Array | null = null
  private rowBuf: Float32Array | null = null

  /** 較正が済んだか。済んでいなければ既定のパラメータで回る */
  calibrated = false

  constructor(params: Partial<OceanParams> = {}) {
    this.params = { ...EARTH_OCEAN, ...params }
  }

  update(world: World, dtYears: number): void {
    this.computeVents(world)
    this.solveThermohaline(world)
    this.solveWindDriven(world)
    this.stepPhosphorus(world, dtYears)
    this.solveOxygen(world)
    this.solveCarbon(world)
  }

  /**
   * (c) 海底熱水。
   *
   * 熱水フラックス ∝ 海嶺の拡大速度（= divergence の正の部分）。
   *
   * 単位面積あたりの地殻生産 [m/yr] = div [1/yr] × 海洋地殻の厚さ [m]。
   * 剛体回転する現在の場では div は境界の 2 セル幅にしか立たないが、
   * 積分 ∫max(0,div)dA は境界の長さ × 速度に収束するので解像度に依らない
   * （probe-vent.ts で 64/96/128 の 3 解像度で確認する）。
   *
   * **液体の海が無ければ熱水は無い。** 冥王代のマグマオーシャン期は
   * 水がすべて水蒸気なので（state.ts の steamFraction）、噴出孔は存在しない。
   * 生命の起源地の判定に効くので、ここで切っておく。
   *
   * **プレートが動かない様式でも切る。** ヒートパイプ／スクイッシーリッドでは
   * 海嶺が無い（`divergence` の場は剛体回転の数値誤差として残るが、
   * 新しい海洋地殻は作られていない）。
   *
   * > ★積み残し: **プレートテクトニクス以前の海底熱水は表現していない。**
   * > 最初の海（4.49 Ga）からモバイルリッドへの遷移（約 4.17 Ga）までの
   * > 3 億年、海はあるのに噴出孔が無い状態になる。実際にはヒートパイプ期の
   * > 海底は全面的に火成活動をしていたはずで、生命の起源地の候補として
   * > むしろ有力である（docs/02-2.8）。M5 で必要になったら
   * > `internalHeatFlux` の海底分から作ること。
   */
  private computeVents(world: World): void {
    const { W, H } = world.grid
    const p = this.params
    const div = world.store.f32("divergence").read
    const thick = world.store.f32("crustThickness").read
    const fel = world.store.f32("felsic").read
    const vent = world.store.f32("ventFlux").read
    const tp = world.tectonics.params
    // 粒子表現（`crustModel`）でも `felsic` の場は意味を持つ。
    // `crustComposition` だけを見ていると、粒子なのに厚さ 10km の閾値で
    // 海洋地殻を判定してしまう
    const comp = tp.crustComposition > 0 || tp.crustModel > 0
    const cont = tp.continentThreshold
    const mobile = world.tectonicTraits.mobile
    // 海嶺が作る海洋地殻の厚さはマントル温度で決まる（減圧融解）。
    // 太古代は 2 倍以上厚いので、熱水の熱量もその分大きい
    const hKm = comp
      ? Tectonics.oceanCrustThickness(world.mantle.state.temperature)
      : p.oceanCrustThicknessKm

    // 液体の海に対して滑らかに立ち上げる（carbon.ts の風化と同じ扱い）
    const wf = world.globals.oceanWaterFraction
    const t = wf <= 0 ? 0 : wf >= 0.05 ? 1 : wf / 0.05
    const liquid = t * t * (3 - 2 * t)

    // [J/m³] × [m/yr] / [s/yr] = W/m²
    const hM = hKm * 1000
    const perDiv = p.crustEnthalpy * p.hydrothermalFraction * hM / SEC_PER_YEAR
      * liquid * (mobile ? 1 : 0)

    // 【モデルが実際に作った海洋地殻から計算する】docs/06-4.4。
    //
    // 軸部の熱水は新しい海洋地殻のエンタルピーそのものなので、
    // `divergence` の積分で別途見積もる必要はない——むしろ食い違う。
    // 実測（2026-08-29）: 海嶺の充填を面積判定に直して生成が
    // 3.6 → 25 km³/yr になったのに、div から見積もる旧実装は
    // 0.13 → 0.10 TW と【下がった】。作った量を見ていなかった。
    const spr = world.tectonics.spreadRate
    const useSpread = spr !== null && tp.crustModel > 0
      && world.tectonics.spreadRateValid
    // [J/m³] × [km³/yr] → W。1 km³ = 1e9 m³
    const perVol = p.crustEnthalpy * p.hydrothermalFraction * 1e9 / SEC_PER_YEAR
      * liquid * (mobile ? 1 : 0)

    let power = 0, sq = 0, prod = 0, prodActual = 0
    for (let y = 0; y < H; y++) {
      const cellM2 = world.grid.cellArea[y]
      const aw = world.grid.areaWeight[y]
      const row = y * W
      for (let x = 0; x < W; x++) {
        const i = row + x
        // 【生産量は発散から見積もる方を state に載せる】。
        //
        // `crustProduction` は熱水だけの量ではない——**火山脱ガスの正規化に
        // 使われている**（`carbon.ts` の `degassingFollowsCrust`）。
        // そこでは `prod / presentCrustProduction` の比を取るが、分母は
        // `recalibrate` が基準状態で撮るもので、**その時点ではまだ 1 ティックも
        // 回っていないので粒子の実測が存在しない**。分子だけ粒子の実測にすると
        // 推定器が食い違って比が跳ね、跳ね方が解像度で変わる。
        // 実測（2026-08-29）: 陸地面積の解像度差が 104%（契約は 20% 未満）。
        //
        // 熱水の【総出力】には実測を使い、脱ガスの正規化に使う `crustProduction`
        // は従来どおり発散からの見積もりで通す。両者が食い違うこと自体が
        // 診断になる（`ridgeFillByCoverage` を有効にするときは
        // 脱ガスの正規化も一緒に取り直すこと）。
        // ★**割合を真偽値として使わないこと**（`CLAUDE.md` の 21）。
        // `fel` はセル平均の珪長質の【割合】なので、0.5 で切ると
        // **格子を細かくするほどセルが純粋になり、海洋と判定される面積が増える**。
        // 実測（2026-08-31・seed audit・40x800kyr）: 脱ガスの正規化に使う
        // この生産量が 96x48 と 144x72 で 9.13 → 10.50 km³/yr（+15%）ずれ、
        // 脱ガスがその分増えて **CO2 の解像度差が 0.44**（上限 0.2）になった。
        // 面積の重みは割合そのもの（1 - fel）で掛ける。
        // 8/30 に `climate.ts` のアルベドで直したのと同じ欠陥である。
        // 0 = 閾値（従来）/ 1 = 割合で重み付け / 2 = 判定しない（発散だけで数える）
        const oceanFrac = comp
          ? (p.ventOceanicFraction >= 2 ? 1
            : p.ventOceanicFraction > 0
              ? 1 - (fel[i] < 0 ? 0 : fel[i] > 1 ? 1 : fel[i])
              : (fel[i] < 0.5 ? 1 : 0))
          : (thick[i] <= cont ? 1 : 0)
        const d = oceanFrac > 0 ? div[i] : 0
        if (d > 0 && perDiv > 0) prod += d * hKm * (cellM2 / 1e6) * oceanFrac

        const f = useSpread
          ? (spr![i] > 0 ? (spr![i] * perVol) / cellM2 : 0)
          : (d > 0 && perDiv > 0 ? d * perDiv : 0)
        // 実際に置いた量 [km³/yr]。見積もり `prod` と分けて持つ
        if (useSpread && spr![i] > 0) prodActual += spr![i]
        if (f <= 0) { vent[i] = 0; continue }
        vent[i] = f
        power += f * cellM2
        sq += f * f * aw
      }
    }
    this.state.ventPower = power
    // 逆シンプソンの有効面積。全球面積に対する比で持つ
    const meanF = power / EARTH_SURFACE_M2
    this.state.ventArea = sq > 0 ? (meanF * meanF) / sq : 0
    this.state.crustProduction = prod
    this.state.crustProductionActual = prodActual
  }

  /**
   * **「現在の地球なら」の海洋地殻の生産量 [km³/yr]。脱ガスの正規化の分母。**
   *
   * ★2026-08-31 の発見: 冥王代スタートでは**構築の時点でマントルが 2250℃**
   * （`world.ts` の `new Mantle(..., HADEAN_START.mantleTempC)`）なので
   * `mobile = false` になり、`update` が数える生産量が **0** になる。
   * その 0 が `carbon.presentCrustProduction` に入るので、
   * **`degassingFollowsCrust` が全史 4.54Gyr のあいだ一度も発火しない**。
   * `internalHeatFlux` については同じ罠が `world.ts` にコメントで
   * 警告されているのに、この分母は取りこぼされていた。
   *
   * ここでは**現在の地球のマントル温度**で厚さを決め、様式の門も通さずに
   * 発散の場から数える。分子（実行時）と同じ推定器のままにすること。
   */
  presentDayCrustProduction(world: World): number {
    const { W, H } = world.grid
    const p = this.params
    const tp = world.tectonics.params
    const comp = tp.crustComposition > 0 || tp.crustModel > 0
    const div = world.store.f32("divergence").read
    const thick = world.store.f32("crustThickness").read
    const fel = world.store.f32("felsic").read
    const cont = tp.continentThreshold
    // 現在の地球のマントル温度（`world.ts` の較正と同じ 1350℃）
    const hKm = comp ? Tectonics.oceanCrustThickness(1350) : p.oceanCrustThicknessKm
    let prod = 0
    for (let y = 0; y < H; y++) {
      const cellM2 = world.grid.cellArea[y]
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const oceanFrac = comp
          ? (p.ventOceanicFraction > 0
            ? 1 - (fel[i] < 0 ? 0 : fel[i] > 1 ? 1 : fel[i])
            : (fel[i] < 0.5 ? 1 : 0))
          : (thick[i] <= cont ? 1 : 0)
        if (oceanFrac > 0 && div[i] > 0) prod += div[i] * hKm * (cellM2 / 1e6) * oceanFrac
      }
    }
    return prod
  }

  /**
   * 現在の地球で較正する。**必ず基準状態（現在の地球）で呼ぶこと。**
   *
   * carbon.ts の `recalibrate` と同じ考え方——「現在の地球はこうなっている」を
   * 定数の定義に使う。ここで固定するのは 2 つ:
   *
   *   1. 転覆流量 q₀ = 30 Sv     （NADW 15 + AABW 15）
   *   2. 表層塩分差 ΔS₀ = 1.6 psu（熱帯 36.5 − 高緯度 34.9）
   *
   * 平衡条件から必要な定数が一意に決まる:
   *
   *   ΔT₀ = ΔT* / (1 + 2q₀τ/V)                 … 温度は移流で均される
   *   k   = q₀ / (α·ΔT₀ − β·ΔS₀)               … 流量係数
   *   eff = ΔS₀·q₀ / (F·S₀)                    … 環流が運ばない割合
   *
   * **較正するのは 2 定数で、拘束も 2 つ**なので過剰決定ではない。
   * ヒステリシスの【構造】は方程式が持っていて、較正はそれを現在の地球に
   * 合わせて置くだけ。枝の位置と幅は較正の後も物理が決める。
   *
   * 【解像度独立になる理由】ΔT* と F は面積重み積分なので解像度にほぼ依らず
   * （実測 96x48 と 128x64 で ΔT* の差 0.02K）、較正後の q₀ は定義上一致する。
   */
  recalibrate(world: World): void {
    const p = this.params
    const st = this.state
    const g = world.globals
    if (!(g.oceanWaterFraction > 0.999) || !(g.steamFraction < 1e-3)) {
      throw new Error(
        `Ocean.recalibrate は現在の地球（海 1.0 / 水蒸気 0）で呼ぶこと。` +
        `いま 海 ${g.oceanWaterFraction} / 水蒸気 ${g.steamFraction}。` +
        `冥王代の値は applyHadeanStart で後から入れる`)
    }
    const f = this.forcing(world)
    const q0 = p.targetOverturningSv * 1e6
    const V = 0.5 * p.oceanVolume
    const dT0 = f.deltaTAtm / (1 + 2 * q0 * (p.tempRelaxYears * SEC_PER_YEAR) / V)
    const dS0 = p.targetDeltaS
    const drive = p.alphaT * dT0 - p.betaS * dS0
    if (!(drive > 0)) {
      throw new Error(
        `Ocean.recalibrate: 密度差が正にならない（α·ΔT=${(p.alphaT * dT0).toExponential(2)} ` +
        `<= β·ΔS=${(p.betaS * dS0).toExponential(2)}）。` +
        `ΔT*=${f.deltaTAtm.toFixed(2)}K が小さすぎるか targetDeltaS が大きすぎる`)
    }
    p.hydraulicK = q0 / drive
    const fRef = f.freshwaterM3PerYear / SEC_PER_YEAR
    p.freshwaterEfficiency = fRef > 0 ? dS0 * q0 / (fRef * p.refSalinity) : 1
    st.deltaT = dT0
    st.deltaS = dS0
    st.overturningSv = p.targetOverturningSv
    st.ventilation = 1
    st.thermohalineMode = "thermal"
    // リンの在庫は定常値から始める（供給 × 滞留時間 = 2.9e15 mol）
    st.phosphateInventory = p.phosphateInputRef * p.phosphateResidenceYears
    this.phosphorusBudget.input = 0
    this.phosphorusBudget.burial = 0
    this.phosphorusBudget.initial = st.phosphateInventory
    // 濃度と表層供給を作り直す（構築時は update -> recalibrate の順なので
    // 在庫を入れただけでは場が 0 のまま残る）
    this.stepPhosphorus(world, 0)
    this.solveOxygen(world)
    this.solveCarbon(world)
    this.calibrated = true
  }

  /**
   * (b) 熱塩循環。Stommel (1961) の 2 箱モデル。
   *
   * 低緯度箱（暖・塩）と高緯度箱（冷・淡）の密度差が転覆を駆動する。
   *
   *   q = k · (α·ΔT − β·ΔS)                      … 密度差に比例した流量
   *   dΔT/dt = (ΔT* − ΔT)/τ − 2|q|·ΔT/V          … 大気への緩和と移流
   *   dΔS/dt = 2·F·S₀/V     − 2|q|·ΔS/V          … 淡水強制と移流
   *
   * **これがヒステリシスの正体**である。移流項 −2|q|ΔS/V は、流れが速いほど
   * 塩分差を潰す。熱塩枝（q 大）では ΔS が小さく保たれて q が大きいまま、
   * 塩分枝（q 小）では ΔS が育って q が小さいまま——同じ淡水強制 F に対して
   * 2 つの安定解が共存する。だから【一度止めると戻しても復活しない】。
   * ティッピング要素そのもので、docs/03-3.3 の惑星健全性レーダーに入っている。
   *
   * 【なぜ平衡まで回してよいか】海洋循環の調整時間は約 1000 年で、
   * このサブシステムの刻み 50 万年よりはるかに短い（docs/01-6.7）。
   * **だが平衡【解】を代数的に選んではいけない。** 2 つある解のどちらに居るかは
   * 履歴が決めるので、必ず現在の状態から時間積分して連続に辿る。
   * その結果は刻みに依存しない（十分長ければ必ず同じ不動点に落ちる）。
   */
  private solveThermohaline(world: World): void {
    const p = this.params
    const st = this.state
    const f = this.forcing(world)
    this.boxTempL = f.tempL
    this.boxTempH = f.tempH
    st.deltaTAtm = f.deltaTAtm
    st.freshwaterSv = f.freshwaterM3PerYear / SEC_PER_YEAR / 1e6

    // 液体の海が無ければ循環も無い（冥王代のマグマオーシャン期）
    const wf = world.globals.oceanWaterFraction
    const t = wf <= 0 ? 0 : wf >= 0.05 ? 1 : wf / 0.05
    const liquid = t * t * (3 - 2 * t)
    const volume = 0.5 * p.oceanVolume * wf     // 箱 1 つあたりの体積 [m³]
    if (liquid <= 0 || volume <= 0 || f.oceanAreaL <= 0 || f.oceanAreaH <= 0) {
      st.deltaT = 0; st.deltaS = 0
      st.overturningSv = 0; st.ventilation = 0; st.thermohalineMode = "off"
      return
    }

    // 淡水流入 [m³/s]。環流が運ぶ分を除いてから、外部異常（介入・テスト）を足す。
    // 異常の方は氷床融解などの【直接の投入】なので、そのまま全部が効く。
    const F = p.freshwaterEfficiency * f.freshwaterM3PerYear / SEC_PER_YEAR
      + p.freshwaterAnomalySv * 1e6
    const dtS = p.thermohalineSubstepYears * SEC_PER_YEAR
    const invTau = 1 / (p.tempRelaxYears * SEC_PER_YEAR)

    let dT = st.deltaT, dS = st.deltaS
    let q = 0, iters = 0
    for (; iters < p.thermohalineMaxIters; iters++) {
      q = p.hydraulicK * (p.alphaT * dT - p.betaS * dS)
      const aq = Math.abs(q) / volume
      // 【半陰的に書くこと】陽的オイラーだと海が小さいときに発散する。
      //
      // 安定条件は dt·2|q|/V < 1。冥王代の凝結の途中では海水量が 0.0003 まで
      // 小さくなり、V が 2e14 m³ になって条件を 3 桁破る。**実際に踏んだ**——
      // ΔT と ΔS が NaN になり、NaN は消えないので【全史 45 億年ずっと
      // 熱塩循環が死んでいた】。監査の停止検出（0.0% のステップで作動）が
      // 捕まえた。テストは現在の地球しか触らないので素通りしていた。
      //
      // 分母に置けば任意の dt で安定で、不動点は陽的版と同じ。
      const ndT = (dT + dtS * f.deltaTAtm * invTau) / (1 + dtS * (invTau + 2 * aq))
      const ndS = (dS + dtS * 2 * F * p.refSalinity / volume) / (1 + dtS * 2 * aq)
      const change = Math.abs(ndT - dT) + Math.abs(ndS - dS)
      const scale = 1 + Math.abs(dT) + Math.abs(dS)
      dT = ndT; dS = ndS
      if (change < 1e-11 * scale) { iters++; break }
    }
    if (iters >= p.thermohalineMaxIters) st.thermohalineStalls++
    if (!Number.isFinite(dT) || !Number.isFinite(dS)) {
      // 発散したら基準状態に戻す。**黙って NaN を持ち回らない**
      dT = f.deltaTAtm; dS = p.targetDeltaS
      st.thermohalineStalls++
    }

    st.deltaT = dT
    st.deltaS = dS
    q = p.hydraulicK * (p.alphaT * dT - p.betaS * dS)
    st.overturningSv = q / 1e6
    // 換気は流量の【大きさ】で決まる。逆転していても水は入れ替わる
    st.ventilation = Math.abs(st.overturningSv) / p.targetOverturningSv
    st.thermohalineMode = Math.abs(st.overturningSv) < 1
      ? "off" : q > 0 ? "thermal" : "haline"
  }

  /**
   * 熱塩循環の 2 つの強制を場から集計する。
   *
   * ΔT*  : 低緯度と高緯度の【海面】水温差。大気が押しつける値
   * F    : 高緯度箱への正味の淡水流入 [m³/yr]
   *
   * 蒸発の場は持っていないので、水収支から逆算する。
   * 全球で E = P、陸では E_land = P_land − 流出 なので
   *
   *   海の蒸発の総量 = P_全球 − E_land = P_海 + 流出_陸
   *
   * これを海上セルに PET 形（水循環と同じ式）で配分する。
   * こうすると【全球で必ず閉じる】ので、高緯度箱の F と低緯度箱の F は
   * 符号が逆で大きさが等しくなる。
   *
   * 河川は 45 度も動かないので、陸の流出はその陸セルが属する箱に入れる。
   */
  private forcing(world: World): {
    deltaTAtm: number; freshwaterM3PerYear: number
    oceanAreaL: number; oceanAreaH: number
    tempL: number; tempH: number
  } {
    const { W, H } = world.grid
    const p = this.params
    const hp = world.hydrology.params
    const elev = world.store.f32("elevation").read
    const T = world.store.f32("surfaceTemp").read
    const ice = world.store.f32("iceFraction").read
    const precip = world.store.f32("precip").read
    const runoff = world.store.f32("runoff").read
    const sea = world.globals.seaLevel

    let areaL = 0, areaH = 0, tL = 0, tH = 0
    let pOcean = 0, rLandH = 0, rLandAll = 0, shapeSum = 0, shapeH = 0, pOceanH = 0
    for (let y = 0; y < H; y++) {
      const a = world.grid.cellArea[y]
      const high = Math.abs(world.grid.latDeg[y]) >= p.latSplitDeg
      const row = y * W
      for (let x = 0; x < W; x++) {
        const i = row + x
        if (elev[i] >= sea) {
          // 陸: 流出だけを見る（mm/yr -> m/yr）
          const r = runoff[i] * 1e-3 * a
          rLandAll += r
          if (high) rLandH += r
          continue
        }
        const shape = (hp.petBase + hp.petPerK * Math.max(0, T[i])) * (1 - ice[i]) * a
        shapeSum += shape
        pOcean += precip[i] * 1e-3 * a
        if (high) { areaH += a; tH += T[i] * a; shapeH += shape; pOceanH += precip[i] * 1e-3 * a }
        else { areaL += a; tL += T[i] * a }
      }
    }
    // 海の蒸発の総量 = P_海 + 流出_陸（全球の水収支から）
    const evapTotal = pOcean + rLandAll
    const evapH = shapeSum > 0 ? evapTotal * (shapeH / shapeSum) : 0
    const meanL = areaL > 0 ? tL / areaL : 0
    const meanH = areaH > 0 ? tH / areaH : 0
    return {
      deltaTAtm: meanL - meanH,
      freshwaterM3PerYear: pOceanH - evapH + rLandH,
      oceanAreaL: areaL, oceanAreaH: areaH,
      tempL: meanL, tempH: meanH,
    }
  }

  /**
   * (a) 風成循環。スヴェルドラップ平衡（Sverdrup 1947）+ 西岸境界流（Stommel 1948）。
   *
   * 3 段構えで、どれも 1 パスで済む。楕円型ソルバは要らない。
   *
   *   1. 風応力 τ を作る（帯状の 3 セル循環 + 東岸の赤道向き風）
   *   2. エクマン湧昇  w = ∇·[ (τ_y, −τ_x)/(ρf) ]      … 湧昇マップ
   *   3. スヴェルドラップ流線関数  βV = curl(τ)/ρ を東岸から西へ積分
   *      -> 西岸で残った分を境界層で返す（西岸境界流）
   *
   * **なぜ楕円型ソルバを使わないか**（docs/01-6.7 は PCG の流用を想定していた）:
   * Stommel の渦度方程式 R∇²ψ + β∂ψ/∂x = curl τ/ρ は β 項のせいで
   * **非対称**なので、そもそも PCG が使えない（BiCGSTAB などが要る）。
   * スヴェルドラップ解は東岸から西へ 1 回積分するだけで厳密に出るうえ、
   * 西岸境界流も「残差を境界層で返す」だけで出る。**そちらが正しく、かつ速い。**
   *
   * **解像度独立になるのは【総量】だけ。** 湧昇の総量 [Sv] と境界流の輸送量 [Sv]
   * は積分量なので不変だが、海岸での湧昇の【強さ】は 1/dx で増える
   * （エクマン輸送がセル 1 個で止まるため）。熱水と同じ事情（`ventArea` 参照）。
   */
  private solveWindDriven(world: World): void {
    const { W, H } = world.grid
    const n = world.grid.cellCount
    const p = this.params
    if (!this.tauX || this.tauX.length !== n) {
      this.tauX = new Float32Array(n)
      this.tauY = new Float32Array(n)
      this.ekX = new Float32Array(n)
      this.ekY = new Float32Array(n)
      this.psi = new Float32Array(n)
      this.scratch = new Float32Array(n)
      this.rowBuf = new Float32Array(W)
    }
    const tauX = this.tauX, tauY = this.tauY!, psi = this.psi!
    const ekX = this.ekX!, ekY = this.ekY!, dist = this.scratch!
    const elev = world.store.f32("elevation").read
    const up = world.store.f32("upwelling").read
    const oU = world.store.f32("oceanU").read
    const oV = world.store.f32("oceanV").read
    const sea = world.globals.seaLevel

    // 液体の海が無ければ風成循環も無い
    const wf = world.globals.oceanWaterFraction
    const tw = wf <= 0 ? 0 : wf >= 0.05 ? 1 : wf / 0.05
    const liquid = tw * tw * (3 - 2 * tw)
    if (liquid <= 0) {
      up.fill(0); oU.fill(0); oV.fill(0)
      this.state.upwellingSv = 0; this.state.downwellingSv = 0
      this.state.westernBoundarySv = 0; this.state.gyreStrengthSv = 0
      return
    }

    // --- 1. 風応力 ---
    //
    // τ_x = −τ0·cos(4φ): 貿易風（0〜22.5 度、西向き）/ 偏西風（22.5〜67.5 度、
    // 東向き）/ 極偏東風（67.5 度以上、西向き）。水循環の prevailingWind と
    // 同じ 3 帯だが、境目を滑らかにしてある（微分するので折れ線では困る）。
    //
    // τ_y は東岸だけに立てる。distEast は「東へ行って陸に当たるまでの距離」。
    this.coastalDistance(world, dist)
    for (let y = 0; y < H; y++) {
      const phi = world.grid.latRad[y]
      const latDeg = world.grid.latDeg[y]
      const zonal = -p.windStress * Math.cos(4 * phi)
      // 亜熱帯高気圧の緯度帯だけで東岸風が立つ
      const dl = (Math.abs(latDeg) - p.coastalWindLatDeg) / p.coastalWindLatWidth
      const latWeight = Math.exp(-dl * dl)
      const sgn = latDeg >= 0 ? 1 : -1
      const row = y * W
      for (let x = 0; x < W; x++) {
        const i = row + x
        if (elev[i] >= sea) { tauX[i] = 0; tauY[i] = 0; continue }
        tauX[i] = zonal
        // 赤道向き（北半球なら南向き = 負）
        tauY[i] = -sgn * p.coastalWindStress * latWeight
          * Math.exp(-dist[i] / (p.coastalWindDecayKm * 1000))
      }
    }

    // --- 2. エクマン湧昇 ---
    //
    // エクマン輸送 M = (τ_y, −τ_x)/(ρf) [m²/s]。その発散が湧昇になる。
    // 陸では M = 0 とし、海岸では片側差分になる——これは近似ではなく
    // **正しい境界条件**で、沿岸湧昇はここから出る。
    const OMEGA = 7.292e-5
    const fMin = 2 * OMEGA * Math.sin(p.minCoriolisLatDeg * Math.PI / 180)
    const dLon = (2 * Math.PI) / W
    const dLat = Math.PI / H
    const rho = p.waterDensity
    for (let y = 0; y < H; y++) {
      // 赤道での 1/f の発散の止め方。**ここは 2 回間違えた。**
      //
      //   × |f| を fMin で頭打ち     -> 赤道で M が ±(τ/ρfMin) に【跳ぶ】。
      //     跳びの大きさが赤道湧昇の全量を決めてしまい、しかも跳びを
      //     何行で表すかで総量が変わる（実測: 64→256 で 596→952 Sv）
      //   × f -> sign(f)√(f²+fMin²)  -> sign が残るので跳びは消えない
      //   ○ 1/f -> f/(f² + fMin²)    -> 奇関数のまま【赤道で 0 になる】。
      //     |f|≫fMin では 1/f に一致し、fMin 付近（緯度 5 度）で最大。
      //
      // 物理的にも正しい。赤道ではエクマン層の理論そのものが成り立たず、
      // 南北輸送はゼロに向かう。赤道湧昇は「両側の輸送の発散」として出る。
      const f = 2 * OMEGA * world.grid.sinLat[y]
      const invF = f / (f * f + fMin * fMin)
      const row = y * W
      for (let x = 0; x < W; x++) {
        const i = row + x
        if (elev[i] >= sea) { ekX[i] = 0; ekY[i] = 0; continue }
        ekX[i] = tauY[i] * invF / rho
        ekY[i] = -tauX[i] * invF / rho
      }
    }
    // 発散は【有限体積】で取る。中心差分だと ∫∇·M dA が厳密に境界項に
    // ならず、全球の総湧昇が解像度で 60% も動いた（実測 64→256 で 596→952 Sv）。
    // 面フラックスの差で書けば総和は厳密にテレスコープする。
    // 陸に接する面はフラックス 0 —— これは近似ではなく正しい境界条件で、
    // 沿岸湧昇はここから出る。
    let upSum = 0, downSum = 0
    const dyM = EARTH_RADIUS_M * dLat
    for (let y = 0; y < H; y++) {
      const row = y * W
      const rowN = row - W, rowS = row + W
      const phiTop = (0.5 - y / H) * Math.PI
      const phiBot = (0.5 - (y + 1) / H) * Math.PI
      const lenN = EARTH_RADIUS_M * Math.cos(phiTop) * dLon
      const lenS = EARTH_RADIUS_M * Math.cos(phiBot) * dLon
      const cellM2 = world.grid.cellArea[y]
      for (let x = 0; x < W; x++) {
        const i = row + x
        if (elev[i] >= sea) { up[i] = 0; continue }
        const ie = row + (x + 1 === W ? 0 : x + 1)
        const iw = row + (x === 0 ? W - 1 : x - 1)
        const fe = elev[ie] >= sea ? 0 : 0.5 * (ekX[i] + ekX[ie]) * dyM
        const fw = elev[iw] >= sea ? 0 : 0.5 * (ekX[i] + ekX[iw]) * dyM
        const fn = y === 0 || elev[rowN + x] >= sea
          ? 0 : 0.5 * (ekY[i] + ekY[rowN + x]) * lenN
        const fs = y === H - 1 || elev[rowS + x] >= sea
          ? 0 : 0.5 * (ekY[i] + ekY[rowS + x]) * lenS
        // 正味の流出 [m³/s] を面積で割ると鉛直速度 [m/s]
        const flux = fe - fw + fn - fs
        up[i] = flux / cellM2 * SEC_PER_YEAR
        const q = Math.abs(flux) / 1e6                        // Sv
        if (flux > 0) upSum += q; else downSum += q
      }
    }
    this.state.upwellingSv = upSum
    this.state.downwellingSv = downSum

    // --- 3. スヴェルドラップ輸送と西岸境界流 ---
    //
    // βV = curl_z(τ)/ρ。τ_y は東岸の狭い帯にしかないので curl の主項は
    // −∂τ_x/∂y だが、両方きちんと取る。
    // V [m²/s] を東岸から西へ積分して流線関数 ψ [m³/s] を作る:
    //   ψ(東岸) = 0、  ψ(x−dx) = ψ(x) − V(x)·dx
    // 西端で残った ψ_w が、そのまま西岸境界流が運ぶべき量になる。
    this.sverdrup(world, psi)

    // ψ から速度を作る。U = −∂ψ/∂y, V = ∂ψ/∂x（いずれも深さ積分 [m²/s]）を
    // 水深で割って深さ平均の流速にする。
    //
    // **これは診断であって輸送には使わないこと。** 球面の連続の式には
    // cosφ の metric が入るので、この直交座標そのままの関係には O(tanφ) の
    // 誤差がある。物理的に正しいのは ψ（＝輸送量）の方で、
    // 判定に使うのは `gyreStrengthSv` と `westernBoundarySv`。
    let maxPsi = 0, wbc = 0
    for (let y = 0; y < H; y++) {
      const cosPhi = Math.max(1e-4, Math.cos(world.grid.latRad[y]))
      const dxm = EARTH_RADIUS_M * cosPhi * dLon
      const dym = EARTH_RADIUS_M * dLat
      const row = y * W
      const rowN = y > 0 ? row - W : row
      const rowS = y < H - 1 ? row + W : row
      for (let x = 0; x < W; x++) {
        const i = row + x
        if (elev[i] >= sea) { oU[i] = 0; oV[i] = 0; continue }
        const ie = row + (x + 1 === W ? 0 : x + 1)
        const iw = row + (x === 0 ? W - 1 : x - 1)
        const U = -(psi[rowN + x] - psi[rowS + x]) / (2 * dym)
        const V = (psi[ie] - psi[iw]) / (2 * dxm)
        const depth = Math.max(p.minDepthM, sea - elev[i])
        oU[i] = U / depth * SEC_PER_YEAR
        oV[i] = V / depth * SEC_PER_YEAR
        const a = Math.abs(psi[i])
        if (a > maxPsi) maxPsi = a
        // 西岸境界流の輸送量 = 西端に残った流線関数。**足し上げてはいけない**
        // （同じ流れを南北に何行も数えることになる）。最大値で代表させる
        if (elev[iw] >= sea && a / 1e6 > wbc) wbc = a / 1e6
      }
    }
    this.state.gyreStrengthSv = maxPsi / 1e6
    this.state.westernBoundarySv = wbc
  }

  /**
   * 各海セルについて「東へ進んで陸に当たるまでの距離」[m] を求める。
   * 東岸（大陸の西海岸）で 0 になる。東西は巡回する。
   * 全部が海の行では距離が定義できないので、大きな値を入れる（東岸風は消える）。
   */
  private coastalDistance(world: World, out: Float32Array): void {
    const { W, H } = world.grid
    const elev = world.store.f32("elevation").read
    const sea = world.globals.seaLevel
    for (let y = 0; y < H; y++) {
      const row = y * W
      const dxm = EARTH_RADIUS_M * Math.max(1e-4, Math.cos(world.grid.latRad[y]))
        * (2 * Math.PI) / W
      let land = false
      for (let x = 0; x < W; x++) if (elev[row + x] >= sea) { land = true; break }
      if (!land) { for (let x = 0; x < W; x++) out[row + x] = 1e12; continue }
      // 東から西へ 2 周する（1 周目は巡回の初期値を作るため）
      let d = 1e12
      for (let pass = 0; pass < 2; pass++) {
        for (let k = 0; k < W; k++) {
          const x = ((W - 1 - k) % W + W) % W
          const i = row + x
          if (elev[i] >= sea) { d = 0; out[i] = 0; continue }
          d += dxm
          out[i] = d
        }
      }
    }
  }

  /**
   * スヴェルドラップ流線関数 [m³/s] を東岸から西へ積分して作る。
   *
   *   V = curl_z(τ)/(ρβ)      β = 2Ω cosφ / R
   *
   * 陸では ψ = 0。海の連なり（海盆）ごとに東端から始めて西へ足していき、
   * 西端に達したら **境界層で 0 に戻す**。これが西岸境界流になる。
   * 境界層の幅はストンメル層（約 100km）だが、セルがそれより粗いので
   * 実際には 1 セルに押し込まれる。**運ぶ量は正しく、幅だけが解像度で決まる。**
   */
  private sverdrup(world: World, psi: Float32Array): void {
    const { W, H } = world.grid
    const p = this.params
    const elev = world.store.f32("elevation").read
    const sea = world.globals.seaLevel
    const tauX = this.tauX!, tauY = this.tauY!
    const OMEGA = 7.292e-5
    const rho = p.waterDensity
    const dLon = (2 * Math.PI) / W
    const dLat = Math.PI / H
    // V [m²/s] を psi に一時的に入れる
    for (let y = 0; y < H; y++) {
      const cosPhi = Math.max(1e-4, Math.cos(world.grid.latRad[y]))
      const dxm = EARTH_RADIUS_M * cosPhi * dLon
      const dym = EARTH_RADIUS_M * dLat
      const cosN = Math.cos(world.grid.latRad[y > 0 ? y - 1 : y])
      const cosS = Math.cos(world.grid.latRad[y < H - 1 ? y + 1 : y])
      const beta = 2 * OMEGA * cosPhi / EARTH_RADIUS_M
      const row = y * W
      const rowN = y > 0 ? row - W : row
      const rowS = y < H - 1 ? row + W : row
      // 極では β → 0 で V が発散する。上限の手前から滑らかに落とす
      const over = (Math.abs(world.grid.latDeg[y]) - p.sverdrupMaxLatDeg) / p.sverdrupTaperDeg
      const tp = over <= -1 ? 1 : over >= 0 ? 0 : (() => {
        const u = -over          // 1 -> 0
        return u * u * (3 - 2 * u)
      })()
      for (let x = 0; x < W; x++) {
        const i = row + x
        if (elev[i] >= sea || tp === 0) { psi[i] = 0; continue }
        const ie = row + (x + 1 === W ? 0 : x + 1)
        const iw = row + (x === 0 ? W - 1 : x - 1)
        // curl_z(τ) = ∂τy/∂x − ∂τx/∂y（球面の metric 込み）
        const dTy = (tauY[ie] - tauY[iw]) / (2 * dxm)
        const dTx = (tauX[rowN + x] * cosN - tauX[rowS + x] * cosS) / (2 * dym * cosPhi)
        psi[i] = tp * (dTy - dTx) / (rho * beta)
      }
    }

    // 行ごとに東から西へ積分する
    for (let y = 0; y < H; y++) {
      const dxm = EARTH_RADIUS_M * Math.max(1e-4, Math.cos(world.grid.latRad[y])) * dLon
      const row = y * W
      let land = false
      for (let x = 0; x < W; x++) if (elev[row + x] >= sea) { land = true; break }
      if (!land) {
        // 全周が海の行（南大洋・極）。**東岸が無いので環流が閉じない。**
        // スヴェルドラップ平衡は「東岸で流線関数がゼロ」を境界条件に使うので、
        // 陸が無い行では解が定義されない（原点の取り方だけで値が決まる）。
        // 実際この行の循環は南極周極流であって、環流ではない。ψ = 0 とする。
        for (let x = 0; x < W; x++) psi[row + x] = 0
        continue
      }
      // 陸から始めて西へ進む。陸で 0 にリセットし、海では積分する
      const vRow = this.rowBuf!
      for (let x = 0; x < W; x++) vRow[x] = psi[row + x]
      // 台形則で積分する。**海岸のセルで半セルずらすのが要点。**
      // ψ = 0 は海岸【面】で立つので、セル中心は acc − V·dx/2 になる。
      // 中心にそのまま acc を入れると海岸ごとに半セルの誤差が乗り、
      // 収束が一次に落ちる。
      let acc = 0
      for (let pass = 0; pass < 2; pass++) {
        for (let k = 0; k < W; k++) {
          const x = ((W - 1 - k) % W + W) % W
          const i = row + x
          if (elev[i] >= sea) { acc = 0; psi[i] = 0; continue }
          psi[i] = acc - 0.5 * vRow[x] * dxm
          acc -= vRow[x] * dxm
        }
      }
      // 西端（西隣が陸）で ψ を 0 に戻す = 西岸境界流。
      // ここでは値を切るのではなく、そのセルの ψ をそのまま残しておく。
      // 隣の陸セルが ψ=0 なので、差分を取った時点で境界層の南北流が出る。
    }
  }

  /**
   * リンの循環。**長期の生物圏の天井を決めるのはリンである**（docs/01-3.3）。
   *
   *   供給 = 陸のケイ酸塩風化に比例（リン灰石が一緒に溶ける）
   *   損失 = 在庫に比例（堆積物への埋没）。滞留時間 3 万年
   *
   * 造山が止まると風化が落ち、リンの供給が落ち、生物圏の上限が下がる——
   * M4 と M5 を繋ぐ鎖の一本目。
   *
   * 【刻みに依存させない】滞留時間 3 万年に対して刻みは 50 万年なので、
   * 陽的オイラーでは発散する。1 次の緩和なので**解析解で一気に飛ばす**:
   *   I(t+dt) = I_eq + (I − I_eq)·exp(−dt/τ)
   * これは刻みに依らず厳密。収支は積分した供給と埋没で閉じる。
   */
  private stepPhosphorus(world: World, dtYears: number): void {
    const p = this.params
    const st = this.state
    const tau = p.phosphateResidenceYears
    // 陸の風化の現在比。carbon が毎ステップ更新している
    const cf = world.carbon.lastFluxes
    const rel = cf && world.carbon.params.W0 > 0
      ? Math.max(0, cf.land) / world.carbon.params.W0 : 1
    const input = p.phosphateInputRef * rel
    st.phosphateInput = input
    const eq = input * tau

    if (dtYears > 0) {
      const k = Math.exp(-dtYears / tau)
      const before = st.phosphateInventory
      const after = eq + (before - eq) * k
      // 収支: 供給は input·dt、埋没は差し引きで決まる（解析解と厳密に整合させる）
      const added = input * dtYears
      this.phosphorusBudget.input += added
      this.phosphorusBudget.burial += added - (after - before)
      st.phosphateInventory = after
    }
    st.phosphateBurial = st.phosphateInventory / tau

    const vol = p.oceanVolume * world.globals.oceanWaterFraction
    st.phosphateDeep = vol > 0 ? st.phosphateInventory / vol : 0

    // 表層へのリンの供給 [mol/m²/yr] = 湧昇 [m/yr] × 深層濃度 [mol/m³]。
    // **一次生産の分布はここで決まる**（外洋の 9 割は栄養塩の砂漠で、
    // 生産が集中するのは深層水が湧く場所だけ。docs/01-6.7）。
    const { W, H } = world.grid
    const up = world.store.f32("upwelling").read
    const sup = world.store.f32("phosphateSupply").read
    const elev = world.store.f32("elevation").read
    const sea = world.globals.seaLevel
    for (let y = 0; y < H; y++) {
      const row = y * W
      for (let x = 0; x < W; x++) {
        const i = row + x
        sup[i] = elev[i] >= sea ? 0 : Math.max(0, up[i]) * st.phosphateDeep
      }
    }
  }

  /**
   * 深層の酸素。**海洋無酸素事変（OAE）の機構そのもの**（docs/02-3.4 のメデア）。
   *
   * 定常の収支で書ける。深層に酸素を運ぶのは沈む水だけ:
   *
   *   |q|·O2_deep = |q|·O2_source − 有機物の呼吸
   *   -> O2_deep = O2_source − 需要 / |q|
   *
   * ここから 2 つの機構が同時に出る:
   *
   *   1. **循環が止まると無酸素になる**（|q| → 0 で第 2 項が発散）
   *   2. **塩分枝に落ちても無酸素に近づく**。沈む場所が高緯度（冷たい）から
   *      低緯度（暖かい）に移り、暖かい水は酸素を溶かせない
   *
   * 酸素の飽和濃度は温度に強く依存する（0℃ で 0.35、25℃ で 0.21 mol/m³）。
   * 指数フィット O2sat = 0.350·exp(−T/50)·(pO2/0.209) を使う。
   *
   * **生命がいなければ需要はゼロで、深層は完全に酸素で満たされる。**
   * これは正しい（有機物が沈まないから）。M5 が `deepCarbonFlux` を書く。
   */
  private solveOxygen(world: World): void {
    const p = this.params
    const st = this.state
    // 沈み込む水の温度: 熱塩枝なら高緯度、塩分枝なら低緯度で沈む
    const srcT = st.thermohalineMode === "haline" ? this.boxTempL : this.boxTempH
    const pO2 = Math.max(0, world.globals.o2) / 100
    const sat = (T: number) => 0.350 * Math.exp(-T / 50) * (pO2 / 0.209)
    st.surfaceOxygen = sat(0.5 * (this.boxTempL + this.boxTempH))

    const wf = world.globals.oceanWaterFraction
    const vDeep = p.oceanVolume * wf * p.deepVolumeFraction
    const q = Math.abs(st.overturningSv) * 1e6            // m³/s
    if (vDeep <= 0) {
      st.deepOxygen = 0; st.anoxicFraction = 0; st.ventilationAgeYears = 0
      return
    }
    st.ventilationAgeYears = q > 0 ? vDeep / q / SEC_PER_YEAR : Infinity

    // 需要 [mol-O2/s]: 輸出生産 × 海の面積 × O2:C 比
    let oceanArea = 0
    const { W, H } = world.grid
    const elev = world.store.f32("elevation").read
    const sea = world.globals.seaLevel
    for (let y = 0; y < H; y++) {
      const a = world.grid.cellArea[y]
      const row = y * W
      for (let x = 0; x < W; x++) if (elev[row + x] < sea) oceanArea += a
    }
    const demand = p.deepCarbonFlux * oceanArea * p.o2PerCarbon / SEC_PER_YEAR

    const src = sat(srcT)
    st.deepOxygen = q > 0 ? Math.max(0, src - demand / q) : 0
    // 低酸素の閾値でなめらかに 0..1 にする
    const t = st.deepOxygen >= p.hypoxicThreshold ? 1
      : st.deepOxygen <= 0 ? 0 : st.deepOxygen / p.hypoxicThreshold
    const sm = t * t * (3 - 2 * t)
    st.anoxicFraction = 1 - sm
  }

  /**
   * 海洋の溶存無機炭素（DIC）。**溶解ポンプまで。生物ポンプは M5。**
   *
   *   DIC(pCO2, T) = DIC_ref · (pCO2/280)^(1/R) · (1 − a·(T − 15))
   *
   * 第 1 項が炭酸系の緩衝（レヴェル因子 R）、第 2 項が溶解度の温度依存で、
   * **冷たい高緯度の表層水ほど炭素を多く溶かして沈む**——これが溶解ポンプ。
   * 観測でも表層 DIC は暖水 1950 / 冷水 2150 μmol/kg で 10% ほど違う。
   *
   * > ★**ここは診断であって、まだ大気の CO2 を動かしていない。**
   * >
   * > carbon.ts は `Meff = 21 Gt-C/ppm`（大気 + 海洋の実効リザーバ）で
   * > CO2 を積分している。つまり海洋の緩衝は【集約された定数として】
   * > 既に入っている。ここで作る DIC はその内訳を可視化したもので、
   * > `impliedMeff` が 21 に一致していれば両者は同じことを言っている。
   * >
   * > **prognostic にする（Meff を捨てて DIC を積分する）のは M5 の直前。**
   * > 生物ポンプが炭素を深層へ隔離して大気 CO2 を下げる経路は、それが要る。
   * > ただし影響は小さくない: Meff が状態依存になり、冥王代の
   * > CO2 10 万 ppm では Meff が 21 -> 2.2 に落ちる（高 CO2 では
   * > 炭酸系の緩衝が効かないので、海はもう吸えない）。**冥王代・太古代の
   * > CO2 の応答が 10 倍速くなる**ので、全史ランでの検証が要る。
   * > 今日のついでに入れる変更ではない。
   */
  private solveCarbon(world: World): void {
    const p = this.params
    const st = this.state
    const { W, H } = world.grid
    const elev = world.store.f32("elevation").read
    const T = world.store.f32("surfaceTemp").read
    const dic = world.store.f32("dic").read
    const sea = world.globals.seaLevel
    const wf = world.globals.oceanWaterFraction

    const co2 = Math.max(1e-6, world.globals.co2)
    const buffer = Math.pow(co2 / 280, 1 / p.revelleFactor)
    let sum = 0, area = 0
    for (let y = 0; y < H; y++) {
      const a = world.grid.cellArea[y]
      const row = y * W
      for (let x = 0; x < W; x++) {
        const i = row + x
        if (elev[i] >= sea || wf <= 0) { dic[i] = 0; continue }
        const c = p.dicRef * buffer * (1 - p.dicTempSensitivity * (T[i] - 15))
        dic[i] = Math.max(0, c)
        sum += dic[i] * a; area += a
      }
    }
    st.dicSurface = area > 0 ? sum / area : 0
    // 生物ポンプが無いので深層は沈む水の DIC そのもの
    st.dicDeep = st.dicSurface
    st.dicInventory = st.dicSurface * p.oceanVolume * wf
    // 実効リザーバ [Gt-C/ppm] = 大気の 2.12 + 海洋の緩衝
    const dicGtC = st.dicInventory * 12e-15
    st.impliedMeff = 2.12 + dicGtC / (p.revelleFactor * co2)
  }
}

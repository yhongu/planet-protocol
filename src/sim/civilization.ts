/**
 * 文明（M6）—— **知性種が惑星に何をするか**（`docs/02` の §文明）。
 *
 * ## この段で作るもの（実装の順の 1 番目）
 *
 * **粗い時間（生命と同じ 100 万年刻み）で回る版**。これだけで惑星に痕跡が出る:
 * CO₂ の跳ね上がり・土地利用の拡大・野生の生息地の減少。
 * ★プレイヤーが**降りなくても遊べる状態**をまず作る（設計方針 A-2）。
 *
 * ## なぜ「技術」がゲノムと同じ形なのか
 *
 * ★**新しい機構を作らない。** 生命のゲノムの仕組みがそのまま使える:
 *
 * | 生命 | 文明 |
 * |---|---|
 * | 遺伝子の種類 | 技術の種類 |
 * | 前提の鎖 | 技術ツリーの依存 |
 * | 新機能化（低確率の発明） | 技術の発明 |
 * | 欠失 | **失伝** |
 * | 水平伝播 | 交易による伝播 |
 * | **由来 id** | **独立発明か、伝わったものか** |
 *
 * `docs/02` の「機能は収斂する、系統は収斂しない」がそのまま効く ——
 * 文字が 2 つの文明にあるとき、**由来が違えば独立発明、同じなら伝播**。
 *
 * ## 学問に接地させる（機構だけを入れて、結果は惑星に決めさせる）
 *
 * - **White の法則**: 複雑さ ∝ 1 人あたりのエネルギー。
 *   ★段階に名前を付けず、**エネルギー捕捉率という連続量**で表す
 * - **Tainter**: 複雑さには**収穫逓減**がある。
 *   ★これで崩壊が台本ではなく**内生**する
 * - **Boserup**: 人口圧が集約化を駆動する（収容力が足りないと発明が増える）
 * - **Henrich (2004) のタスマニア効果**: 技術の維持には**人口と繋がり**が要る。
 *   ★**孤立した島は失伝し、繋がった大陸では蓄積する**
 * - **人口転換**: 豊かさが出生率を下げる
 *   （★負のフィードバックが 1 本だと暴れる。`CLAUDE.md` の 95）
 *
 * ## 既定は 0（無効）
 *
 * ★**未検証の物理を既定に残さない。** 有効にする条件は
 * 「時間解像度の独立性のテストが通ること」（設計方針の 2 番目）。
 */
import type { World } from "./world"
import type { Subsystem } from "./loop"
import { GENE_KINDS, hasCapability } from "./genome"
import {
  TECHS, TECH_PREREQ, sumTech, techPrereqOk, techGateOk,
  type TechEffect, type PlanetGate,
} from "./tech"
import { felsicVolume } from "./tectonics"
import { Rng } from "../core/rng"
import type { FieldSpec } from "../core/fields"

const C_SYMBOLIC = GENE_KINDS.indexOf("capSymbolic")

export const CIV_FIELDS: readonly FieldSpec[] = [
  {
    name: "population", kind: "f32", doubleBuffered: false,
    comment: "人/セル。★収容力とのロジスティックで決まる",
  },
  {
    name: "civId", kind: "u8", doubleBuffered: false,
    comment: "0 = 無人。1..MAX_CIVS = その文明の領域。★文明ごとに技術が違う",
  },
  {
    name: "landCleared", kind: "f32", doubleBuffered: false,
    comment: "0..1。これまでに開墾した割合の最大値。★炭素は【一度だけ】出る。"
      + "増分で数えると、刻みを細かくするほど揺れを足して CO2 が膨らむ",
  },
  {
    name: "landUse", kind: "f32", doubleBuffered: false,
    comment: "0..1。そのセルの陸のうち農地・都市に変えた割合。"
      + "★野生の生息地を減らす（人為的な絶滅の実体）",
  },
]

/**
 * ★★**刻みに依らないロジスティック**（時間解像度の独立性の核）。
 *
 * オイラー法（`N += r·N·(1−N/K)·dt`）で書くと、**刻みを変えると答えが変わる**。
 * 100 年刻みと 100 万年刻みで違う惑星になったら、
 * 「降りるのが裏技」になって設計方針 A-2 が壊れる。
 *
 * ロジスティックには解析解があるので、**1 歩で厳密に解ける**:
 *
 *   N(t+dt) = K / (1 + (K/N − 1)·exp(−r·dt))
 *
 * ★同じ作法を海のリンで既に使っている（`ocean.ts` の `eq + (before−eq)·k`）。
 * K が歩の中で一定なら、**刻みを何にしても厳密に同じ**になる。
 * K が動くぶんの差だけが残り、それは物理（環境が変われば結果も変わる）。
 */
export function logisticStep(n: number, k: number, r: number, dtYears: number): number {
  if (!(k > 0) || dtYears <= 0) return n
  if (!(n > 0)) return 0
  const decay = Math.exp(-r * dtYears)
  const denom = 1 + (k / n - 1) * decay
  return denom > 0 ? k / denom : k
}

/**
 * ★**緩和も解析で解く**（土地利用が目標へ近づく速さ）。
 * `x(t+dt) = target + (x − target)·exp(−dt/τ)`。オイラーだと刻みで変わる。
 */
/**
 * ★★**失伝の速さ**（Henrich 2004 のタスマニア効果）。
 *
 * 技術の維持には**人口規模と繋がり**が要る。学習は不完全なので、
 * 集団が小さいと世代ごとに劣化し、**複雑な技術ほど先に失われる**。
 *
 *   λ = rate × 複雑さ / (人口 × 情報の保持)
 *
 * ★**目盛りが大事**。最初 rate = 3e4 にしたら、100 万年刻みでは確率が
 * どの規模でも 1 に飽和し、**人口が 40 倍違っても失伝の回数が変わらなかった**
 * （実測: 小さい文明 142 回 / 大きい文明 155 回 —— むしろ逆）。
 * 3e2 に下げたら 小さい文明 60 回 / 大きい文明 38 回になった。
 * ★同じ失敗を発明でもした —— **粗い時間では確率を小さく取らないと差が出ない。**
 */
export function techLossLambda(
  complexity: number, pop: number, retention: number,
  rate: number, popRef: number,
): number {
  return rate * complexity / (Math.max(popRef, pop) * Math.max(1e-9, retention))
}

export function relaxStep(x: number, target: number, tauYears: number, dtYears: number): number {
  if (!(tauYears > 0) || dtYears <= 0) return x
  const k = Math.exp(-dtYears / tauYears)
  return target + (x - target) * k
}

export interface CivParams {
  /**
   * 0 で無効（既定）。★有効にする条件は
   * **「時間解像度の独立性のテストが通ること」** ——
   * 降りても降りなくても結果が同じでなければ、
   * 降りるのが必須（A-2 の意味が消える）か裏技（結果が変わる）になる。
   */
  enabled: number
  /**
   * **1 人が最低限必要とする一次生産** [mol C/yr/人]。
   * 収容力 = そのセルの一次生産 × 土地利用の効率 / これ。
   *
   * 狩猟採集の人口密度は 0.1 人/km²、農耕で 10〜100 人/km² になる ——
   * ★この差は**技術（エネルギー捕捉と収容力）**が作るのであって、
   * 定数で与えない。
   */
  foodPerPerson: number
  /** 人口の増加率 [1/yr]（収容力に対するロジスティック） */
  growthRate: number
  /**
   * ★**豊かさが出生率を下げる**（人口転換）。
   * 1 人あたりエネルギーがこの値を超えると増加率が半分になる [W/人]。
   * 負のフィードバックが「餓死」1 本だけだと人口が振動する（罠 95）。
   */
  demographicTransitionW: number
  /**
   * **一次生産のうち食料に使える量** [mol C/(m² yr)]。
   * `biomassTotal`（0..1）に掛けて、その地域の食料にする。
   *
   * ★**較正**（2026-09-08）: 地球の陸上一次生産は約 5e15 mol C/yr
   * （60 Gt C/yr）。そのうち人類が使うのは **HANPP で約 25%**
   * （Haberl et al. 2007）→ 1.2e15 mol C/yr。1 人 8.3e4 mol/yr なら
   * **1.45e10 人ぶん**で、実際の 80 億人と同じ桁になる。
   * 陸 1.49e14 m² ×（`biomassTotal` の代表値 0.5）で割り戻して 17。
   * ★最初 1e-3 を当てずっぽうで置いたら**人口が 433 万人で頭打ち**になった
   * （現代の 3 桁下）。**それらしい数字でも桁を確かめること**（罠 13）
   */
  yieldMolPerM2: number
  /**
   * 農地にすると食料が何倍になるか（Boserup の集約化。土地利用 1 で +これ）。
   *
   * ★**既定 0。** これは**農耕という技術**の効果であって、
   * 知性が生まれた瞬間に使えるものではない。技術ツリー（実装の 5 番目）が
   * 入るまで 0 にしておく。
   * ★20 を最初から掛けたら**人口が 741 億人**（地球の 9 倍）になり、
   * 狩猟採集の段階で陸の 43% が農地になった。
   * **「まだ無い技術の効果」を既定に混ぜない**（罠 90 の裏返し ——
   * あのときは「実装されていない見返りのためにコストだけ取っていた」）
   */
  agricultureGain: number
  /**
   * ★**1 人を養うのに要る土地** [m²/人]。
   * 地球の農地 5.0e13 m²（5000 万 km²・牧草地を含む）÷ 80 億人 = 6250 m²/人。
   * これで「人口が少なければ土地も使わない」が成り立つ。
   */
  landPerPersonM2: number
  /** 土地利用が目標へ近づく時定数 [yr] */
  landUseTauYears: number
  /** ★**最初の 1 人**。0 はロジスティックの不動点なので、種を置かないと増えない */
  seedPopulation: number
  /** 技術が無いときの 1 人あたりエネルギー [W/人]（狩猟採集 ≒ 火のみ） */
  baseEnergyW: number
  /**
   * ★**建国の速さ** [1/yr]。知性種がいる無主の陸に文明が生まれる確率。
   * **複数の文明が別々の場所で育つ**ので、惑星の条件（大河・海）が違い、
   * 代替経路（灌漑/天水、舟/畜力）が自然に分かれる。
   */
  foundingRate: number
  /**
   * ★**領域が広がる速さ** [km/yr]。
   *
   * ★**「1 歩で 1 セル」で書いてはいけない**（罠 99）——
   * セルの東西の幅は緯度で変わる（極では赤道の 1/28）ので、
   * 同じ確率で広げると**高緯度ほど速く東西に伸びて三角形になる**。
   * 実測で地図に幾何学的な三角形が出た（★撮って気づいた。罠 48）。
   */
  expansionKmPerYear: number
  /**
   * ★**技術が伝わる速さ** [1/(km·yr)]。接する境界の長さに比例する。
   *
   * ★**重力モデル**（規模 × 規模 / 距離）の、格子での素直な形が
   * 「**接している長さ**」。境界の長さは km で測るので**解像度に依らない**
   * （セルを細かくすると本数は増えるが 1 本が短くなる。罠 9 の「線」の扱い）。
   *
   * ★**伝わった技術は由来 id を引き継ぐ** —— これで系譜図に
   * 「独立発明（由来が違う）」と「伝播（由来が同じ）」が描き分けられる。
   * `docs/02` の「機能は収斂する、系統は収斂しない」の文明版。
   */
  techTransferRate: number
  /**
   * ★**征服**が起きる速さ [1/(km·yr)]。軍事力の比が大きいほど速い。
   * 軍事力 = 技術の `military` の合計 × 人口の平方根
   * （★人口だけでは「大きいが弱い」文明を表せない）。
   */
  conquestRate: number
  /**
   * ★**そのセルを「陸」と呼ぶ最小の陸の割合**。
   *
   * ★**割合を真偽値として使わない**（`CLAUDE.md` の 21）。
   * `landFraction > 0` を「陸」としたら、**陸の割合が 1% の海のセルにも
   * 文明が広がり、文明のセル 583 のうち 554 が海**になった
   * （★地図を撮って「かまぼこ型」に見えたので測って気づいた。罠 48）。
   * ★**同じ閾値を「住めるか」と「広がれるか」の両方で使うこと**（罠 23）。
   */
  minLandFraction: number
  /** ★「降りた」ときの刻み [yr]。人類史 1 万年を 100 歩で見る */
  focusStepYears: number
  /** 河川の流量の代表値（これで割って 0..1 にする）。現在の地球の大河の目安 */
  riverRefDischarge: number
  /**
   * ★★**複雑さの維持費**（Tainter『複雑社会の崩壊』）。
   *
   * 技術は収量を上げるが、**維持に資源を食う**。収量から
   * `これ × 複雑さの合計` を引く。複雑さは足し算で増えるので、
   * **技術を増やすほど 1 つあたりの見返りが減る（収穫逓減）**。
   *
   * ★**これが無いと崩壊が起きない。** 実測（繋ぐ前）で人口が
   * **1626 億人**（地球の 20 倍）まで際限なく増えた ——
   * 表に `complexity` を書いたのに**どこからも読まれていなかった**（罠 46）。
   * ★崩壊を隕石や気候で外から与えると台本になる。
   * **内生させるための唯一の経路がこれ。**
   */
  complexityCost: number
  /**
   * ★**発明の速さ**。1 人・1 年あたりの発明の確率の目盛り [1/(人·yr)]。
   *
   * ★**Boserup**: 人口圧が集約化を駆動する ——
   * 発明の機会は**人口に比例**し、収容力に対して詰まっているほど増える。
   * 前提が揃った技術からしか引けない（★鎖は緩めない。罠 113）。
   *
   * ★**較正**: 地球は「1000 万人が 5000 年で文字を発明」＝ 1.386e-11 だが、
   * それは**1 つの技術**の話。40 技術が並行に引かれると実効で 40 倍速くなるので、
   * 2 桁下げて 1.4e-13 にした。実測で発明 1616 回・伝播 12 回だったのが、
   * ★**地球の姿（伝播が主・独立発明は稀）**に寄る。
   */
  inventionRate: number
  /**
   * ★**失伝の速さ**（Henrich 2004 のタスマニア効果）。
   * 失伝の確率 = これ × 複雑さ / (人口 × 情報の保持)。
   * **孤立した小さな文明は、複雑な技術から失っていく。**
   */
  lossRate: number
  /** 失伝の分母が 0 にならないようにする下限の人口 */
  lossPopRef: number
  /**
   * ★**知性種が絶滅した後、人口が消えるまでの時定数** [yr]。
   * 実測で、これを書かないと**知性種 0 の惑星に人口 21 億人が残り続けた**。
   */
  collapseTauYears: number
  /**
   * ★**文明が使った土地は、野生の生息地ではなくなる**（0..1。0 で従来）。
   * 1 なら土地利用 100% のセルで環境収容力が 0 になる。
   * ★これが人為的な絶滅の実体。**隕石を落とすのではなく住む場所を奪う**
   * （地球の現在の絶滅の主因も生息地の破壊。Millennium Ecosystem Assessment）
   */
  habitatDisplacement: number
  /**
   * ★**開墾で大気に出る炭素** [mol C/m²]。
   * 森林を農地に変えると、地上部と土壌の炭素の多くが大気に戻る。
   * 温帯林で約 150 t-C/ha = **1250 mol C/m²**（Houghton の土地利用変化）。
   * ★これが「降りなくても惑星の側に痕跡が出る」の主役。
   */
  landClearCarbonMolPerM2: number
}

export const EARTH_CIV: CivParams = {
  enabled: 0,
  // 1 人が年に食べる炭素 ≒ 100 kg-C ≒ 8300 mol-C。
  // 農耕の効率と分配の損失を見込んで 1 桁上に置く（較正は測ってから）
  foodPerPerson: 8.3e4,
  // 狩猟採集の人口増加は年 0.01〜0.1%。農耕で 0.1〜1%
  growthRate: 1e-3,
  demographicTransitionW: 2000,
  yieldMolPerM2: 17,
  agricultureGain: 0,
  landPerPersonM2: 6250,
  landUseTauYears: 5e4,
  seedPopulation: 1e3,
  // 狩猟採集の 1 人あたりは約 300 W（食料 100 W + 火 200 W。White の目盛り）
  baseEnergyW: 300,
  collapseTauYears: 1e5,
  // 1000 万人の狩猟採集民が 1 万年に 1 つ発明する程度から始める
  // 100 万年に 1 セルあたり 1% 程度。★複数だが多すぎない数を狙う
  foundingRate: 1e-8,
  // 1000 年で 1km 進む程度（★人の移住の速さではなく、領域の拡大の速さ）
  expansionKmPerYear: 1e-3,
  // ★**伝播が主・独立発明が稀**にする（地球の姿）。実測で
  //   発明 1616 回に対し伝播 12 回だったので、発明を 2 桁下げ伝播を上げた。
  //   地球でも車輪や文字が独立に発明されたのは数回で、あとは伝わっている
  techTransferRate: 5e-10,
  conquestRate: 3e-12,
  minLandFraction: 0.5,
  focusStepYears: 100,
  riverRefDischarge: 5e4,
  complexityCost: 0.35,
  // ★地球に較正: 1000 万人の社会が 5000 年で文字を発明する（50% の確率）
  inventionRate: 1.4e-13,
  // ★**3e4 → 3e2**（2026-09-08）。3e4 だと 100 万年刻みで確率が
  //   どの規模でも 1 に飽和し、**人口が 40 倍違っても失伝の回数が変わらなかった**
  //   （実測: 小さい文明 142 回 / 大きい文明 155 回 —— むしろ逆）。
  //   3e2 なら 人口 5000 万で 70% / 24 億で 2.5% と **28 倍の差**が付く
  lossRate: 3e2,
  lossPopRef: 1e4,
  habitatDisplacement: 0.9,
  landClearCarbonMolPerM2: 1250,
}

/**
 * ★**文明 1 つ**（`MAX_CIVS` まで）。
 *
 * 技術は**文明ごと**に持つ。惑星の条件も**その文明の領域で**測るので、
 * 大河のそばの文明は灌漑へ、海辺の文明は舟へと**道が分かれる**。
 */
export interface Civ {
  id: number
  foundedYear: number
  population: number
  energyPerCapita: number
  /** 持っている技術。★これがこの文明のゲノム */
  tech: boolean[]
  /** その技術を**誰が最初に発明したか**。★収斂と伝播を分ける唯一の手段 */
  techOrigin: number[]
  /** ★診断: この文明の人口の最盛期。**崩壊は「最盛期からどれだけ落ちたか」** */
  peakPopulation: number
  /** ★診断: この文明が失伝した回数（タスマニア効果が効いているかを見る） */
  lostCount: number
}

/** 同時に存在できる文明の数。★場が u8 なので 255 まで */
export const MAX_CIVS = 8

export interface CivState {
  /** 全球の人口 [人]（★すべての文明の合計） */
  totalPopulation: number
  /** 1 人あたりのエネルギー [W/人]（★人口で重み付けした平均） */
  energyPerCapita: number
  /** ★いま存在する文明 */
  civs: Civ[]
  /** 延べ何個の文明が生まれたか（id の発番に使う） */
  founded: number
  /** 知性種が現れた年（`yearsElapsed`）。まだなら -1 */
  emergedYear: number
  /**
   * ★開墾で大気に出した炭素の積算 [ppm]（診断・収支の相手）。
   *
   * ★**刻みに依らないことを実測で確かめてある**（24〜56ppm、
   * 100 万年 / 1 万年 / 100 年刻み。`probe-focus.ts`）。
   * ★大気の CO2 そのものは 100 万年刻みで 4000ppm 台に跳ねることがあるが、
   * それは**炭素循環の結合が粗すぎる**ためで、文明とは別の要因（罠 31）。
   */
  landClearCo2Ppm: number
  /** 診断: 発明された回数 / 失伝した回数（★引けたか・失ったかを数える） */
  invented: number
  lost: number
  /** 診断: 技術が伝わった回数 / 征服で領域が移った回数 */
  transferred: number
  conquered: number
}

/**
 * 文明。**知性種（`capSymbolic`）が現れてから動く。**
 *
 * ★`preferredStepYears` は生命と同じ 100 万年（粗い時間）。
 * 細かい時間（プレイヤーが降りたとき）は実装の 3 番目。
 */
export class Civilization implements Subsystem {
  readonly name = "civilization"
  /**
   * ★**降りると刻みが細かくなる**（設計方針 A-2 の⑥）。
   *
   * 惑星の目線では文明は 1 フレームで生まれて滅びる（×20 なら人類史 1 万年は
   * 1/200 フレーム）。プレイヤーが「降りる」を選ぶと、ここが 100 年になる。
   *
   * ★**惑星の物理は粗くならない。** `SubsystemLoop` は各サブシステムが
   * 自分の `preferredStepYears` まで溜めてから発火するので、
   * 親の刻みが 100 年でも**炭素は 25kyr ごと・酸素は 1Myr ごと**に回る。
   * 気候も `chunked()` が結合間隔（20 万年）ごとに解くので変わらない。
   *
   * ★**降りても降りなくても結果は同じでなければならない**（`tests/civilization`）。
   * 確率は必ず `1 − exp(−λ·dt)` で作ってあるので、**ポアソン過程として
   * 刻みに依らない**（n 回に割っても「1 回以上起きる確率」は同じ）。
   */
  get preferredStepYears(): number {
    return this.focused ? this.params.focusStepYears : 1_000_000
  }
  readonly maxStepYears = 1e9
  /** ★プレイヤーが「降りて」いるか。UI が切り替える */
  focused = false
  readonly params: CivParams
  readonly state: CivState = {
    totalPopulation: 0, energyPerCapita: 0, emergedYear: -1, landClearCo2Ppm: 0,
    civs: [], founded: 0, invented: 0, lost: 0, transferred: 0, conquered: 0,
  }

  /** ★決定論のため、世界の seed から作る（`docs/04-6`） */
  private rng: Rng

  constructor(params?: Partial<CivParams>, seed = "civ") {
    this.params = { ...EARTH_CIV, ...params }
    this.rng = new Rng(`${seed}:civ`)
  }

  /** ★状態のすぐ隣に置く（`CLAUDE.md` の 69） */
  snapshot(): Record<string, unknown> { return { ...this.state } }
  restore(v: Record<string, unknown>): void { Object.assign(this.state, v) }

  isActive(_world: World): boolean {
    return this.params.enabled > 0 && this.state.emergedYear >= 0
  }

  /**
   * ★**発明と失伝**（技術のゲノム）。
   *
   * **発明**（Boserup）: 機会は人口に比例する。前提が揃った技術からしか引けない。
   * **失伝**（Henrich 2004 のタスマニア効果）: 確率 ∝ 複雑さ /(人口 × 情報の保持)。
   * ★**孤立した小さな文明は、複雑な技術から先に失う。**
   *
   * ★確率は必ず `1 − exp(−λ·dt)` で作る —— **刻みに依らないため**
   * （`λ·dt` と書くと 100 年刻みと 100 万年刻みで別の惑星になる）。
   */
  private evolveTech(
    civ: Civ, planet: Record<PlanetGate, number>, eff: TechEffect, dtYears: number,
  ): void {
    const p = this.params
    const has = civ.tech
    const pop = civ.population
    // --- 発明 ---
    if (pop > 0) {
      for (let k = 0; k < TECHS.length; k++) {
        if (has[k] || !techPrereqOk(has, k) || !techGateOk(k, planet)) continue
        const lambda = p.inventionRate * pop
        if (this.rng.nextFloat() < 1 - Math.exp(-lambda * dtYears)) {
          has[k] = true
          // ★**由来 id**。誰が最初に発明したかを残す（収斂と伝播を分ける）
          civ.techOrigin[k] = this.state.invented
          this.state.invented++
        }
      }
    }
    // --- 失伝 ---
    const retain = 1 + eff.retention
    for (let k = 0; k < TECHS.length; k++) {
      if (!has[k]) continue
      // ★前提になっている技術は、それに依存する技術がある限り失われない
      //   （使い続けているものは忘れない）。
      //   ★**役割経由の依存も見ること** —— 最初 `needs.includes(名前)` だけを
      //   見ていたので、**口承を失っても法が残った**（法の前提は役割「記録」）。
      //   実測で「法・貨幣・官僚制を持つのに文字も口承も無い」文明が出た
      let inUse = false
      for (let j = 0; j < TECHS.length && !inUse; j++) {
        if (!has[j]) continue
        for (const group of TECH_PREREQ[j]!) {
          // その前提を満たしているのが**この技術だけ**なら、失うと下流が壊れる
          if (!group.includes(k)) continue
          let others = 0
          for (const alt of group) if (alt !== k && has[alt]) others++
          if (others === 0) { inUse = true; break }
        }
      }
      if (inUse) continue
      const lambda = techLossLambda(
        TECHS[k]!.complexity, pop, retain, p.lossRate, p.lossPopRef)
      if (this.rng.nextFloat() < 1 - Math.exp(-lambda * dtYears)) {
        has[k] = false
        civ.techOrigin[k] = -1
        civ.lostCount++
        this.state.lost++
      }
    }
  }

  /**
   * ★**惑星が技術に課す条件を測る。**
   *
   * | 技術 | 条件 | 根拠 |
   * |---|---|---|
   * | 火 | 酸素 16% 以上 | 燃焼限界。**無酸素の惑星では火が使えない** |
   * | 化石燃料 | 埋没した有機炭素 | ★**石炭紀が無かった惑星には石炭が無い** |
   * | 冶金 | 大陸地殻の体積 | 鉱石は大陸地殻に濃集する |
   * | 灌漑 | 河川の流量 | 大河が無いと灌漑農業は成り立たない |
   * | 外洋船 | 海の広さ | |
   */
  private measurePlanet(world: World, civId = 0): Record<PlanetGate, number> {
    const lf = world.store.f32("landFraction").read
    const dis = world.store.f32("discharge").read
    // ★**文明ごとに測る**（`civId > 0` なら、その文明の領域だけ）。
    //   これが「大河のそばの文明は灌漑へ、海辺の文明は舟へ」を作る
    const cid = world.store.u8("civId").read
    let land = 0, tot = 0, riv = 0, sea = 0
    for (let y = 0; y < world.grid.H; y++) {
      const a = world.grid.areaWeight[y]!
      for (let x = 0; x < world.grid.W; x++) {
        const i = y * world.grid.W + x
        const mine = civId === 0 || cid[i] === civId
        const f = Math.max(0, Math.min(1, lf[i] ?? 0))
        if (civId === 0) { land += f * a; tot += a }
        else if (mine) {
          land += f * a; tot += a
          // ★領域が海に面しているか（舟に要る）
          sea += (1 - f) * a
        }
        if (mine && f > 0.5 && (dis[i] ?? 0) > riv) riv = dis[i]!
      }
    }
    const landFrac = tot > 0 ? land / tot : 0
    return {
      o2: world.globals.o2,
      buriedC: world.oxygen.state.buriedOrganicC,
      felsic: felsicVolume(world),
      land: landFrac,
      // ★文明の領域では「自分の領域に含まれる海の割合」＝海に面しているか
      ocean: civId === 0 ? 1 - landFrac : (tot > 0 ? sea / tot : 0),
      // ★流量は惑星で桁が違うので、代表値で割って 0..1 に正規化する
      river: Math.min(1, riv / this.params.riverRefDischarge),
    }
  }

  /**
   * ★**知性種が現れたか**を毎歩見る（`isActive` が false でも呼ばれるよう
   * `World` から直接呼ぶ）。`emergedYear` が立って初めて文明が動き出す。
   */
  detectEmergence(world: World): boolean {
    if (this.state.emergedYear >= 0) return false
    for (const c of world.life.clades) {
      if (!hasCapability(c.phenotype, C_SYMBOLIC)) continue
      this.state.emergedYear = world.globals.yearsElapsed
      return true
    }
    return false
  }

  update(world: World, dtYears: number): void {
    const p = this.params
    const pop = world.store.f32("population").read
    const use = world.store.f32("landUse").read
    const maxUse = world.store.f32("landCleared").read
    const cid = world.store.u8("civId").read
    const lf = world.store.f32("landFraction").read
    const bio = world.store.f32("biomassTotal").read
    const { W, H } = world.grid
    const n = world.grid.cellCount
    // ★**知性種のいるセルにだけ人が住む。** 文明は生命の一部であって、
    //   惑星のどこにでも湧くものではない
    const lanes: number[] = []
    for (const c of world.life.clades) {
      if (hasCapability(c.phenotype, C_SYMBOLIC)) lanes.push(c.lane)
    }
    if (lanes.length === 0) { this.collapseAll(world, dtYears); return }
    const cell = world.store.f32("biomass").read

    // --- 1. 建国 ---
    // ★知性種がいて、まだどの文明にも属さないセルに、低い確率で文明が生まれる。
    //   **複数の文明が別々の場所で育つ**ので、惑星の条件（大河・海）が違い、
    //   ★代替経路（灌漑 / 天水、舟 / 畜力）が自然に分かれる
    if (this.state.civs.length < MAX_CIVS) {
      for (let i = 0; i < n && this.state.civs.length < MAX_CIVS; i++) {
        if (cid[i] !== 0 || (lf[i] ?? 0) < p.minLandFraction) continue
        let here = 0
        for (const l of lanes) here += cell[l * n + i] ?? 0
        if (here <= 0) continue
        if (this.rng.nextFloat() >= 1 - Math.exp(-p.foundingRate * dtYears)) continue
        this.state.founded++
        const id = this.state.civs.length + 1
        this.state.civs.push({
          id, foundedYear: world.globals.yearsElapsed,
          population: p.seedPopulation, energyPerCapita: p.baseEnergyW,
          tech: TECHS.map(() => false), techOrigin: TECHS.map(() => -1),
          peakPopulation: p.seedPopulation, lostCount: 0,
        })
        cid[i] = id
        pop[i] = p.seedPopulation
      }
    }
    if (this.state.civs.length === 0) return

    // --- 2. 領域の拡張 ---
    // ★隣のセルへ広がる（知性種がいて、まだ無主の陸だけ）。
    //   ★**入力と出力を分ける**（同じ配列で走査すると南と東にだけ速く広がる。罠 98）
    const grow = new Uint8Array(cid)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (cid[i] === 0 || pop[i]! <= 0) continue
        // ★**セルの東西の幅は緯度で変わる**（極では赤道の 1/28）。
        //   同じ確率で広げると**高緯度ほど速く東西に伸びて、三角形になる**
        //   （実測: 地図に幾何学的な三角形が出た。撮って気づいた。罠 48）。
        //   広がる速さは **km/yr** で書き、セル幅で割る（罠 99）
        const dxKm = (2 * Math.PI * 6371 * Math.cos(world.grid.latRad[y]!)) / W
        const dyKm = (Math.PI * 6371) / H
        const nb: [number, number][] = [
          [y * W + ((x + 1) % W), dxKm], [y * W + ((x + W - 1) % W), dxKm],
          [y > 0 ? (y - 1) * W + x : -1, dyKm],
          [y < H - 1 ? (y + 1) * W + x : -1, dyKm],
        ]
        for (const [j, km] of nb) {
          if (j < 0 || cid[j] !== 0 || grow[j] !== 0) continue
          if ((lf[j] ?? 0) < p.minLandFraction) continue
          let here = 0
          for (const l of lanes) here += cell[l * n + j] ?? 0
          if (here <= 0) continue
          // 1 セル進むのに要る時間は距離に比例する（速さ km/yr ÷ セル幅 km）
          const lambda = p.expansionKmPerYear / Math.max(1e-6, km)
          if (this.rng.nextFloat() < 1 - Math.exp(-lambda * dtYears)) {
            grow[j] = cid[i]!
            pop[j] = p.seedPopulation
          }
        }
      }
    }
    cid.set(grow)

    // --- 3. 文明ごとの技術と、その効果 ---
    const effs = new Map<number, TechEffect>()
    for (const civ of this.state.civs) {
      const planet = this.measurePlanet(world, civ.id)
      const eff = sumTech(civ.tech)
      effs.set(civ.id, eff)
      this.evolveTech(civ, planet, eff, dtYears)
      civ.energyPerCapita = civ.population > 0 ? p.baseEnergyW + eff.energyW : 0
      civ.population = 0     // 下のセルの走査で数え直す
    }

    // --- 4. 人口と土地利用（★セルごと。所属する文明の技術で決まる）---
    let total = 0, cleared = 0
    for (let y = 0; y < H; y++) {
      const areaM2 = world.grid.cellArea[y]!
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const land = Math.max(0, Math.min(1, lf[i] ?? 0))
        const id = cid[i] ?? 0
        // ★住める判定も同じ閾値で（別々に置くと領域と人口が食い違う。罠 23）
        if (land < p.minLandFraction || id === 0) { pop[i] = 0; use[i] = 0; continue }
        const eff = effs.get(id)
        if (!eff) { pop[i] = 0; use[i] = 0; cid[i] = 0; continue }
        let here = 0
        for (const l of lanes) here += cell[l * n + i] ?? 0
        const u = Math.max(0, Math.min(1, use[i] ?? 0))
        // ★**収量は技術が上げ、複雑さの維持費が削る**（Tainter の収穫逓減）
        const gross = 1 + (p.agricultureGain + eff.yieldGain) * u
        const upkeep = 1 - p.complexityCost * eff.complexity
        const food = (bio[i] ?? 0) * land * areaM2 * p.yieldMolPerM2
          * gross * (upkeep > 0 ? upkeep : 0)
        const k = here > 0 ? food / Math.max(1e-9, p.foodPerPerson) : 0
        // ★**豊かさが出生率を下げる**（人口転換。負のフィードバックが
        //   餓死 1 本だけだと振動する。罠 95）
        const civ = this.state.civs.find((c) => c.id === id)!
        const rich = civ.energyPerCapita / p.demographicTransitionW
        const r = p.growthRate / (1 + rich * rich)
        const before = pop[i] ?? 0
        const seeded = before <= 0 && k > 0 ? p.seedPopulation : before
        const after = logisticStep(seeded, k, r, dtYears)
        pop[i] = after
        total += after
        civ.population += after
        const needM2 = after * p.landPerPersonM2
        const target = Math.min(1, needM2 / Math.max(1, land * areaM2))
        const next = relaxStep(u, target, p.landUseTauYears, dtYears)
        // ★**炭素は「これまでの最大」を超えた分だけ出る**（片道）。
        //   増分（`next > u`）で数えると、土地利用が揺れるたびに足してしまい、
        //   **刻みを細かくするほど CO2 が膨らむ**（実測: 1 万年刻みで 4071ppm、
        //   100 万年刻みで 959ppm）。森は一度切れば、また生えるまで戻らない
        const wasMax = maxUse[i] ?? 0
        if (next > wasMax) {
          cleared += (next - wasMax) * land * areaM2
          maxUse[i] = next
        }
        use[i] = next
      }
    }
    // --- 5. 接触（★重力モデルの、格子での素直な形＝接している長さ）---
    this.contact(world, cid, dtYears)

    for (const c of this.state.civs) {
      if (c.population > c.peakPopulation) c.peakPopulation = c.population
    }
    // ★人口が消えた文明はたたむ（領域も返す）
    for (const civ of this.state.civs) {
      if (civ.population >= 1) continue
      for (let i = 0; i < n; i++) if (cid[i] === civ.id) { cid[i] = 0; pop[i] = 0 }
    }
    this.state.civs = this.state.civs.filter((c) => c.population >= 1)
    this.state.totalPopulation = total
    this.state.energyPerCapita = total > 0
      ? this.state.civs.reduce((a, c) => a + c.energyPerCapita * c.population, 0) / total
      : 0
    // ★**大気へ出す**。CO2 は混ざるので全球（`intervene` の巨大噴火と同じ作法）
    if (cleared > 0 && p.landClearCarbonMolPerM2 > 0) {
      const ppm = cleared * p.landClearCarbonMolPerM2 / 1.775e14
      world.globals.co2 += ppm
      world.ledger.add("co2", ppm, "society.emission")
      this.state.landClearCo2Ppm += ppm
    }
  }

  /**
   * ★**接触**。隣り合った文明のあいだで技術が伝わり、時に征服が起きる。
   *
   * ★重力モデル（規模 × 規模 / 距離）の、格子での素直な形は
   * **「接している境界の長さ」**。長さは km で測るので解像度に依らない
   * （セルを細かくすると本数は増えるが 1 本が短くなる。罠 9 の「線」の扱い）。
   *
   * ★**伝わった技術は由来 id を引き継ぐ。** これで系譜図に
   * 「独立発明（由来が違う）」と「伝播（由来が同じ）」が描き分けられる ——
   * `docs/02` の「機能は収斂する、系統は収斂しない」の文明版。
   */
  private contact(world: World, cid: Uint8Array, dtYears: number): void {
    const p = this.params
    const civs = this.state.civs
    if (civs.length < 2) return
    const { W, H } = world.grid
    // 境界の長さ [km] を文明の組ごとに積む。★添字順に走査（決定論）
    const border = new Map<number, number>()
    const key = (a: number, b: number) => (a < b ? a * 256 + b : b * 256 + a)
    for (let y = 0; y < H; y++) {
      // 経度方向の 1 セルの幅と、緯度方向の幅 [km]
      const dx = (2 * Math.PI * 6371 * Math.cos(world.grid.latRad[y]!)) / W
      const dy = (Math.PI * 6371) / H
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const a = cid[i] ?? 0
        if (a === 0) continue
        const east = cid[y * W + ((x + 1) % W)] ?? 0
        if (east !== 0 && east !== a) {
          border.set(key(a, east), (border.get(key(a, east)) ?? 0) + dy)
        }
        if (y < H - 1) {
          const south = cid[(y + 1) * W + x] ?? 0
          if (south !== 0 && south !== a) {
            border.set(key(a, south), (border.get(key(a, south)) ?? 0) + dx)
          }
        }
      }
    }
    if (border.size === 0) return
    const byId = new Map(civs.map((c) => [c.id, c]))
    const planet = new Map<number, Record<PlanetGate, number>>()
    for (const [k, len] of [...border.entries()].sort((u, v) => u[0] - v[0])) {
      const a = byId.get(Math.floor(k / 256)), b = byId.get(k % 256)
      if (!a || !b) continue
      // --- 技術の伝播（両方向。★片方だけだと「進んだ方が損」になる）---
      for (const [from, to] of [[a, b], [b, a]] as const) {
        if (!planet.has(to.id)) planet.set(to.id, this.measurePlanet(world, to.id))
        const gate = planet.get(to.id)!
        for (let t = 0; t < TECHS.length; t++) {
          if (!from.tech[t] || to.tech[t]) continue
          // ★**前提と惑星の条件は伝播でも免除しない。**
          //   鉄を知っていても、鉱石の無い惑星では作れない
          if (!techPrereqOk(to.tech, t) || !techGateOk(t, gate)) continue
          const lambda = p.techTransferRate * len
          if (this.rng.nextFloat() >= 1 - Math.exp(-lambda * dtYears)) continue
          to.tech[t] = true
          // ★**由来を引き継ぐ**（ここが独立発明との違い）
          to.techOrigin[t] = from.techOrigin[t]!
          this.state.transferred++
        }
      }
      // --- 征服（軍事力の比で決まる）---
      const power = (c: Civ) =>
        (1 + sumTech(c.tech).military) * Math.sqrt(Math.max(1, c.population))
      const pa = power(a), pb = power(b)
      const [strong, weak] = pa >= pb ? [a, b] : [b, a]
      const ratio = Math.max(pa, pb) / Math.max(1e-9, Math.min(pa, pb))
      const lambda = p.conquestRate * len * (ratio - 1)
      if (lambda <= 0) continue
      if (this.rng.nextFloat() >= 1 - Math.exp(-lambda * dtYears)) continue
      // 境界のセルを 1 つ奪う（★添字順に最初に見つかったもの。決定論）
      for (let i = 0; i < world.grid.cellCount; i++) {
        if (cid[i] !== weak.id) continue
        cid[i] = strong.id
        this.state.conquered++
        break
      }
    }
  }

  /** ★知性種が絶滅したとき、すべての文明を畳む */
  private collapseAll(world: World, dtYears: number): void {
    const p = this.params
    if (this.state.totalPopulation <= 0) return
    const pop = world.store.f32("population").read
    const use = world.store.f32("landUse").read
    const cid = world.store.u8("civId").read
    const decay = Math.exp(-dtYears / p.collapseTauYears)
    this.state.totalPopulation *= decay
    for (let i = 0; i < world.grid.cellCount; i++) {
      pop[i] = (pop[i] ?? 0) * decay
      use[i] = relaxStep(use[i] ?? 0, 0, p.landUseTauYears, dtYears)
    }
    for (const c of this.state.civs) c.population *= decay
    if (this.state.totalPopulation < 1) {
      this.state.totalPopulation = 0
      this.state.energyPerCapita = 0
      this.state.civs = []
      cid.fill(0)
    }
  }
}

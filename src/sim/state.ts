/**
 * 惑星の状態とパラメータ。
 *
 * docs/01-2.3: グローバル状態（スカラー）。
 * セルごとの場は FieldStore に、全球のスカラーはここに置く。
 *
 * **超越関数を使う計算はここ（スカラー側）に閉じ込める**（docs/04-8.4b）。
 * セルごとのカーネルは core/fastmath.ts の共有近似だけを使う。
 */

/**
 * 較正で決まる物理パラメータ。
 * 既定値は proto/calibrate.py の 1 次元較正値を出発点にしている。
 * 2 次元では陸海コントラストが入るため scripts/calibrate2d.ts で再較正する。
 */
export interface PlanetParams {
  /** 太陽定数 [W/m²]。現在の地球は 1361 */
  S0: number
  /** 日射の緯度分布 s(x) = 1 + s2·P2(x) */
  s2: number

  /** OLR の切片 [W/m²]（T は degC） */
  A0: number
  /** 実効長波応答 [W/m²/K]。水蒸気・気温減率・雲を込みにした値。プランク応答ではない */
  B: number
  Gco2: number
  Gch4: number
  ch4Ref: number
  /**
   * 窒素の圧力広がりによる温室効果の係数 [W/m²]。ΔF = Gn2·ln(pN2)。
   *
   * **大気が重いと CO2 と H2O の吸収線が圧力広がりで太くなり、温室効果が増す**
   * （Goldblatt et al. 2009, Nature Geoscience）。レイリー散乱が増える冷却効果
   * より広がりの温暖化が勝つ。文献の目安は「N2 を倍にして数 K」。
   *
   * 12 にすると 2 気圧で +8.3 W/m²（B=2.50 なので +3.3K）、3 気圧で +5.3K。
   * 文献の幅の中に入る。**太古代の N2 が現在より多かったかは係争中**
   * （Marty et al. 2013 の化石雨痕と窒素同位体は ≤1.1 気圧を示唆）なので、
   * これを暗い太陽のパラドクスの答えにしてはいけない。
   * **「大気の量」というシナリオのつまみとして持つ。**
   *
   * pN2 = 1 で ΔF = 0 なので、現在の地球の較正は動かない。
   */
  Gn2: number
  /** 基準温度 [degC] */
  T0: number

  Thot: number
  wHot: number
  Tw: number
  hotCap: number

  /** アルベドはすべて雲を含む【惑星】アルベド。表面アルベドではない */
  alphaOcean: number
  alphaLand: number
  alphaIce: number
  /** 氷の臨界温度 [degC] */
  tIce: number
  /** 氷縁の平滑化幅 [K]。季節変化によるぼやけを表す */
  dTIce: number

  /**
   * CH4 を O2 から決めるか。1 = 決める / 0 = `globals.ch4` を手で持つ。
   *
   * **CH4 の寿命は OH ラジカルが決め、OH は O2 に支配される。**
   * 無酸素大気では CH4 が桁で濃くなり、有機ヘイズもそこで生じる。
   *
   * 【なぜ要るか】2026-08-30 以前は `globals.ch4` が 45 億年 100ppm で固定
   * だった（`world.ts` が冥王代の初期値を置くだけで誰も更新しない）。
   * O2 は 20.9% で固定なので**両者は物理的に共存できない**——O2 が
   * 20.9% あれば CH4 は 10 年で酸化される。
   *
   * 結果、`hazeAlbedo` が CH4/CO2 比で立ち上がるため、**CO2 だけが
   * 38,000 → 1,600ppm と落ちる過程で比が上がり、ヘイズが太古代ではなく
   * 顕生代に点灯していた**（顕生代の反射 15.4 W/m²、アルベド +0.05、約 -4.4K）。
   * その冷却が CH4 100ppm の温室効果 +4.4K とほぼ正確に打ち消し合い、
   * 「顕生代 16.5℃ で PASS」という**見かけの正しさ**を作っていた。
   *
   * 地球の履歴を焼き込まず、**O2 の履歴から従属して決まる**形にしてある。
   * M5 で生命が O2 を動かせば、CH4 とヘイズは自動的に正しい時代に現れる。
   */
  ch4FromOxygen: number
  /** O2 が現代値のときの CH4 [ppm]。産業革命前の 0.7（CO2 280 と対にする） */
  ch4Modern: number
  /**
   * CH4 の O2 依存の指数。CH4 ∝ (O2/O2_now)^(-n)。
   *
   * 光化学モデル（Zahnle 1986、Pavlov et al. 2001）では 0.3〜0.5。
   * 産業革命前（O2 20.9%・CH4 0.7ppm）と太古代（O2 ~1e-5 PAL・CH4 約 100ppm）
   * を繋ぐと **0.431**。基準状態では既定の 0.7ppm に一致するので較正は動かない。
   */
  ch4OxygenExponent: number
  /** 無酸素大気での CH4 の上限 [ppm]。O2→0 の発散を止める */
  ch4AnoxicMax: number
  /**
   * CH4 の供給のうち**生命に依らない分**の割合（蛇紋岩化・火山。Kasting 2005）。
   *
   * ★**2026-09-01 に追加。CH4 は「O2 が壊す速さ」だけでは決まらない。**
   * 従来は `CH4 = 現代値 × (O2/現代)^-n` だけで、**メタンを作る生命がいなくても
   * 無酸素なら上限 1000ppm に張り付いた**。そのせいで酸素の機構を有効にすると、
   * 酸素発生型光合成を獲得しなかった惑星（4 本中 2 本）が
   * ヘイズで凍った（顕生代 0.1〜8.0℃）。
   *
   * 正しくは **CH4 = 供給 / 壊す速さ**。供給は
   *   非生物（蛇紋岩化）+ 生物（メタン生成）
   * で、生物側は生物圏の大きさに比例する（`globals.biosphereProxy`）。
   *
   * 【0.1 の根拠】無生物の無酸素惑星（O2 = 1e-6%）でこの式が与える CH4 は
   * `0.1 × 0.7 × (4.8e-8)^-0.431 = 101 ppm` で、
   * **`HADEAN_START.ch4 = 100`（Kasting 2005 の非生物起源メタン）に一致する。**
   * 現代の大気メタンの 1 割程度が非生物・地質起源、という観測とも合う。
   */
  ch4AbioticFraction: number
  /**
   * ヘイズが CH4 を吸い込む強さ（0 で無効）。
   *
   * ★**有機ヘイズは CH4 の光分解生成物が重合した固体で、雨で落ちる。**
   * つまり**ヘイズを作ること自体が CH4 の吸い込み**であり、
   * これが CH4/CO2 比の自己制限になる（Arney et al. 2016）。
   *
   * これが無いと、酸素発生型光合成を獲得しなかった惑星（4 本中 1〜3 本）で
   * CH4 が上限 1000ppm に張り付いたまま CO2 だけが落ち、
   * **比が 0.68 まで上がって顕生代が 8.1℃・氷 16%** で固定された。
   * Arney が扱う比は 0.2 までで、それ以上は光化学が質的に変わる。
   *
   * 【3 の根拠】ヘイズが飽和したとき比を `0.68 / (1+3) = 0.17` に抑える。
   * Arney の最も濃いケース（比 0.2）と同じ桁に収まる。
   */
  hazeCh4Sink: number
  /** 有機ヘイズが立ち上がる CH4/CO2 比。0.1 前後（Zahnle 1986、Arney 2016） */
  hazeRatioCrit: number
  /** その遷移の幅 */
  hazeWidth: number
  /**
   * ヘイズが上げる惑星アルベドの上限。**反温室効果の強さ。**
   *
   * ★**2026-09-01 に 0.22 → 0.12 にした。文献より強すぎた。**
   * アルベドを 0.22 上げると吸収が `0.22 × 340 = 75 W/m²` 減り、
   * `B ≈ 2 W/m²/K` で **約 37K の冷却**になる。
   * これは**球形粒子を仮定した古い見積もり**の側の値。
   *
   * Arney et al. 2016（*The Pale Orange Dot*）は、太古代のヘイズが
   * **フラクタル凝集体**であることを示し、そうすると可視光の散乱が弱く
   * （＝冷却が小さく）紫外線の遮蔽だけが効くので、
   * **冷却は最大 20K 程度**にとどまる。0.12 で約 20K になる。
   *
   * 【効いた場面】酸素発生型光合成を獲得しなかった惑星が、
   * メタン菌の作る CH4 でヘイズを張り、**40 億年ずっと 3.8℃**で凍っていた。
   * 既定（酸素オフ）では CH4/CO2 が 0.001 でヘイズは点灯しないので、
   * **この値を変えても既定の軌跡は動かない。**
   */
  hazeAlphaMax: number

  /** 基準拡散係数（乾燥渦輸送）[W/m²/K] */
  D: number
  /** 潜熱輸送の寄与 */
  kMoist: number
  /** 潜熱輸送が強まるスケール [K] */
  Tq: number
  /**
   * 潜熱輸送の強まりの上限（無次元）。`D_eff = D·(1 + kMoist·lh)` の lh の上限。
   *
   * **指数関数の外挿を止めるためのもの。** 元の式
   *   lh = exp((T − T0)/Tq) − 1
   * は地球近傍（〜28℃）では観測とよく合う——+13K の温暖化で赤道-極の勾配が
   * 41K → 27K（64%）になり、始新世の観測（現在の 60〜70%）と一致する。
   *
   * **だが外挿が効かない。** 78℃ で lh = 22.9、D_eff が 45 倍の 12.3 になり、
   * **惑星が 0.1K 以内の等温になる**（実測）。その結果:
   *   - 海が凝結した瞬間に赤道-極の温度差が 0.35K しかなく、熱塩循環が
   *     生まれた瞬間に塩分枝（逆転循環）へ落ちて **45 億年戻らない**
   *   - 太古代の気候が壊れる
   *
   * 温室気候でも南北勾配はゼロにならない。始新世（平均 +10K）の赤道-極の
   * 海面水温差は 15〜20K である。金星のような等温は 90 気圧の大気の極限で、
   * 1 気圧級の地球型惑星では起きない。
   *
   * 2.5 にすると D_eff の上限が 1.68 になり、78℃ でも勾配が約 11K 残る。
   * 頭打ちは 4 乗のソフトミンで入れるので、**較正済みの領域（〜28℃）は
   * 2% 以内で保たれる。**
   */
  moistMax: number

  /** 実効熱容量 [W*yr/m²/K]。平衡解には影響せず、過渡応答だけに効く */
  cOcean: number
  cLand: number
  cIce: number
}

/**
 * 現在の地球を再現するパラメータ。scripts/calibrate2d.ts が出力する。
 *
 * 2 次元 128x64 での較正結果（4 点同時拘束）:
 *   全球平均 14.50 C   赤道 27.5 C   極 -20.4 C
 *   氷被覆率 0.116 (現実 ~0.11)   惑星アルベド 0.297 (現実 0.29)
 *   ECS 3.00 C (IPCC AR6: 3.0)   収支の不平衡 2e-7 W/m^2
 *
 * 1 次元 (proto/) の A0=209.13 / B=2.2206 から変わっているのは、
 * 2 次元で陸海のアルベドコントラストが入ったため。想定どおりの再較正。
 */
export const EARTH_PARAMS: PlanetParams = {
  S0: 1361,
  s2: -0.477,
  A0: 203.05368,
  B: 2.49752,
  Gco2: 5.35,
  Gch4: 3.0,
  Gn2: 12.0,
  ch4Ref: 1.0,
  T0: 14.5,
  Thot: 25,
  wHot: 1.3,
  Tw: 12,
  hotCap: 120,
  alphaOcean: 0.25,
  alphaLand: 0.34,
  alphaIce: 0.55,
  tIce: -10,
  dTIce: 6,
  ch4FromOxygen: 1,
  ch4Modern: 0.7,
  ch4OxygenExponent: 0.431,
  ch4AnoxicMax: 1000,
  ch4AbioticFraction: 0.1,
  hazeCh4Sink: 3,
  hazeRatioCrit: 0.1,
  hazeWidth: 0.04,
  hazeAlphaMax: 0.12,
  D: 0.28,
  kMoist: 2.0,
  Tq: 20,
  moistMax: 2.5,
  cOcean: 12,
  cLand: 2,
  cIce: 5,
}

/** 時間発展するグローバル状態 */
export interface PlanetGlobals {
  yearsElapsed: number
  /** 現在の太陽定数 [W/m²]。主系列進化で変わる */
  /**
   * 実効の太陽定数 [W/m²]。物理はこれだけを見る。
   * 時間発展する世界では毎ティック `solarConstantForElapsed × solarMultiplier` で上書きされる。
   */
  solarConstant: number
  /**
   * 太陽光度の倍率。プレイヤーのつまみ。
   * 主系列進化に【掛ける】値なので、1.0 のままなら実際の太陽の歴史をなぞる。
   */
  solarMultiplier: number
  co2: number
  ch4: number
  o2: number
  /**
   * 生物起源の雲凝結核（CCN）による雲アルベドのずれ。**現代の地球で 0**。
   *
   * ★**生命が惑星の反射率を変える経路**（Charlson et al. 1987 の CLAW、
   * Rosing et al. 2010）。海洋の生物が出す DMS が雲凝結核になり、
   * 核が多いほど雲粒が細かく**雲が明るくなる**。太古代の生物圏は小さく
   * 真核藻類もいなかったので**核が少なく雲が暗かった** ——
   * 暗い太陽のパラドクスの候補のひとつ。
   *
   * `life.ts` が毎ティック書く。**基準状態（現在の地球）では 0** なので
   * 較正は動かない（`n2Forcing` や `ch4Forcing` と同じ作法）。
   */
  /**
   * **陸上生物による珪酸塩風化の促進**（Berner 1997、Lenton & Watson 2004）。
   * `carbon.ts` の速度論的風化に掛かる倍率。
   *
   * ★**基準状態（現在の地球）で 1**。だから較正は 1 ビットも動かない
   * （`ccnAlbedoShift` と同じ作法）。根と有機酸を持つ陸上植物がいない
   * 世界では 1 を**下回る** —— ★加点ではなく**いない側の減点**で書く
   * （`CLAUDE.md` の 42）。そうすれば現在の地球の較正が動かない。
   *
   * `life.ts` の `publishBioticWeathering` が毎ティック書く。
   */
  bioticWeathering: number
  /** 陸を覆う「根を持つ光合成者」の量（診断。`bioticWeathering` の元） */
  landPlantIndex: number
  ccnAlbedoShift: number
  /**
   * CCN のずれの**目標値**。`life.ts` が生物圏の大きさから決める。
   *
   * ★**目標と実際を分けること。** 生命の刻みは 100 万年、気候の結合は
   * 20 万年（×20）なので、生命が動くたびにずれを**階段状に飛ばす**と、
   * 打ち切った Newton が吸収しきれず**残差が 4.3 W/m² 残った**
   * （2026-09-02 の実測。太古代だけ他の時代の 770 倍）。
   * 気候の刻みごとに `ccnRelaxYears` の時定数でここへ緩和する。
   */
  ccnAlbedoTarget: number
  /**
   * 生物圏の大きさ（現代の地球を 1）。**メタン生成の供給**に使う。
   *
   * 現在の地球から始める世界は 1（現代の生物圏がある）。
   * 冥王代から始める世界は 0 で始まり、生命が育つと `life.ts` が上げる。
   * **これが無いと、生命がいなくても無酸素なら CH4 が上限に張り付く。**
   */
  biosphereProxy: number
  /** 太古代の値は係争中。サンドボックスで露出させる（docs/01-2.5） */
  n2Pressure: number
  seaLevel: number
  /**
   * 表層（海洋）にある水の量。初期量に対する比。docs/01-6.5。
   * 沈み込みでマントルに持ち去られ、火山から戻る。
   * 1990 年には無かった概念で、地球の海水量は数十億年スケールで
   * 減少している可能性がある。テクトニクス様式の判定にも効く（docs/01-6.6a）。
   */
  oceanWaterFraction: number
  /**
   * 水蒸気として大気にある水の量。初期量に対する比。docs/05 M4.7 の積み残し #1。
   *
   * **マグマオーシャン期には液体の海は存在しない。** 地表が溶けているので
   * 水は数百気圧の水蒸気大気として滞留する。マグマオーシャンが終わって
   * 地表が冷えると凝結して海になる（「最初の海」）。
   * 液体の水の証拠は 44 億年前から（Jack Hills のジルコン）。
   *
   * 以前は oceanWaterFraction が t=0 から 1.0 で、マグマオーシャン期にも
   * 現在と同量の液体の海が乗っていた。生命の起源地の判定に効くので直した。
   */
  steamFraction: number
  /**
   * 成層圏エアロゾルによる負の放射強制 [W/m²]。docs/01-3.3 の f_aerosol。
   * 巨大噴火や隕石衝突のダストで生じ、指数的に減衰する短寿命項。
   */
  aerosolForcing: number
  /** エアロゾルの減衰時定数 [yr]。成層圏の滞留時間は 1〜3 年 */
  aerosolDecayYears: number
  /**
   * マントル起源の地表熱流量 [W/m²]。docs/01-6.6。★2026-08-28
   *
   * **気候ソルバはこれを無視していた。** 現在の地球では 0.087 W/m² で
   * 太陽吸収 240 W/m² に対して無視できるが、冥王代は桁が違う:
   *
   * | 様式 | マントル | 地表フラックス |
   * |---|---|---|
   * | マグマオーシャン | 2250℃ | **3730 W/m²**（太陽の 15 倍） |
   * | ヒートパイプ | 1900℃ | 35.4 W/m²（太陽の 15%） |
   * | モバイルリッド | 1350℃ | 0.059 W/m² |
   *
   * 無視した結果、**マントル 2250℃ のマグマオーシャンの惑星が
   * 地表 -19.7℃ で 98% 氷に覆われる**という状態になっていた。
   * Mantle.update が毎ステップ書き込む。
   */
  internalHeatFlux: number
}

export function earthGlobals(): PlanetGlobals {
  return {
    yearsElapsed: 0,
    solarConstant: 1361,
    solarMultiplier: 1,
    co2: 280,
    ch4: 0.7,
    o2: 20.9,
    bioticWeathering: 1,
    landPlantIndex: 0,
    ccnAlbedoShift: 0,
    ccnAlbedoTarget: 0,
    biosphereProxy: 1,
    n2Pressure: 1.0,
    seaLevel: 0,
    oceanWaterFraction: 1,
    steamFraction: 0,
    aerosolForcing: 0,
    aerosolDecayYears: 2,
    // 現在の地球の地殻熱流量。47TW / 5.1e14 m²
    internalHeatFlux: 0.087,
  }
}

/**
 * 太陽光度の主系列進化 (docs/01-2.4)。
 * 40 億年前の太陽は現在の約 70%。「暗い太陽のパラドクス」の出発点。
 */
export function solarConstantAt(ageGa: number, S0now = 1361): number {
  return S0now / (1 + 0.4 * (1 - ageGa / 4.57))
}

/**
 * 太陽が生まれてから地球ができるまでの差 [Ga]。
 * 太陽 4.567 Ga、地球 4.54 Ga なので約 0.03 Ga。
 */
export const SUN_EARTH_AGE_GAP_GA = 0.03

/**
 * ゲーム内経過年数から太陽定数を求める。
 *
 * `solarConstantAt` は【太陽の年齢】を取るので、そのまま経過年数を渡すと逆になる。
 * この関数を通すこと。
 *
 * ゲーム開始時（冥王代、45.4 億年前）は 974 W/m² = 現在の 72%。
 * 現在（経過 45.4 億年）でちょうど 1361 W/m² に戻り、較正が保たれる。
 */
/**
 * 冥王代（45.4 億年前）の初期大気と内部状態。docs/01-2.4, docs/06。
 *
 * 【なぜこの値か】
 * 暗い太陽（974 W/m² = 現在の 72%）の下では、現在の CO2 280ppm だと
 * 平均 −37.5℃ の完全凍結になる。これが「暗い太陽のパラドクス」そのもの。
 * 主流の解決は高 CO2 + CH4 なので、その下限を採る。
 *
 * - CO2 0.1 bar: 冥王代の推定範囲は 0.1〜10 bar (Zahnle et al. 2007)。その下限。
 * - CH4 100 ppm: 蛇紋岩化による【非生物起源】のメタン (Kasting 2005)。
 *   冥王代にメタン菌はいないので、生物起源を仮定してはいけない。
 * - マントル 2250℃: マグマオーシャン。
 *
 * この組み合わせでモデルは平均 +1.6℃・氷率 0.28 を出す。
 * 【氷は極域だけで全球凍結ではない】——液体の水があり、極に氷がある
 * 「冷たい初期地球」(Valley et al. 2002 "A cool early Earth") と整合する。
 * 冥王代の氷河堆積物の証拠は無いが、冥王代の岩石記録自体がほぼ無いので、
 * これは強い反証ではない。最古の氷河堆積物はポンゴラ氷期（約 29 億年前）。
 */
export const HADEAN_START = {
  co2: 100_000,
  ch4: 100,
  /**
   * 冥王代の大気は【無酸素】[%]。
   *
   * ★2026-08-31 まで、`globals.o2` を書き換えるコードが**どこにも無かった**ので
   * 太古代が現代と同じ 20.9% で回っていた。CH4 は `ch4FromOxygen` が決めるため
   * **CH4 も 45 億年ずっと現代の 0.7ppm**で、無酸素の上限 `ch4AnoxicMax` は
   * 一度も使われていなかった。実測でこれが「太古代が寒い」の主因だった。
   * 較正は構築時（現在の地球・O2 20.9%）に済んでいるので、
   * ここで下げても炭素と気候の較正は動かない。
   */
  o2: 1e-6,
  mantleTempC: 2250,
  /**
   * 冥王代の開始時、水は【すべて水蒸気】として大気にある。液体の海は無い。
   * マグマオーシャンを抜けると凝結して海になる（Mantle.update の凝結処理）。
   */
  oceanWaterFraction: 0,
  steamFraction: 1,
  /** 凝結の時定数 [yr]。地質学的には一瞬だが、海面ソルバのために数ステップに散らす */
  condensationTauYears: 1e6,
} as const

export function solarConstantForElapsed(
  yearsElapsed: number, planetAgeYears = 4.54e9, S0now = 1361,
): number {
  void planetAgeYears
  return solarConstantAt(SUN_EARTH_AGE_GAP_GA + yearsElapsed / 1e9, S0now)
}

// ---------------------------------------------------------------------------
// 以下はすべてスカラー計算。Math.exp / Math.log を使ってよいのはここだけ。
// ---------------------------------------------------------------------------

/** CO2 による OLR 減少分 [W/m²] */
export function co2Forcing(p: PlanetParams, co2: number): number {
  return p.Gco2 * Math.log(Math.max(1e-6, co2) / 280)
}

/**
 * 窒素の圧力広がりによる OLR 減少分 [W/m²]。
 * 現在の 1 気圧を基準にゼロ点を取るので、較正は動かない。
 */
export function n2Forcing(p: PlanetParams, n2Pressure: number): number {
  return p.Gn2 * Math.log(Math.max(1e-3, n2Pressure))
}

/** CH4 による OLR 減少分 [W/m²]。現在の 0.7ppm を基準にゼロ点を取る */
export function ch4Forcing(p: PlanetParams, ch4: number): number {
  return p.Gch4 * (Math.log(1 + Math.max(0, ch4) / p.ch4Ref) - Math.log(1 + 0.7 / p.ch4Ref))
}

/**
 * 暴走温室項 [W/m²]。全球平均温度が Thot を超えると加速する。
 * dG/dT が B を上回ると dOLR/dT < 0 となり暴走温室（金星化）。
 *
 * 【局所】温度ではなく全球平均を使うこと。局所温度の指数関数で書くと
 * 熱帯セルだけが局所的に暴走条件に入り、ECS が現実の 4 倍に膨らむ
 * （proto/RESULTS.md 5 節の罠 #1。実際に踏んだ）。
 */
export function runawayForcing(p: PlanetParams, meanT: number): number {
  if (meanT <= p.Thot) return 0
  const g = p.wHot * p.Tw * (Math.exp(Math.min(20, (meanT - p.Thot) / p.Tw)) - 1)
  return Math.min(p.hotCap, Math.max(0, g))
}

/**
 * 有機ヘイズによるアルベド増分 (docs/01-3.3)。
 * CH4/CO2 比が閾値を超えると光化学的にヘイズが生成され、
 * 太陽光を【反射】する（赤外は透過するので温室効果は増えない）。
 *
 * 比ゼロで厳密にゼロになるよう正規化する。素のシグモイドは裾が太く、
 * CH4 が微量でもアルベドが 0.017 残ってしまう（proto/RESULTS.md 5 節）。
 */
/** 現代の大気中の O2 [%]。CH4 の光化学の基準 */
export const O2_MODERN_PERCENT = 20.9

/**
 * O2 から CH4 の定常濃度を決める [ppm]。`ch4OxygenExponent` のコメントを読むこと。
 *
 * O2 が 0 に近づくと発散するので `ch4AnoxicMax` で頭を打つ。
 */
/**
 * 大気 CH4 の定常濃度 [ppm]。**供給 ÷ 壊す速さ。**
 *
 * @param o2Percent  大気の O2 [%]。壊す速さ（OH ラジカル）を決める
 * @param biosphere  生物圏の大きさ（現代の地球を 1）。**メタン生成の供給**。
 *                   0 なら非生物起源だけ（`ch4AbioticFraction`）
 */
export function ch4FromOxygen(
  p: PlanetParams, o2Percent: number, biosphere = 1, co2 = 0,
): number {
  const pal = Math.max(1e-12, o2Percent / O2_MODERN_PERCENT)
  // 供給の割合（現代を 1）。生物圏が現代より大きければ 1 を超えうる
  const bio = biosphere < 0 ? 0 : biosphere > 2 ? 2 : biosphere
  const supply = p.ch4AbioticFraction + (1 - p.ch4AbioticFraction) * bio
  const v0 = p.ch4Modern * supply * Math.pow(pal, -p.ch4OxygenExponent)
  let v = v0 > p.ch4AnoxicMax ? p.ch4AnoxicMax : v0
  if (p.hazeCh4Sink > 0 && co2 > 0) {
    // 陰的な釣り合い（ヘイズが濃いほど CH4 が減り、CH4 が減るとヘイズが薄まる）。
    // **反復回数は固定**にすること。収束判定で回すと機械の丸めで回数が変わり、
    // 決定論が壊れる（docs/04-6）。単調なので 6 回で十分に落ち着く
    for (let k = 0; k < 6; k++) {
      const h = hazeFraction(p, v / co2)
      const w = v0 / (1 + p.hazeCh4Sink * h)
      v = w > p.ch4AnoxicMax ? p.ch4AnoxicMax : w
    }
  }
  return v
}

/** ヘイズの濃さ 0..1（比 CH4/CO2 のシグモイド）。アルベドと CH4 の吸い込みが共有する */
export function hazeFraction(p: PlanetParams, ratio: number): number {
  const sig = (r: number) => 1 / (1 + Math.exp(-(r - p.hazeRatioCrit) / p.hazeWidth))
  const s0 = sig(0)
  const v = (sig(ratio) - s0) / (1 - s0)
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export function hazeAlbedo(p: PlanetParams, co2: number, ch4: number): number {
  return p.hazeAlphaMax * hazeFraction(p, ch4 / Math.max(1e-9, co2))
}

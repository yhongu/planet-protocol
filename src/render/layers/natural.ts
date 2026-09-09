/**
 * 自然な見た目のレイヤ（docs/05 M4.7 #3、docs/03-3.4c）。
 *
 * ★**他の 17 レイヤは全部【診断用】で、「惑星を見る」画面が無かった。**
 * フェーズ1 の合格条件は「**生命抜きで 45 億年を眺めて面白いか**」なので、
 * それを判断する画面がまず要る。
 *
 * ## 何を混ぜるか
 *
 * | 要素 | 出典 | なぜ |
 * |---|---|---|
 * | 海の深さ | `elevation` | 浅い棚と深海の差が大陸の形を語る |
 * | 海氷・氷床 | `iceFraction` | 氷期がひと目で分かる |
 * | 陸の乾湿 | `soilMoisture` | 砂漠と湿潤帯 |
 * | 生命 | `biomassTotal` | **緑は生命がいるところにしか出さない** |
 * | 起伏 | `elevation` の勾配 | 山脈を立体的に見せる |
 * | マグマ | `LayerEnv.oceanWaterFraction` | 冥王代は海ではなく溶けた岩 |
 *
 * ★**先カンブリア時代の陸を緑にしてはいけない。** 陸上植物が現れるまで
 * 大陸は岩と砂であって、灰褐色〜赤褐色である。緑は `biomassTotal` が
 * 陸にあるときだけ乗せる —— **生命が惑星を変えたことが目で分かる**ようにする。
 */
import type { Grid } from "../../core/grid"
import type { FieldStore } from "../../core/fields"
import { sampleBilinear } from "./index"
import type { LayerEnv } from "../planetView"

type Rgb = readonly [number, number, number]

/**
 * ★**表示用の平滑化。** 海底地形も氷縁もセルごとに揺らぐので、
 * そのまま色にすると海が「くしゃくしゃの金属箔」、氷が「破れた紙」に見える
 * （どちらも実測でそうなった）。**5 点平均で均してから着色する。**
 * これは見た目だけの処理で、シムの場は一切触らない。
 */
function sampleSmooth(
  f: Float32Array, W: number, H: number, fx: number, fy: number, r: number,
): number {
  // 9 点（中心 + 4 近傍 + 4 斜め）。5 点では海のセル斑が残った
  const c = sampleBilinear(f, W, H, fx, fy)
  const n = sampleBilinear(f, W, H, fx, fy - r) + sampleBilinear(f, W, H, fx, fy + r)
    + sampleBilinear(f, W, H, fx - r, fy) + sampleBilinear(f, W, H, fx + r, fy)
  const d = sampleBilinear(f, W, H, fx - r, fy - r) + sampleBilinear(f, W, H, fx + r, fy - r)
    + sampleBilinear(f, W, H, fx - r, fy + r) + sampleBilinear(f, W, H, fx + r, fy + r)
  return (c * 4 + n * 2 + d) / 16
}

/**
 * 氷の割合 → 見た目の白さ。**線形に混ぜないこと。**
 * セル平均の氷 50% は「半分白い」ではなく「氷縁がある」状態なので、
 * 立ち上がりを遅らせる（0.25 で薄く、0.8 でほぼ真っ白）。
 */
function iceCover(f: number): number {
  // ★立ち上がりを緩くする。急だと氷縁が「破れた紙」になる
  const t = Math.max(0, Math.min(1, (f - 0.1) / 0.75))
  return Math.pow(t, 0.9)
}

/**
 * ★**ピクセル・ファースト。** 混色を【段】に量子化して、色数を落とす。
 *
 * もとの実装は混色が連続だったので、128x64 の 1 枚に **18049 色**あった。
 * 拡大すると海岸線が 4 ピクセルの grad になって「溶けた」ように見える
 * （ピクセルアートの目安は 64 色以下）。
 *
 * ★**バイリニアの補間は残す。** 段にするのは【色】であって【場】ではない。
 * 場を最近傍にするとセル境界の階段が出る（この実装が最初に避けたもの）。
 * 補間した場を段の色に落とすと、**海岸線は曲線のまま、色はベタ**になる。
 *
 * 端数は 4x4 の Bayer でディザする。切り捨てると段の境界が
 * 「等高線の帯」になって地図記号に見えるが、ディザすると
 * **ドット絵のグラデーション**になる（実測でそう見えた）。
 *
 * これは**出力 RGBA の段でだけ**掛かる表示処理で、場には一切戻らない
 * （`rasterSmoothing` で踏んだ経路——`CLAUDE.md` の 37——とは別物）。
 */
const BAYER4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]

/**
 * ★**ディザを掛けるのは「境目」だけ。連続の傾きには掛けない。**
 *
 * 海の深さのように**どこでも段の途中**にある量にディザを掛けると、
 * 画面いっぱいがドットの砂嵐になった（海が「ノイズ」に見える）。
 * 傾きは**ベタの段**にして、ディザは汀線と氷縁だけに使う。
 */
const SOLID = 0.5

/** 混合の重み t を n 段に落とす。d は 0..1 のディザ量（`SOLID` で四捨五入） */
function band(t: number, n: number, d: number): number {
  const x = Math.max(0, Math.min(1, t)) * (n - 1)
  const k = Math.max(0, Math.min(n - 1, Math.floor(x + d)))
  return k / (n - 1)
}

/**
 * 段の数。**ここが「ドット絵らしさ」のつまみ**。
 * 実測（`probe-pixel.ts` の色数）: 段なし 18049 → この設定で 200 前後。
 * 陰影を 3 段より増やすと山が「泥」に戻る
 */
const BANDS = {
  /** 海の深さ。大陸棚・外洋・深海が読めるだけあればよい */
  sea: 5,
  /** 陸の乾湿。砂漠・半乾燥・湿潤・森 */
  soil: 4,
  /** 高地の露岩 */
  highland: 3,
  /** 生命の緑。薄い所と濃い所が分かればよい */
  life: 4,
  /**
   * 氷。★**ここもベタにする。** ディザにしたら、氷の割合が 0.1 の海面
   * （つまり**ほぼ全部の海**）に白い点が撒かれて、太古代の惑星が
   * 一面の砂嵐になった（実測）。氷は既に強く均してあるので、
   * ベタの段でも氷縁は滑らかな曲線になる
   */
  ice: 6,
  /** 溶岩 */
  lava: 5,
  /** ★陰影は 3 段（暗い・素・明るい）。連続だと山が泥になる */
  shade: 3,
  /** ★陸と海の境。2 段 = **ディザの海岸線**。ここが一番効く */
  coast: 2,
} as const

/**
 * ★**ドット 1 個ぶんの陸／海は描かない。**
 *
 * 45 億年回した惑星では、外洋のセルの多くが `landFraction ≒ 1/16` を持つ
 * （粒子が薄く広がるため）。連続の混色なら 6% の茶色は青に溶けて見えなかったが、
 * ディザにすると **1 セルにつき 1 ドットの陸**として立ち、
 * **外洋一面が規則正しい点々**になった（実測: `look-08-now.png`）。
 *
 * `ss = 4` では 1 セルが 16 ドットなので、**2 ドット未満は捨てる**。
 * 海岸（0.3〜0.9）はほとんど動かない。海の中の孤立ドットだけが消える。
 *
 * ★これは**描画だけの床**で、物理の `landFraction` には触らない。
 * アルベドも風化も元の値を使い続ける（`CLAUDE.md` の 37 と同じ線引き）。
 */
const COAST_GAIN = 8

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
]

/** 海: 浅瀬の明るい青緑 → 外洋の青 → 深海の紺 */
const SHALLOW: Rgb = [86, 152, 176]
const DEEP: Rgb = [26, 58, 104]
const ABYSS: Rgb = [16, 34, 68]
/** 陸: 乾いた岩 → 湿った岩（先カンブリア時代の色。緑は生命が乗せる） */
const ROCK_DRY: Rgb = [150, 126, 96]
const ROCK_WET: Rgb = [96, 84, 68]
/** 高地の露岩と雪 */
const HIGHLAND: Rgb = [126, 118, 110]
const SNOW: Rgb = [236, 240, 246]
/** 生命の緑（陸）と海の植物プランクトン */
const VEG: Rgb = [78, 132, 58]
const BLOOM: Rgb = [46, 122, 118]
/** 溶けた岩 */
const BASALT: Rgb = [46, 34, 30]
const LAVA: Rgb = [255, 148, 62]
/** 冷めかけの溶岩（噴出して間もない黒い玄武岩に赤が残る） */
const LAVA_COOL: Rgb = [148, 62, 34]

/**
 * ★**火成活動は【セルごと】に描く。全球の海の割合で決めない。**
 *
 * それまで溶岩は `1 - oceanWaterFraction` だけで混ぜていたので、
 * **最初の海ができた瞬間に、溶岩が 1 ピクセルも描かれなくなった**。
 * そのときマントルは 1650℃ のスクイッシーリッドで、地殻の生産も
 * 始まっている —— **見えていないだけで、惑星は激しく噴いている**。
 *
 * 実際の冥王代〜太古代前期は、海と溶岩が同居している状態のはず
 * （ヒートパイプ = Io 型の再舗装。液体の海と活発な火成活動は両立する）。
 *
 * ★**2 つに分ける。地殻年代だけでは足りなかった。**
 * 40Myr 時点で **12Myr 未満の地殻は 7% しかない**（海嶺の生産が 25Myr に
 * 始まったばかりで、若い地殻がまだ作られていない）。実測でほぼ何も光らなかった。
 *
 *   1. **熱い地面**（マントル温度から。全球）—— ヒートパイプは
 *      蓋【全体】を舗装し直すので、地表そのものが玄武岩で熱い
 *   2. **噴いたばかりの斑**（地殻年代から。セルごと）—— 明るく光る
 *
 * ★現在の地球（マントル約 1350℃）ではどちらの項も厳密に 0 になるので、
 * **現代の見た目は 1 ピクセルも変わらない**（基準状態を動かさない。
 * 実測で色数 111 のまま）。
 */
/** これより若い地殻は「噴いたばかり」[Myr] */
const FRESH_AGE_MYR = 12
/** 溶岩が地表に出ている度合いが立ち上がるマントル温度 [℃]。
 *  現在の地球は 1350℃ なので、下限はそれより上に置くこと */
const GLOW_T0 = 1420, GLOW_T1 = 1750

export function renderNatural(
  grid: Grid, store: FieldStore, out: Uint8ClampedArray, ss: number, env: LayerEnv,
): void {
  const { W, H } = grid
  const e = store.f32("elevation").read
  const ice = store.f32("iceFraction").read
  // ★**陸と海の判定は `landFraction`（サブグリッド）で行う。**
  //
  // セル平均の標高で判定すると、粒子の標本ノイズ（±700m）が海面をまたいで
  // **セル単位で陸と海が入れ替わり、氷に覆われた微小な島の集合に見える**
  // （実測で 4 回パレットを直しても消えなかった）。
  // 物理側（アルベド・風化）は `landFraction` を使っているので、
  // **描画もそちらに合わせるのが正しい**。0..1 なので混ぜられる。
  const lfField = store.has("landFraction") ? store.f32("landFraction").read : null
  const soil = store.f32("soilMoisture").read
  const bio = store.has("biomassTotal") ? store.f32("biomassTotal").read : null
  // ★★**文明を惑星の絵に描き込む**（2026-09-09）。
  //   実際に遊んだ報告:「惑星レイヤーのまま降下したけど何も変わらなくて見栄えが悪い」。
  //   **文明レイヤに切り替えないと見えない**のでは、降りた意味が薄い。
  //   農地は色を変え、人口の濃い所は**夜の光**のように点る
  const civPop = store.has("population") ? store.f32("population").read : null
  const civUse = store.has("landUse") ? store.f32("landUse").read : null
  let popRef = 0
  if (civPop) {
    for (let i = 0; i < grid.cellCount; i++) if (civPop[i]! > popRef) popRef = civPop[i]!
    popRef = Math.max(1, popRef)
  }
  const OW = W * ss, OH = H * ss
  const inv = 1 / ss
  const ocean = Math.max(0, Math.min(1, env.oceanWaterFraction))
  const glow = Math.max(0, Math.min(1, (env.mantleTempC - 1350) / 900))
  // ★セルごとの火成活動。地殻年代が無い盤面（M0 のスナップショット）では
  // 使わない —— **無い場を読んで落ちるより、光らせない方がよい**
  const ageF = store.has("crustAge") ? store.f32("crustAge").read : null
  const hotMantle = Math.max(0, Math.min(1,
    (env.mantleTempC - GLOW_T0) / (GLOW_T1 - GLOW_T0)))
  // 生物量は 0..1 だが実際は薄いので、上位を基準に正規化する
  let bioRef = 0
  if (bio) {
    for (let i = 0; i < grid.cellCount; i++) if (bio[i] > bioRef) bioRef = bio[i]
    bioRef = Math.max(1e-6, bioRef)
  }

  for (let py = 0; py < OH; py++) {
    const fy = (py + 0.5) * inv - 0.5
    const brow = (py & 3) * 4
    let o = py * OW * 4
    for (let px = 0; px < OW; px++) {
      const fx = (px + 0.5) * inv - 0.5
      // ★ディザ量。**アートピクセルの座標**で引く（グリッド座標ではない）ので、
      // 拡大しても模様が動かず、ドットの目が揃う
      const d = (BAYER4[brow + (px & 3)] + 0.5) / 16
      const h = sampleBilinear(e, W, H, fx, fy)
      // 海の色と氷は【均した場】で決める（陸の起伏は均さない）
      // ★海の色は【大きく均した場】で決める。
      //
      // 粒子から求めたセル平均の厚さには **1/√n ≒ 10% の標本ノイズ**があり
      // （1 セル 97.7 粒子）、海洋地殻 7km に対して **±700m の偽の海底地形**になる。
      // 半径 1〜2 セルの平滑化では消えず、海が斑に見えた（実測で 3 回踏んだ）。
      // 大陸棚の構造（数百 km）は残り、セル規模のノイズだけ消える半径を採る。
      const hSmooth = (sampleSmooth(e, W, H, fx, fy, 2.5)
        + sampleSmooth(e, W, H, fx, fy, 4.5)) / 2
      // ★氷は**強めに均す**。氷縁のセルはほぼ二値（0 か 1）なので、
      // 弱い平滑化では「破れた紙」の斑が残る（実測で 2 回踏んだ）
      const ic = Math.max(0, Math.min(1,
        (sampleSmooth(ice, W, H, fx, fy, 1.3) + sampleSmooth(ice, W, H, fx, fy, 2.6)) / 2))
      const bm = bio ? Math.max(0, sampleBilinear(bio, W, H, fx, fy)) / bioRef : 0
      // 陸の割合（サブグリッド）。無ければ標高で代用する
      // ★**混合の重みを平滑化しないこと。** 陸の割合を均してから混ぜると、
      // 孤立した陸が薄まって**大陸がほとんど見えなくなる**（実測）。
      // 均すのは氷と海底地形（斑の元）だけでよい
      // ★**陸海は「補間した割合を 0.5 で切る」。セル内にばら撒かない。**
      //
      // 最初はセルごとの割合を 4x4 の Bayer に落としていた（面積に忠実）。
      // ところが 45 億年回した惑星では**陸が薄く広がる** —— 実測（顕生代・96x48）
      // でセルの **44% が 2/16〜6/16**、12/16 を超えるセルは **0.1% しか無い**。
      // 面積に忠実にばら撒くと、そういうセルは**散らばった 3〜6 ドット**になり、
      // 惑星全体が**緑の紙吹雪**に見えた。
      //
      // しかも**数字と食い違っていた** —— ダッシュボードの陸地面積は
      // `elevation >= 0` で 6.5% なのに、地図は 18.6% ぶんの陸ドットを撒いていた。
      // **地図は数字と同じことを言わなければならない。**
      //
      // 補間してから 0.5 で切ると、海岸線は連続した線になり、
      // 汀線の 1〜2 ピクセルだけがディザで砕ける。
      const lfHere = lfField
        ? Math.max(0, Math.min(1, sampleBilinear(lfField, W, H, fx, fy)))
        : (h >= 0 ? 1 : 0)
      // ★0.5 を中心に急な S 字で切る。gain が大きいほど汀線が硬くなる。
      //   4 だと汀線が 1/4 セル（`ss = 4` で 1 ピクセル）になり、ちょうどよい
      const land = Math.max(0, Math.min(1, (lfHere - 0.5) * COAST_GAIN + 0.5))
      // ★**割合を真偽値にしない**（`CLAUDE.md` の 21 を描画にも適用）。
      // 陸 0.4 のセルを「海」と描くと、揺らぎがそのまま斑になる。
      // 海の色と陸の色を両方作って、**陸の割合で混ぜる**。
      let sea: Rgb
      {
        // 海（または溶けた岩）。★海底地形を海面の色にしない（±700m の
        // 標本ノイズが出る）。大きく均した場で、浅い縁だけを明るくする
        const shelf = Math.max(0, 1 - -hSmooth / 300)
        const deep = Math.min(1, Math.max(0, -hSmooth - 300) / 6000)
        sea = mix(DEEP, SHALLOW, band(shelf * shelf * 0.92, BANDS.sea, SOLID))
        sea = mix(sea, ABYSS, band(deep, BANDS.sea, SOLID) * 0.12)
        if (ocean < 1) {
          // ★下限を上げる。浅い所を暗くしすぎると、周りの深海だけが光って
          // **大陸と浅瀬が「黒い穴」に見える**（実測で 2 回踏んだ）
          const heat = (0.5 + 0.5 * Math.min(1, -h / 5000)) * (0.4 + 0.6 * glow)
          sea = mix(sea, mix(BASALT, LAVA, band(Math.pow(heat, 0.7), BANDS.lava, SOLID)), 1 - ocean)
        } else {
          sea = mix(sea, BLOOM, band(Math.min(0.45, bm * 0.5) / 0.45, BANDS.life, SOLID) * 0.45)
          // ★浅い海の熱い海底。**深海では光らせない**（水が厚いほど見えない）。
          // 海と溶岩が同居している時代を、海側にも 1 段だけ出す
          if (hotMantle > 0) {
            const shallowOnly = Math.max(0, 1 - -hSmooth / 1200)
            sea = mix(sea, LAVA_COOL,
              band(hotMantle * shallowOnly, BANDS.lava, SOLID) * 0.4)
          }
        }
        sea = mix(sea, SNOW, band(iceCover(ic), BANDS.ice, SOLID) * 0.74)
      }
      let rockC: Rgb
      {
        const wet = Math.max(0, Math.min(1, sampleBilinear(soil, W, H, fx, fy)))
        let rock = mix(ROCK_DRY, ROCK_WET, band(wet, BANDS.soil, SOLID))
        rock = mix(rock, HIGHLAND, band((h - 1200) / 2500, BANDS.highland, SOLID))
        // ★緑は生命がいるところにだけ。先カンブリア時代の陸は岩と砂
        rockC = mix(rock, VEG, band(Math.min(0.75, bm * 0.9) * wet / 0.75, BANDS.life, SOLID) * 0.75)
        rockC = mix(rockC, SNOW, band(iceCover(ic) * 0.96 + ic * 0.12, BANDS.ice, SOLID))
        // ★**火成活動。** 氷より後に乗せる —— 溶岩の上に雪は積もらない
        if (hotMantle > 0) {
          // (1) 熱い地面。玄武岩に寄せて、わずかに赤を差す
          rockC = mix(rockC, LAVA_COOL, band(hotMantle, BANDS.lava, SOLID) * 0.55)
          // (2) 噴いたばかりの斑。★年代は補間しない
          //     （隣のセルへにじむと溶岩原が広がって見える）
          if (ageF) {
            const a = ageF[(Math.max(0, Math.min(H - 1, Math.round(fy)))) * W
              + (((Math.round(fx) % W) + W) % W)]
            const fresh = Math.max(0, 1 - a / FRESH_AGE_MYR)
            const g = band(fresh * hotMantle, BANDS.lava, d)
            if (g > 0) rockC = mix(rockC, LAVA, g * 0.85)
          }
        }
        if (ocean < 1) {
          // ★マグマオーシャン期は**陸も溶けている**。暗くしすぎると
          // 大陸が「黒い穴」に見える（実測でそうなった）
          const lava = mix(BASALT, LAVA, band(0.62 * (0.4 + 0.6 * glow), BANDS.lava, SOLID))
          rockC = mix(rockC, lava, 1 - ocean)
        }
      }
      // ★**海岸線をディザで切る。** 連続で混ぜると陸と海の間に
      // 4 ピクセルの grad ができて、拡大したとき「溶けた」ように見えた。
      // 2 段 + Bayer なら、**海岸は硬い線になり、汀線だけがドットで砕ける**
      const c = mix(sea, rockC, band(land, BANDS.coast, d))

      // --- 陰影（山脈を立体に見せる）---
      let shade = 1
      if (land >= 0.5 || ocean < 1) {
        const dzdx = sampleBilinear(e, W, H, fx + 1, fy) - sampleBilinear(e, W, H, fx - 1, fy)
        const dzdy = sampleBilinear(e, W, H, fx, fy + 1) - sampleBilinear(e, W, H, fx, fy - 1)
        const s = (-dzdx * 0.6 - dzdy * 0.8) / 900
        // ★3 段（暗い・素・明るい）。連続の陰影は山を「泥」にする
        shade = 0.78 + 0.22 * 2 * band((Math.max(-0.4, Math.min(0.4, s)) + 0.4) / 0.8,
          BANDS.shade, SOLID)
      }
      // ★**文明**。農地は黄土色に寄り、人口の濃い所は点として光る。
      //   ★**セル内にばら撒かず、補間した値で塗る**（罠 82: 地図は数字と
      //   同じことを言う）。光の点だけはディザで散らす —— 都市は「点」なので
      let cr = c[0] * shade, cg = c[1] * shade, cb = c[2] * shade
      // ★**補間しない。** 文明は陸の 1% 未満しか占めないので、
      //   `sampleBilinear` で均すと**周りに溶けて消える**
      //   （罠 32「混合の重みは均してはいけない」と同じ形。実測で見えなかった）
      const ci = Math.min(H - 1, Math.max(0, Math.round(fy))) * W
        + ((Math.round(fx) % W) + W) % W
      // ★**陸の判定はセルの値で行う**（補間した `land` と食い違わないように）。
      //   ★絵を見て「光の点が海にはみ出している」と思ったが、**数字で見たら
      //   文明のセルは全部陸だった**（陸 50〜95%）—— 陸の割合が中途半端な
      //   セルは絵でも海と陸が混じるので、そう見えただけ。
      //   **絵の印象で判断せず、値を見ること**（今日 2 回外した）
      const civLand = lfField ? (lfField[ci] ?? 0) : (e[ci]! >= 0 ? 1 : 0)
      if (civPop && civUse && civLand >= 0.5 && land >= 0.5) {
        const u = Math.max(0, Math.min(1, civUse[ci] ?? 0))
        if (u > 0.02) {
          // 農地（黄土色）。土地利用の割合で混ぜる
          const t = Math.min(1, u * 1.2)
          cr = cr * (1 - t) + 168 * t
          cg = cg * (1 - t) + 150 * t
          cb = cb * (1 - t) + 92 * t
        }
        const pn = Math.max(0, civPop[ci] ?? 0) / popRef
        // ★**都市の光は「点」**。強さで面を塗ると惑星が黄色くなるので、
        //   ディザの閾値を人口密度で決めて**点の密度**にする（罠 60 の作法）
        if (pn > 0.05 && d < Math.min(0.6, Math.pow(pn, 0.6))) {
          cr = cr * 0.35 + 255 * 0.65
          cg = cg * 0.35 + 220 * 0.65
          cb = cb * 0.35 + 150 * 0.65
        }
      }
      out[o] = cr
      out[o + 1] = cg
      out[o + 2] = cb
      out[o + 3] = 255
      o += 4
    }
  }
}

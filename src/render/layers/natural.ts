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
  const OW = W * ss, OH = H * ss
  const inv = 1 / ss
  const ocean = Math.max(0, Math.min(1, env.oceanWaterFraction))
  const glow = Math.max(0, Math.min(1, (env.mantleTempC - 1350) / 900))
  // 生物量は 0..1 だが実際は薄いので、上位を基準に正規化する
  let bioRef = 0
  if (bio) {
    for (let i = 0; i < grid.cellCount; i++) if (bio[i] > bioRef) bioRef = bio[i]
    bioRef = Math.max(1e-6, bioRef)
  }

  for (let py = 0; py < OH; py++) {
    const fy = (py + 0.5) * inv - 0.5
    let o = py * OW * 4
    for (let px = 0; px < OW; px++) {
      const fx = (px + 0.5) * inv - 0.5
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
      const land = lfField
        ? Math.max(0, Math.min(1, sampleBilinear(lfField, W, H, fx, fy)))
        : (h >= 0 ? 1 : 0)
      // ★**割合を真偽値にしない**（`CLAUDE.md` の 21 を描画にも適用）。
      // 陸 0.4 のセルを「海」と描くと、揺らぎがそのまま斑になる。
      // 海の色と陸の色を両方作って、**陸の割合で混ぜる**。
      let sea: Rgb
      {
        // 海（または溶けた岩）。★海底地形を海面の色にしない（±700m の
        // 標本ノイズが出る）。大きく均した場で、浅い縁だけを明るくする
        const shelf = Math.max(0, 1 - -hSmooth / 300)
        const deep = Math.min(1, Math.max(0, -hSmooth - 300) / 6000)
        sea = mix(DEEP, SHALLOW, shelf * shelf * 0.92)
        sea = mix(sea, ABYSS, deep * 0.12)
        if (ocean < 1) {
          // ★下限を上げる。浅い所を暗くしすぎると、周りの深海だけが光って
          // **大陸と浅瀬が「黒い穴」に見える**（実測で 2 回踏んだ）
          const heat = (0.5 + 0.5 * Math.min(1, -h / 5000)) * (0.4 + 0.6 * glow)
          sea = mix(sea, mix(BASALT, LAVA, Math.pow(heat, 0.7)), 1 - ocean)
        } else {
          sea = mix(sea, BLOOM, Math.min(0.45, bm * 0.5))
        }
        sea = mix(sea, SNOW, iceCover(ic) * 0.74)
      }
      let rockC: Rgb
      {
        const wet = Math.max(0, Math.min(1, sampleBilinear(soil, W, H, fx, fy)))
        let rock = mix(ROCK_DRY, ROCK_WET, wet)
        rock = mix(rock, HIGHLAND, Math.min(1, Math.max(0, (h - 1200) / 2500)))
        // ★緑は生命がいるところにだけ。先カンブリア時代の陸は岩と砂
        rockC = mix(rock, VEG, Math.min(0.75, bm * 0.9) * wet)
        rockC = mix(rockC, SNOW, iceCover(ic) * 0.96 + ic * 0.12)
        if (ocean < 1) {
          // ★マグマオーシャン期は**陸も溶けている**。暗くしすぎると
          // 大陸が「黒い穴」に見える（実測でそうなった）
          const lava = mix(BASALT, LAVA, 0.62 * (0.4 + 0.6 * glow))
          rockC = mix(rockC, lava, 1 - ocean)
        }
      }
      const c = mix(sea, rockC, land)

      // --- 陰影（山脈を立体に見せる）---
      let shade = 1
      if (land >= 0.5 || ocean < 1) {
        const dzdx = sampleBilinear(e, W, H, fx + 1, fy) - sampleBilinear(e, W, H, fx - 1, fy)
        const dzdy = sampleBilinear(e, W, H, fx, fy + 1) - sampleBilinear(e, W, H, fx, fy - 1)
        const s = (-dzdx * 0.6 - dzdy * 0.8) / 900
        shade = 1 + Math.max(-0.4, Math.min(0.4, s))
      }
      out[o] = c[0] * shade
      out[o + 1] = c[1] * shade
      out[o + 2] = c[2] * shade
      out[o + 3] = 255
      o += 4
    }
  }
}

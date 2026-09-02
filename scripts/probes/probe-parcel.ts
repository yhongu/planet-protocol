/**
 * 地殻パーセル（粒子）表現の試作。**docs/01-6.2 が最初から指定していた方式。**
 *
 *   npx vite-node scripts/probes/probe-parcel.ts [--myr 500] [--parcels 200000]
 *
 * 【何を確かめるか】
 * セルごとの場では、造山も侵食も堆積も 4 近傍しか見ないので、1 セル 400km では
 * どの機構も大陸の規模から見ると拡散になる。実測で**厚さの分散が 76 km²
 * （地球 218）から動かず、16 機構を 4 seed で当たって全部有意差なし**だった。
 *
 * 粒子なら大陸は粒子の集団として一緒に動き、**衝突は粒子が同じセルに
 * 重なること**として自動的に出る。造山速度も前縁制限も要らない。
 *
 * **この試作には造山も侵食も入れていない。** 入れるのは
 *   1. 剛体プレートの回転（粒子を連続座標で動かす。数値拡散ゼロ）
 *   2. 海嶺: 隙間ができたら玄武岩質の粒子で埋める（厚さはマントル温度が決める）
 *   3. 沈み込み: 重なったら【玄武岩質の粒子だけ】消す。珪長質は消さない
 * これだけで二峰性が出るかを見る。出れば表現の問題だと確定する。
 */
import { Grid } from "../../src/core/grid"
import { FieldStore } from "../../src/core/fields"
import { generateTerrain, DEFAULT_TERRAIN } from "../../src/worldgen/terrain"
import { WORLD_FIELDS } from "../../src/sim/world"
import { Tectonics, EARTH_TECTONICS } from "../../src/sim/tectonics"
import { Rng, Stream } from "../../src/core/rng"

const arg = (k: string, d: number) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? Number(process.argv[i + 1]) : d
}
const argS = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? process.argv[i + 1] : d
}
const W = arg("width", 96), H = W >> 1
const MYR = arg("myr", 500)
const DT = arg("dt", 1)                    // Myr / step
const SEED = argS("seed", "audit")
const NP = arg("parcels", 200_000)
const PLATES = arg("plates", 12)
const PLATE_SPEED = arg("platespeed", EARTH_TECTONICS.plateSpeed)
/**
 * 島弧の生成 [km³/yr]。0 で無効。**速度に依存する過程**——
 * これが無いと、粒子の試作はプレート速度に一切応答しない
 * （沈み込みの規則だけなら「到達の速さ」しか変わらないため）。
 */
const ARC_RATE = arg("arcrate", 0)
/**
 * 島弧の生成を【沈み込みフラックスに比例】させるか。1 = 比例（物理的） / 0 = 全球固定。
 *
 * 全球で固定すると、プレートを増やしても同じ量が長い境界に薄まるだけで
 * **プレート数に応答しない**（実測: 分散 172 / 185 / 184）。
 * 実際の島弧マグマの量は沈み込むスラブの量に比例する。
 * 比例係数は「基準の配置で 2 km³/yr」になるよう決める（下の ARC_EFFICIENCY）。
 */
const ARC_FLUX = arg("arcflux", 0)
/**
 * 沈み込んだ海洋地殻の体積に対する島弧の生成量の比。
 * 基準（12 枚・5cm/yr）で沈み込みが約 110 km³/yr なので、
 * 2 km³/yr にするには 0.018。
 */
const ARC_EFFICIENCY = arg("arceff", 0.018)
/** 侵食の強さ [km/(km·yr)]。0 で無効。本体の denudationRate と同じ単位 */
const DENUD = arg("denud", 0)
const EARTH_R = 6.371e6
/** マントルポテンシャル温度 [℃]。海洋地殻の厚さを決める（減圧融解） */
const MANTLE_C = arg("mantle", 1350)
/** 海洋地殻の厚さ [km]。現在の 1350℃ で 7、太古代の 1600℃ で 18.4 */
const H_OC = Tectonics.oceanCrustThickness(MANTLE_C)
/** 水の量の倍率。惑星の水の量を振るつまみ */
const WATER = arg("water", 1)
/** 大陸地殻の標準の厚さ [km] */
const H_CONT = 35
/** 地球の地殻の厚さ分散 [km²]（大陸 37km×41% + 海洋 7km×59%） */
const EARTH_VARIANCE = 218

const grid = new Grid(W, H)
const rng = new Rng(SEED, Stream.Tectonics)

// --- 初期地形から大陸の配置をもらう（本体と同じ出発点にする） ---
const store = new FieldStore(grid, WORLD_FIELDS, { shared: false })
generateTerrain(grid, store, SEED, DEFAULT_TERRAIN)
const elev0 = store.f32("elevation").read

// --- プレート（剛体。粒子は自分のプレートに属したまま動く） ---
type Vec3 = [number, number, number]
const norm = (v: Vec3): Vec3 => {
  const m = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / m, v[1] / m, v[2] / m]
}
const plateSeed: Vec3[] = []
let omega: Vec3[] = []
const newOmega = (): Vec3 => {
  const a = norm([rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)])
  const w = (PLATE_SPEED / EARTH_R) * rng.range(0.4, 1.6)  // rad/yr
  return [a[0] * w, a[1] * w, a[2] * w]
}
for (let k = 0; k < PLATES; k++) {
  const z = rng.range(-1, 1), th = rng.range(0, 2 * Math.PI)
  const s = Math.sqrt(1 - z * z)
  plateSeed.push([s * Math.cos(th), z, s * Math.sin(th)])
  omega.push(newOmega())
}

// --- 粒子 ---
// 位置（単位ベクトル）・プレート・珪長質か・厚さ。alive で寿命を管理する
const cap = NP * 2
const px = new Float64Array(cap), py = new Float64Array(cap), pz = new Float64Array(cap)
const pPlate = new Int32Array(cap)
const pFel = new Float32Array(cap)          // 0=玄武岩質 / 1=珪長質
const pThick = new Float32Array(cap)        // km
const alive = new Uint8Array(cap)
const free: number[] = []
let nAlive = 0
/** 粒子 1 個が代表する面積 [m²] */
const PARCEL_AREA = (4 * Math.PI * EARTH_R * EARTH_R) / NP

const nearestPlate = (x: number, y: number, z: number) => {
  let best = 0, bd = -2
  for (let k = 0; k < PLATES; k++) {
    const s = plateSeed[k]
    const d = x * s[0] + y * s[1] + z * s[2]
    if (d > bd) { bd = d; best = k }
  }
  return best
}
const cellOf = (x: number, y: number, z: number) => {
  const lat = Math.asin(Math.max(-1, Math.min(1, y)))
  const lon = Math.atan2(z, x)
  let sx = Math.floor((lon / (2 * Math.PI)) * W + W)
  sx = ((sx % W) + W) % W
  const sy = Math.max(0, Math.min(H - 1, Math.floor((0.5 - lat / Math.PI) * H)))
  return sy * W + sx
}
const spawn = (x: number, y: number, z: number, plate: number, fel: number, thick: number) => {
  const i = free.length > 0 ? free.pop()! : nAlive
  if (i >= cap) return
  px[i] = x; py[i] = y; pz[i] = z
  pPlate[i] = plate; pFel[i] = fel; pThick[i] = thick; alive[i] = 1
  if (i >= nAlive) nAlive = i + 1
}
const kill = (i: number) => { alive[i] = 0; free.push(i) }

// フィボナッチ球で一様に配置する
for (let n = 0; n < NP; n++) {
  const yy = 1 - (2 * n + 1) / NP
  const r = Math.sqrt(Math.max(0, 1 - yy * yy))
  const phi = n * Math.PI * (3 - Math.sqrt(5))
  const x = r * Math.cos(phi), z = r * Math.sin(phi)
  const c = cellOf(x, yy, z)
  const cont = elev0[c] >= 0
  spawn(x, yy, z, nearestPlate(x, yy, z), cont ? 1 : 0, cont ? H_CONT : H_OC)
}

// --- ラスタライズ ---
const cellThick = new Float64Array(W * H)
/** 沈み込みが起きたセルと、その強さ（消した粒子の数）。島弧の配分に使う */
const subCells: number[] = []
const subWeight = new Float64Array(W * H)
const cellFel = new Float64Array(W * H)
const bucket: number[][] = Array.from({ length: W * H }, () => [])
function rasterize(): void {
  cellThick.fill(0); cellFel.fill(0)
  for (const b of bucket) b.length = 0
  for (let i = 0; i < nAlive; i++) {
    if (!alive[i]) continue
    const c = cellOf(px[i], py[i], pz[i])
    bucket[c].push(i)
  }
  for (let y = 0; y < H; y++) {
    const A = grid.cellArea[y]
    for (let x = 0; x < W; x++) {
      const c = y * W + x
      let t = 0, f = 0
      for (const i of bucket[c]) {
        const dt = pThick[i] * PARCEL_AREA / A
        t += dt; f += dt * pFel[i]
      }
      cellThick[c] = t
      cellFel[c] = t > 1e-9 ? f / t : 0
    }
  }
}

// --- 回転 ---
function rotate(v: Vec3, axis: Vec3, ang: number): Vec3 {
  const c = Math.cos(ang), s = Math.sin(ang)
  const d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2]
  return [
    v[0] * c + (axis[1] * v[2] - axis[2] * v[1]) * s + axis[0] * d * (1 - c),
    v[1] * c + (axis[2] * v[0] - axis[0] * v[2]) * s + axis[1] * d * (1 - c),
    v[2] * c + (axis[0] * v[1] - axis[1] * v[0]) * s + axis[2] * d * (1 - c),
  ]
}

const tp = { ...EARTH_TECTONICS, crustComposition: 1 }

/**
 * 海面を水の体積から解く。**これが無いと陸の面積がプレート速度に応答しない。**
 *
 * 速い拡大 -> 海洋地殻が若く浅い -> 海盆の容積が減る -> 海面が上がって大陸が水没。
 * 白亜紀に海面が 200m 高く内陸海が広がったのはこの機構。
 * 目標の水の体積は初期状態（陸 29% 相当）から取る。
 */
let waterTarget = -1
const elevKmBuf = new Float64Array(W * H)
function solveSeaLevel(): number {
  for (let c = 0; c < W * H; c++) {
    elevKmBuf[c] = Tectonics.deriveElevation(tp, cellThick[c], 0, cellFel[c]) / 1000
  }
  const volumeAt = (sea: number) => {
    let v = 0
    for (let c = 0; c < W * H; c++) {
      const d = sea - elevKmBuf[c]
      if (d > 0) v += d * grid.cellArea[(c / W) | 0]
    }
    return v
  }
  let lo = -12, hi = 12
  for (let k = 0; k < 60; k++) {
    const mid = 0.5 * (lo + hi)
    if (volumeAt(mid) < waterTarget) lo = mid; else hi = mid
  }
  return 0.5 * (lo + hi)
}
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
function stats() {
  const sea = waterTarget > 0 ? solveSeaLevel() : 0
  let m = 0, m2 = 0, land = 0
  for (let y = 0; y < H; y++) {
    const aw = grid.areaWeight[y]
    for (let x = 0; x < W; x++) {
      const c = y * W + x
      const t = cellThick[c]
      m += t * aw; m2 += t * t * aw
      if (Tectonics.deriveElevation(tp, t, 0, cellFel[c]) / 1000 >= sea) land += aw
    }
  }
  return { mean: m, variance: m2 - m * m, land: 100 * land, sea }
}

// --- 時間発展 ---
const vars: number[] = [], lands: number[] = []
let created = 0, destroyed = 0, arcCreated = 0, eroded = 0
const dtYears = DT * 1e6
rasterize()
// 初期状態の海の体積を目標にする（この時点で陸 29% 相当）
{
  for (let c = 0; c < W * H; c++) {
    elevKmBuf[c] = Tectonics.deriveElevation(tp, cellThick[c], 0, cellFel[c]) / 1000
  }
  let v = 0
  for (let c = 0; c < W * H; c++) {
    if (elevKmBuf[c] < 0) v += -elevKmBuf[c] * grid.cellArea[(c / W) | 0]
  }
  waterTarget = v * WATER
}
const s0 = stats()
console.log(`\n【粒子表現の試作】 ${W}x${H}  粒子 ${NP}  プレート ${PLATES}  ` +
  `速度 ${(PLATE_SPEED * 100).toFixed(1)}cm/yr  マントル ${MANTLE_C}℃(海洋地殻 ${H_OC.toFixed(1)}km)` +
  `  水 x${WATER}  ${MYR}Myr  seed ${SEED}`)
console.log(`  初期: 厚さ平均 ${s0.mean.toFixed(1)}km  分散 ${s0.variance.toFixed(1)}  ` +
  `陸 ${s0.land.toFixed(1)}%  海面 ${s0.sea.toFixed(2)}km`)

for (let step = 0; step * DT < MYR; step++) {
  // 1. 剛体回転（連続座標。数値拡散ゼロ）
  for (let k = 0; k < PLATES; k++) {
    const w = Math.hypot(omega[k][0], omega[k][1], omega[k][2])
    if (w <= 0) continue
    const ax = norm(omega[k])
    const ang = w * dtYears
    for (let i = 0; i < nAlive; i++) {
      if (!alive[i] || pPlate[i] !== k) continue
      const r = rotate([px[i], py[i], pz[i]], ax, ang)
      px[i] = r[0]; py[i] = r[1]; pz[i] = r[2]
    }
    plateSeed[k] = norm(rotate(plateSeed[k], ax, ang))
  }
  // 1b. 150Myr ごとにプレートの向きを変える（超大陸サイクルの代わり）
  if (step > 0 && (step * DT) % 150 === 0) omega = omega.map(() => newOmega())

  rasterize()

  // 2. 沈み込み: 重なったセルから【玄武岩質の粒子だけ】消す。珪長質は消さない
  //    -> 大陸どうしの衝突では厚さが積み上がる（ヒマラヤ）
  subCells.length = 0
  for (let c = 0; c < W * H; c++) {
    if (cellThick[c] <= H_OC * 1.01) continue
    const y = (c / W) | 0
    const A = grid.cellArea[y]
    let t = cellThick[c]
    let killed = 0
    for (const i of bucket[c]) {
      if (t <= H_OC * 1.01) break
      if (pFel[i] >= 0.5) continue                 // 珪長質は沈まない
      t -= pThick[i] * PARCEL_AREA / A
      kill(i); destroyed++; killed++
    }
    if (killed > 0) { subCells.push(c); subWeight[c] = killed }
  }
  // 2b. 島弧: 沈み込んだセルの隣に【珪長質の粒子】を作る。
  //     生成量は観測値（1〜3 km³/yr）に合わせて配分する。
  //     **これがプレート速度に依存する過程**——収束が速いほど弧が活発になる
  if ((ARC_RATE > 0 || ARC_FLUX > 0) && subCells.length > 0) {
    let wTotal = 0
    for (const c of subCells) wTotal += subWeight[c]
    if (wTotal > 0) {
      // 沈み込んだ体積（粒子 1 個 = H_OC × 粒子面積）
      const subVol = wTotal * H_OC * (PARCEL_AREA / 1e6)    // km³
      const volume = ARC_FLUX > 0 ? subVol * ARC_EFFICIENCY : ARC_RATE * dtYears
      for (const c of subCells) {
        const share = volume * subWeight[c] / wTotal        // km³
        if (share <= 0) continue
        const y = (c / W) | 0, x = c - y * W
        // 粒子 1 個が運ぶ体積 [km³]
        const per = H_CONT * (PARCEL_AREA / 1e6)
        let nNew = Math.floor(share / per)
        if (rng.nextFloat() < share / per - nNew) nNew++
        for (let k = 0; k < nNew; k++) {
          const lon = ((x + rng.nextFloat()) / W) * 2 * Math.PI
          const latT = (0.5 - y / H) * Math.PI, latB = (0.5 - (y + 1) / H) * Math.PI
          const sinLat = Math.sin(latB) + rng.nextFloat() * (Math.sin(latT) - Math.sin(latB))
          const lat = Math.asin(Math.max(-1, Math.min(1, sinLat)))
          const cl = Math.cos(lat)
          const nx = cl * Math.cos(lon), ny = Math.sin(lat), nz = cl * Math.sin(lon)
          spawn(nx, ny, nz, nearestPlate(nx, ny, nz), 1, H_CONT)
          arcCreated++
        }
      }
    }
  }

  // 3. 海嶺: 隙間ができたセルを玄武岩質の粒子で埋める
  for (let c = 0; c < W * H; c++) {
    const y = (c / W) | 0, x = c - y * W
    const A = grid.cellArea[y]
    let t = 0
    for (const i of bucket[c]) if (alive[i]) t += pThick[i] * PARCEL_AREA / A
    const want = H_OC - t
    if (want <= 0.01) continue
    const nNew = Math.max(1, Math.round(want * A / (H_OC * PARCEL_AREA)))
    for (let k = 0; k < nNew; k++) {
      // セル内にランダムに置く
      const lon = ((x + rng.nextFloat()) / W) * 2 * Math.PI
      const latT = (0.5 - y / H) * Math.PI, latB = (0.5 - (y + 1) / H) * Math.PI
      const sinLat = Math.sin(latB) + rng.nextFloat() * (Math.sin(latT) - Math.sin(latB))
      const lat = Math.asin(Math.max(-1, Math.min(1, sinLat)))
      const cl = Math.cos(lat)
      const nx = cl * Math.cos(lon), ny = Math.sin(lat), nz = cl * Math.sin(lon)
      spawn(nx, ny, nz, nearestPlate(nx, ny, nz), 0, H_OC)
      created++
    }
  }
  // 4. 侵食と堆積。**これも速度に依存する**（起伏が高いほど速く削れる）。
  //    削った分は浅い海に配る -> 大陸棚ができて陸の面積が広がる
  if (DENUD > 0) {
    rasterize()
    const sea = solveSeaLevel()
    const elevKm = new Float64Array(W * H)
    for (let c = 0; c < W * H; c++) {
      elevKm[c] = Tectonics.deriveElevation(tp, cellThick[c], 0, cellFel[c]) / 1000 - sea
    }
    let removed = 0
    for (let c = 0; c < W * H; c++) {
      if (elevKm[c] <= 0) continue
      const y = (c / W) | 0
      const A = grid.cellArea[y]
      const loss = Math.min(cellThick[c] - H_OC, DENUD * elevKm[c] * dtYears)
      if (loss <= 0) continue
      // そのセルの珪長質の粒子から比例して削る
      let felThick = 0
      for (const i of bucket[c]) if (pFel[i] >= 0.5) felThick += pThick[i] * PARCEL_AREA / A
      if (felThick <= 0) continue
      const k = Math.min(1, loss / felThick)
      for (const i of bucket[c]) if (pFel[i] >= 0.5) pThick[i] *= 1 - k
      removed += loss * A / 1e6            // km³
      eroded += loss * A / 1e6
    }
    // 浅い海に配る（水深の 4 乗の重み。本体と同じ）
    if (removed > 0) {
      let wsum = 0
      const wgt = new Float64Array(W * H)
      for (let c = 0; c < W * H; c++) {
        if (elevKm[c] >= 0) continue
        const d = Math.max(0.05, -elevKm[c]) / 0.6
        wgt[c] = 1 / (1 + d * d * d * d)
        wsum += wgt[c] * grid.cellArea[(c / W) | 0]
      }
      if (wsum > 0) {
        for (let c = 0; c < W * H; c++) {
          if (wgt[c] <= 0) continue
          const y = (c / W) | 0, x = c - y * W
          const A = grid.cellArea[y]
          const addKm = removed * 1e6 * wgt[c] / wsum        // 厚さ [km]
          if (addKm <= 1e-9) continue
          // そのセルの珪長質の粒子を厚くする。無ければ新しく作る
          let n = 0
          for (const i of bucket[c]) if (pFel[i] >= 0.5) n++
          if (n > 0) {
            const per = addKm * A / (n * PARCEL_AREA)
            for (const i of bucket[c]) if (pFel[i] >= 0.5) pThick[i] += per
          } else {
            const per = H_CONT * (PARCEL_AREA / 1e6)
            const vol = addKm * A / 1e6
            let nNew = Math.floor(vol / per)
            if (rng.nextFloat() < vol / per - nNew) nNew++
            for (let k = 0; k < nNew; k++) {
              const lon = ((x + rng.nextFloat()) / W) * 2 * Math.PI
              const latT = (0.5 - y / H) * Math.PI, latB = (0.5 - (y + 1) / H) * Math.PI
              const sinLat = Math.sin(latB) + rng.nextFloat() * (Math.sin(latT) - Math.sin(latB))
              const lat = Math.asin(Math.max(-1, Math.min(1, sinLat)))
              const cl = Math.cos(lat)
              spawn(cl * Math.cos(lon), Math.sin(lat), cl * Math.sin(lon),
                nearestPlate(cl * Math.cos(lon), Math.sin(lat), cl * Math.sin(lon)), 1, H_CONT)
            }
          }
        }
      }
    }
  }

  if (step % 10 === 0) {
    rasterize()
    const s = stats()
    vars.push(s.variance); lands.push(s.land)
  }
}

rasterize()
const s1 = stats()
const half = vars.length >> 1
const vs = vars.slice(half), ls = lands.slice(half)
console.log(`  終端: 厚さ平均 ${s1.mean.toFixed(1)}km  分散 ${s1.variance.toFixed(1)}  ` +
  `陸 ${s1.land.toFixed(1)}%  海面 ${s1.sea.toFixed(2)}km`)
console.log(`  ★厚さの分散（後半の中央値） ${med(vs).toFixed(1)} km²   （地球 ${EARTH_VARIANCE}）`)
console.log(`   陸地面積（後半の中央値）   ${med(ls).toFixed(1)} %      （地球 29.2）`)
console.log(`   粒子 海嶺生成 ${created} / 沈み込み消滅 ${destroyed} / 島弧生成 ${arcCreated}` +
  ` / 生存 ${nAlive - free.length}`)
console.log(`   島弧 ${(arcCreated * H_CONT * PARCEL_AREA / 1e6 / (MYR * 1e6)).toFixed(2)}` +
  ` / 侵食 ${(eroded / (MYR * 1e6)).toFixed(2)} km³/yr （地球 生成 1〜3 / 侵食 1〜2）`)

const EDGES = [0, 5, 10, 15, 20, 25, 30, 35, 45, 60, 999]
const hist = new Array(EDGES.length - 1).fill(0)
for (let y = 0; y < H; y++) {
  const aw = grid.areaWeight[y]
  for (let x = 0; x < W; x++) {
    const t = cellThick[y * W + x]
    for (let k = 0; k < EDGES.length - 1; k++) {
      if (t >= EDGES[k] && t < EDGES[k + 1]) { hist[k] += aw; break }
    }
  }
}
console.log(`  厚さのヒストグラム[面積%]  ★二峰になっているか`)
for (let k = 0; k < hist.length; k++) {
  if (hist[k] < 1e-4) continue
  console.log(`   ${EDGES[k].toString().padStart(4)}-${EDGES[k + 1].toString().padEnd(4)} ` +
    `${(100 * hist[k]).toFixed(1).padStart(5)}% ${"#".repeat(Math.round(150 * hist[k]))}`)
}

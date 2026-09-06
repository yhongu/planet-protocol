/**
 * **惑星の状態を保存して、そのまま続きから回す。**
 *
 * ## なぜリプレイではなくスナップショットか
 *
 * この企画は**決定論が契約**なので（`docs/04-6`）、
 * 「seed + 介入の履歴」だけで 45.4 億年を完全に再現できる。**理屈の上では**。
 * ただし再現には **45.4 億年を回し直す時間**（128x64 で約 60 分）がかかる。
 * 1 ゲームが 38〜60 分なのだから、それでは保存の意味が無い。
 *
 * だから**状態そのもの**を書き出す。
 *
 * ## 何を保存するか
 *
 * ★**派生量は保存しない。次の 1 歩で作り直される。**
 * 作業バッファ（`vE` / `tauX` / `fitBuf` …）、`cellStart`、寄与台帳がそれ。
 *
 * ★**逆に、乱数の途中経過は必ず保存する。** 保存しないと復元した惑星は
 * **別の道を歩く**（`CLAUDE.md` の 11: ビット単位の差が 20 億年後に
 * 陸地面積 3 ポイントの差になる）。`Rng.getState()` が 4 語を持つ。
 *
 * ★**較正で決まった値も保存する**（`carbon.params.volcanicFlux`）。
 * 復元後に較正し直すと、**その時点の地形**で別の値になる。
 * 較正は「現在の地球は定常」を使う定義なので、途中の地形でやってはいけない。
 *
 * ## 形式
 *
 * `GAIA` + version + JSON の長さ + JSON + 生のバイト列。
 * 場（`FieldStore.buffer`）は 1 本の連続バッファなので**そのまま書ける**。
 * 粒子は生きている範囲だけを、**Float64 のまま**（量子化すると最終桁が変わる）。
 *
 * 実測（128x64）: 場 1.65MB + 粒子 32MB。gzip は呼び出し側で掛ける。
 */
import { Grid } from "../core/grid"
import { FieldStore } from "../core/fields"
import { World, WORLD_FIELDS } from "./world"
import type { WorldOptions } from "./world"
import type { ParcelSnapshot } from "./parcels"

/** 型付き配列なら種類を返す。JSON に出すときに型を失わないため */
function taKind(v: unknown): string | null {
  if (v instanceof Uint8Array) return "u8"
  if (v instanceof Uint32Array) return "u32"
  if (v instanceof Int32Array) return "i32"
  if (v instanceof Float32Array) return "f32"
  if (v instanceof Float64Array) return "f64"
  return null
}

const MAGIC = 0x41494147          // "GAIA" のリトルエンディアン
/** ★形式を変えたら上げること。古いセーブを黙って読み込むと惑星が壊れる */
/**
 * ★**場の形が変わったら必ず上げること。** `restoreInto` は
 * `new Uint8Array(store.buffer).set(fields)` と**生のバイト列をそのまま**
 * 当てるので、レーン数が違うセーブを読むと**黙って壊れる**。
 *
 * v2 (2026-09-06): `MAX_CLADES` 16 → 32（バイオマスと到達の場のレーンが倍）
 */
export const SNAPSHOT_VERSION = 2

/** 生のバイト列として書き出す配列。順番が形式そのものなので変えないこと */
interface Blob { name: string; kind: "f64" | "f32" | "i32" | "u8"; len: number }

interface Meta {
  version: number
  /** 惑星を作り直すのに要る引数。★`seed` と `width/height` は復元に必須 */
  options: { width: number; height: number; seed: string }
  globals: Record<string, unknown>
  world: Record<string, unknown>
  mantle: Record<string, unknown>
  tectonics: Record<string, unknown>
  carbon: Record<string, unknown>
  ocean: Record<string, unknown>
  climate: number[]
  hydrology: number
  prebiotic: Record<string, unknown>
  oxygen: Record<string, unknown>
  life: Record<string, unknown>
  events: unknown[]
  blobs: Blob[]
}

/** 保存する。返すのは 1 本の `Uint8Array` */
export function saveWorld(world: World): Uint8Array {
  const tect = world.tectonics.snapshot()
  const parcels = tect.parcels as ParcelSnapshot | null
  delete tect.parcels

  const arrays: { blob: Blob; data: ArrayBufferView }[] = []
  const push = (name: string, kind: Blob["kind"], a: ArrayBufferView): void => {
    arrays.push({ blob: { name, kind, len: (a as unknown as { length: number }).length }, data: a })
  }
  // 場は 1 本の連続バッファ。そのまま書ける
  push("fields", "u8", new Uint8Array(world.store.buffer as ArrayBuffer))
  if (parcels) {
    push("p.x", "f64", parcels.x); push("p.y", "f64", parcels.y); push("p.z", "f64", parcels.z)
    push("p.plate", "i32", parcels.plate)
    push("p.felsic", "f32", parcels.felsic)
    push("p.thick", "f32", parcels.thick)
    push("p.age", "f32", parcels.age)
    push("p.alive", "u8", parcels.alive)
    push("p.freeList", "i32", parcels.freeList)
  }

  const meta: Meta = {
    version: SNAPSHOT_VERSION,
    options: { width: world.grid.W, height: world.grid.H, seed: world.seed },
    globals: { ...world.globals } as unknown as Record<string, unknown>,
    world: world.snapshot(),
    mantle: world.mantle.snapshot(),
    tectonics: { ...tect, parcelCounts: parcels
      ? { high: parcels.high, liveCount: parcels.liveCount, freeTop: parcels.freeTop }
      : null },
    carbon: world.carbon.snapshot(),
    ocean: world.ocean.snapshot(),
    climate: world.climate.snapshot(),
    hydrology: world.hydrology.snapshot(),
    prebiotic: world.prebiotic.snapshot(),
    oxygen: world.oxygen.snapshot(),
    life: world.life.snapshot(),
    events: world.events,
    blobs: arrays.map((a) => a.blob),
  }
  // ★**型付き配列は JSON にすると「ただのオブジェクト」になる。**
  //
  // `Genome` は `Uint8Array` を 2 本と `Uint32Array` を 1 本持っている。
  // 素直に書くと `{"0":1,"1":2,…}` になり、**添字で読めてしまうので
  // 動いているように見える**。書き込みの丸め（0..255 へのクランプ）と
  // `.length` が別物なので、**分岐と変異が起きたときに初めて壊れる**
  // （実測: 生命が動いている惑星で、復元の 60 歩後にバイオマスが割れた）。
  //
  // ★**`JSON.stringify(-Infinity)` は `"null"` になる。**
  // `lastLipYear` と `lastMassExtinction` は `-Infinity` で初期化されるので、
  // 素直に書くと復元後に `null` になり、`year - null = year` という
  // **有限の差**になって出来事の間隔判定が壊れる（実測で 10 歩後に惑星が割れた）。
  // 非有限の数は文字列にして逃がし、読むときに戻す。
  const json = new TextEncoder().encode(JSON.stringify(meta, (_k, v) => {
    if (typeof v === "number" && !Number.isFinite(v)) return `__nf:${String(v)}`
    const t = taKind(v)
    return t ? { __ta: t, d: Array.from(v as Uint8Array) } : v
  }))

  // ★各ブロックを 8 バイト境界に揃える。Float64Array のビューは
  // オフセットが 8 の倍数でないと生成できない（実際に落ちた）
  const align = (n: number): number => (n + 7) & ~7
  let off = align(12 + json.length)
  const starts: number[] = []
  for (const a of arrays) {
    starts.push(off)
    off = align(off + a.data.byteLength)
  }
  const out = new Uint8Array(off)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, MAGIC, true)
  dv.setUint32(4, SNAPSHOT_VERSION, true)
  dv.setUint32(8, json.length, true)
  out.set(json, 12)
  for (let i = 0; i < arrays.length; i++) {
    out.set(new Uint8Array(arrays[i].data.buffer, arrays[i].data.byteOffset,
      arrays[i].data.byteLength), starts[i])
  }
  return out
}

/**
 * 読み込む。★**惑星を作り直してから状態を上書きする。**
 * 較正は `World` の構築時に走るが、そのあと保存した値で潰すので問題ない
 * （`carbon.snapshot()` が `volcanicFlux` を持っている）。
 */
/**
 * ★**既にある惑星に上書きする。**
 *
 * ブラウザは場を `SharedArrayBuffer` で主スレッドと共有しているので
 * （`docs/04-2.1`）、**新しい `World` を作ると共有が切れて画面が固まる**。
 * 解像度と seed が同じなら、その場に書き戻すのが正しい。
 *
 * 解像度が違うセーブは受け取らない —— 場の並びも粒子の容量も変わるので、
 * **黙って壊れるより落ちる方がよい**（呼び出し側が作り直す）。
 */
export function applySnapshot(world: World, bytes: Uint8Array): void {
  const meta = readMeta(bytes)
  if (meta.options.width !== world.grid.W || meta.options.height !== world.grid.H) {
    throw new Error(`解像度が違います（セーブ ${meta.options.width}x${meta.options.height} / `
      + `いま ${world.grid.W}x${world.grid.H}）`)
  }
  restoreInto(world, meta, bytes)
}

/** セーブに書かれている情報だけを読む（作り直す前に解像度と seed を知るため）*/
export function readSnapshotInfo(bytes: Uint8Array): {
  width: number; height: number; seed: string; years: number
} {
  const meta = readMeta(bytes)
  const g = meta.globals as { yearsElapsed?: number }
  return { ...meta.options, years: g.yearsElapsed ?? 0 }
}

export function loadWorld(bytes: Uint8Array, extra?: Partial<WorldOptions>): World {
  const meta = readMeta(bytes)
  const w = new World({
    width: meta.options.width, height: meta.options.height, seed: meta.options.seed,
    shared: false, ...extra,
  })
  restoreInto(w, meta, bytes)
  return w
}

function readMeta(bytes: Uint8Array): Meta {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(0, true) !== MAGIC) throw new Error("セーブデータではありません")
  const version = dv.getUint32(4, true)
  if (version !== SNAPSHOT_VERSION) {
    throw new Error(`セーブの形式が違います（保存 v${version} / いま v${SNAPSHOT_VERSION}）`)
  }
  const jsonLen = dv.getUint32(8, true)
  return JSON.parse(
    new TextDecoder().decode(bytes.subarray(12, 12 + jsonLen)),
    (_k, v) => {
      if (typeof v === "string" && v.startsWith("__nf:")) return Number(v.slice(5))
      if (v && typeof v === "object" && "__ta" in v) {
        const o = v as { __ta: string; d: number[] }
        return o.__ta === "u8" ? Uint8Array.from(o.d)
          : o.__ta === "u32" ? Uint32Array.from(o.d)
            : o.__ta === "i32" ? Int32Array.from(o.d)
              : o.__ta === "f32" ? Float32Array.from(o.d) : Float64Array.from(o.d)
      }
      return v
    },
  ) as Meta
}

function restoreInto(w: World, meta: Meta, bytes: Uint8Array): void {
  const jsonLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(8, true)
  // --- 生のバイト列を切り出す ---
  const align = (n: number): number => (n + 7) & ~7
  let off = align(12 + jsonLen)
  const base = bytes.byteOffset
  const blobs = new Map<string, ArrayBufferView>()
  for (const b of meta.blobs) {
    const bytesPer = b.kind === "f64" ? 8 : b.kind === "u8" ? 1 : 4
    const view = b.kind === "f64" ? new Float64Array(bytes.buffer, base + off, b.len)
      : b.kind === "f32" ? new Float32Array(bytes.buffer, base + off, b.len)
        : b.kind === "i32" ? new Int32Array(bytes.buffer, base + off, b.len)
          : new Uint8Array(bytes.buffer, base + off, b.len)
    blobs.set(b.name, view)
    off = align(off + b.len * bytesPer)
  }

  // 場（1 本の連続バッファ）
  const fields = blobs.get("fields") as Uint8Array
  new Uint8Array(w.store.buffer as ArrayBuffer).set(fields)

  Object.assign(w.globals, meta.globals)
  w.restore(meta.world)
  w.mantle.restore(meta.mantle)
  w.carbon.restore(meta.carbon)
  w.ocean.restore(meta.ocean)
  w.climate.restore(meta.climate)
  w.hydrology.restore(meta.hydrology)
  w.prebiotic.restore(meta.prebiotic)
  w.oxygen.restore(meta.oxygen)
  w.life.restore(meta.life)
  w.events.length = 0
  w.events.push(...(meta.events as World["events"]))

  const counts = (meta.tectonics as { parcelCounts: ParcelSnapshot | null }).parcelCounts
  const tect: Record<string, unknown> = { ...meta.tectonics }
  delete tect.parcelCounts
  tect.parcels = counts && blobs.has("p.x") ? {
    high: counts.high, liveCount: counts.liveCount, freeTop: counts.freeTop,
    x: blobs.get("p.x"), y: blobs.get("p.y"), z: blobs.get("p.z"),
    plate: blobs.get("p.plate"), felsic: blobs.get("p.felsic"),
    thick: blobs.get("p.thick"), age: blobs.get("p.age"),
    alive: blobs.get("p.alive"), freeList: blobs.get("p.freeList"),
  } : null
  w.tectonics.restore(tect)
}

/** 参照だけ（型検査のため） */
void Grid; void FieldStore; void WORLD_FIELDS

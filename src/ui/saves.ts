/**
 * **セーブの保管。**
 *
 * ★**IndexedDB に置く。`localStorage` ではない。**
 * 1 本のセーブは 128x64 で **34.5MB**（gzip で 16.1MB）あり、
 * `localStorage` の上限（5〜10MB）に入らない。しかも文字列なので
 * バイト列を入れると 1.33 倍に膨らむ。
 *
 * ★**gzip は `CompressionStream` で掛ける**（ブラウザ組み込み。
 * ライブラリを足さない）。実測 258ms。
 */

const DB = "gaia-saves"
const STORE = "saves"

export interface SaveInfo {
  id: string
  name: string
  seed: string
  years: number
  savedAt: number
  bytes: number
}

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" })
    }
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((res, rej) => {
    const t = db.transaction(STORE, mode)
    const req = fn(t.objectStore(STORE))
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  }))
}

/** ★圧縮と伸長。ブラウザ組み込みの `CompressionStream` を使う */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip")
  const ab = bytes.buffer.slice(
    bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const blob = await new Response(new Blob([ab]).stream().pipeThrough(cs)).arrayBuffer()
  return new Uint8Array(blob)
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip")
  const ab = bytes.buffer.slice(
    bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const blob = await new Response(new Blob([ab]).stream().pipeThrough(ds)).arrayBuffer()
  return new Uint8Array(blob)
}

export async function putSave(
  info: Omit<SaveInfo, "bytes">, raw: Uint8Array,
): Promise<SaveInfo> {
  const gz = await gzip(raw)
  const rec: SaveInfo & { data: Uint8Array } = { ...info, bytes: gz.length, data: gz }
  await tx("readwrite", (s) => s.put(rec))
  return rec
}

export async function getSave(id: string): Promise<Uint8Array | null> {
  const rec = await tx<{ data: Uint8Array } | undefined>("readonly", (s) => s.get(id))
  return rec ? gunzip(rec.data) : null
}

export async function listSaves(): Promise<SaveInfo[]> {
  const all = await tx<(SaveInfo & { data: Uint8Array })[]>("readonly", (s) => s.getAll())
  return all.map(({ data: _d, ...i }) => i).sort((a, b) => b.savedAt - a.savedAt)
}

export async function deleteSave(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id))
}

/** 「4.17 Ga」のような表示。★セーブの一覧はここが一番の手がかりになる */
export function whenLabel(years: number, planetAge = 4.54e9): string {
  const ago = planetAge - years
  return ago >= 1e7 ? `${(ago / 1e9).toFixed(2)} Ga` : `${(ago / 1e6).toFixed(0)} Ma`
}

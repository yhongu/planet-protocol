/**
 * **配られた章の惑星。**
 *
 * ★**台本ではない。** `scripts/make-chapters.ts` が冥王代から本当に回した
 * 1 つの惑星を、その時代に着いた時点で保存したものである。
 * 決定論なので、同じ seed で同じだけ回せば誰でも同じ物が出る（検証できる）。
 *
 * ## なぜ配るのか
 *
 * 各自の機械で計算させると **太古代 15 分・原生代 56 分・顕生代 110 分**
 * かかる（128x64 の実測）。それは「待ち」であって遊びではない。
 *
 * ## 無くても壊れない
 *
 * 目録が取れなければ**その場で計算する道**（早送り）に落ちる。
 * 開発中は章が無いこともあるので、**黙って落ちないこと**が要る。
 */
import { gunzip } from "./saves"

export interface ChapterInfo {
  id: string
  label: string
  ga: number
  seed: string
  width: number
  height: number
  bytes: number
  years: number
  meanT: number
  co2: number
  o2: number
  clades: number
  goeYear: number
  events: number
}

let cache: ChapterInfo[] | null = null

/** 目録を取る。★取れなくても投げない（早送りに落ちる） */
export async function listChapters(): Promise<ChapterInfo[]> {
  if (cache) return cache
  try {
    const r = await fetch("chapters/chapters.json")
    if (!r.ok) throw new Error(String(r.status))
    cache = (await r.json()) as ChapterInfo[]
  } catch {
    cache = []
  }
  return cache
}

/**
 * 章の惑星を読む。★**進み具合を返す**（10MB を超えるので、
 * 黙って待たせない）。`onProgress` は 0..1、長さが分からなければ -1
 */
export async function fetchChapter(
  id: string, onProgress?: (t: number) => void,
): Promise<Uint8Array> {
  const res = await fetch(`chapters/${id}.gaia`)
  if (!res.ok) throw new Error(`章が読めません（${res.status}）`)
  const total = Number(res.headers.get("content-length") ?? 0)
  const reader = res.body?.getReader()
  if (!reader) return gunzip(new Uint8Array(await res.arrayBuffer()))
  const parts: Uint8Array[] = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    got += value.length
    onProgress?.(total > 0 ? got / total : -1)
  }
  const all = new Uint8Array(got)
  let off = 0
  for (const p of parts) { all.set(p, off); off += p.length }
  // ★Cloudflare が転送で圧縮を掛けると、ブラウザが先に伸長して届く。
  //   先頭 2 バイトが gzip でなければ、そのまま渡す
  return (all[0] === 0x1f && all[1] === 0x8b) ? gunzip(all) : all
}

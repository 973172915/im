/**
 * 向量编码客户端：调用本地 embedding 服务（services/embed，默认 :9300）。
 *
 * 设计要点：
 *  1. 服务不可用时静默返回 null，调用方回退到词法检索 —— 向量是增强，不是依赖
 *  2. 查询和文档**分开编码**：实测同一批次里长短差异大的文本会互相影响
 *  3. 向量以 Float32Array 存成字节写库
 */
const EMBED_URL = (process.env.EMBED_URL ?? 'http://127.0.0.1:9300').replace(/\/$/, '')
const TIMEOUT_MS = Number(process.env.EMBED_TIMEOUT_MS ?? 8000)

export async function embedTexts(texts: string[]): Promise<Float32Array[] | null> {
  const input = texts.map((t) => (t ?? '').trim()).filter(Boolean)
  if (!input.length) return []

  try {
    const res = await fetch(`${EMBED_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: input }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { vectors?: number[][] }
    if (!data.vectors?.length) return null
    return data.vectors.map((v) => Float32Array.from(v))
  } catch {
    return null
  }
}

/** 单条编码（查询用，避免和文档混批） */
export async function embedOne(text: string): Promise<Float32Array | null> {
  const vs = await embedTexts([text])
  return vs?.[0] ?? null
}

export function vecToBytes(v: Float32Array): Uint8Array<ArrayBuffer> {
  const ab = new ArrayBuffer(v.byteLength)
  new Uint8Array(ab).set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
  return new Uint8Array(ab)
}

export function bytesToVec(b: Uint8Array): Float32Array {
  const ab = new ArrayBuffer(b.byteLength)
  new Uint8Array(ab).set(b)
  return new Float32Array(ab)
}

/** 余弦相似度（向量已归一化，等价于点积） */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < n; i++) dot += a[i] * b[i]
  return dot
}

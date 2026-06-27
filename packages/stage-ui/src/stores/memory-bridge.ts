/**
 * Thin fetch wrapper around apps/server's /api/memory/* routes.
 * Same-origin: relies on the unified proxy forwarding /api/* to :3000.
 */

export type MemoryKind = 'fact' | 'preference' | 'event' | 'context'
export type MemorySource = 'extracted' | 'self' | 'user_confirmed'

export interface MemoryWriteInput {
  text: string
  kind?: MemoryKind
  importance?: number
  characterId?: string
  source?: MemorySource
  confidence?: number
}

export interface MemoryRecallResult {
  id: string
  text: string
  kind: MemoryKind
  importance: number
  score: number
  createdAt: string
}

const DEFAULT_TIMEOUT_MS = 1500

function withTimeout(ms: number): { signal: AbortSignal, cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, cancel: () => clearTimeout(timer) }
}

export async function writeMemory(input: MemoryWriteInput, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  const { signal, cancel } = withTimeout(timeoutMs)
  try {
    const res = await fetch('/api/memory/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(input),
      signal,
    })
    if (!res.ok)
      throw new Error(`writeMemory ${res.status}`)
  }
  finally {
    cancel()
  }
}

export async function recallMemory(
  query: string,
  k = 4,
  characterId?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<MemoryRecallResult[]> {
  const { signal, cancel } = withTimeout(timeoutMs)
  try {
    const res = await fetch('/api/memory/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ query, k, characterId }),
      signal,
    })
    if (!res.ok)
      return []
    return await res.json() as MemoryRecallResult[]
  }
  catch {
    return []
  }
  finally {
    cancel()
  }
}

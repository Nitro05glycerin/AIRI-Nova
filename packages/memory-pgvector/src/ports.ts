/**
 * Memory ports mirroring Alaya PR #1216 interface shapes. Server-backed
 * implementations live alongside; when Alaya merges upstream we can swap
 * its planner in by changing imports only.
 */

export type MemoryKind = 'fact' | 'preference' | 'event' | 'context'

/** Who asserted the memory — drives how much recall trusts it. */
export type MemorySource = 'extracted' | 'self' | 'user_confirmed'

export interface MemoryTurn {
  userText: string
  assistantText: string
  recent?: Array<{ role: 'user' | 'assistant', content: string }>
  characterId?: string
}

export interface MemoryWriteCandidate {
  text: string
  kind: MemoryKind
  importance: number
}

export interface MemoryWriteInput extends MemoryWriteCandidate {
  embedding?: number[]
  characterId?: string
  source?: MemorySource
  confidence?: number
}

export interface MemoryEntry {
  id: string
  text: string
  kind: MemoryKind
  importance: number
  characterId: string | null
  embedding: number[]
  source: MemorySource
  confidence: number
  reinforceCount: number
  lastSeenAt: Date | null
  deletedAt: Date | null
  createdAt: Date
}

export interface MemoryRecallResult {
  id: string
  text: string
  kind: MemoryKind
  importance: number
  /** Blended rank score (cosine + importance + recency + confidence). */
  score: number
  /** Raw cosine similarity, before blending — kept for debugging/threshold tuning. */
  cosine?: number
  source?: MemorySource
  confidence?: number
  createdAt: Date
}

/** Lightweight nearest-neighbour hit used for write-time dedup. */
export interface MemoryNeighbor {
  id: string
  text: string
  kind: MemoryKind
  importance: number
  source: MemorySource
  confidence: number
  reinforceCount: number
  cosine: number
}

/** Partial patch applied when reinforcing or correcting an existing memory. */
export interface MemoryReinforcePatch {
  importance?: number
  confidence?: number
  reinforce?: boolean
  text?: string
  embedding?: number[]
}

export interface MemoryUpdatePatch {
  text?: string
  kind?: MemoryKind
  importance?: number
  confidence?: number
  embedding?: number[]
}

export interface MemoryListOptions {
  n?: number
  characterId?: string
  includeDeleted?: boolean
}

export interface MemoryLlmProvider {
  evaluate: (turn: MemoryTurn) => Promise<MemoryWriteCandidate[]>
}

export interface MemoryEmbeddingProvider {
  embed: (text: string) => Promise<number[]>
  readonly dimensions: number
}

export interface ShortTermMemoryStore {
  write: (entry: MemoryWriteInput) => Promise<MemoryEntry>
  recent: (n?: number, characterId?: string) => Promise<MemoryEntry[]>
  list: (opts?: MemoryListOptions) => Promise<MemoryEntry[]>
  nearest: (queryEmbedding: number[], characterId?: string, limit?: number) => Promise<MemoryNeighbor[]>
  reinforce: (id: string, patch: MemoryReinforcePatch) => Promise<MemoryEntry | null>
  update: (id: string, patch: MemoryUpdatePatch) => Promise<MemoryEntry | null>
  softDelete: (id: string) => Promise<boolean>
  restore: (id: string) => Promise<boolean>
  pruneSoftDeleted: (olderThanDays: number) => Promise<number>
}

export interface ShortTermMemoryReader {
  recall: (queryEmbedding: number[], k?: number, characterId?: string) => Promise<MemoryRecallResult[]>
}

export interface WorkspaceMemorySource {
  store: ShortTermMemoryStore
  reader: ShortTermMemoryReader
}

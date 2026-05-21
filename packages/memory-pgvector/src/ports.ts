/**
 * Memory ports mirroring Alaya PR #1216 interface shapes. Server-backed
 * implementations live alongside; when Alaya merges upstream we can swap
 * its planner in by changing imports only.
 */

export type MemoryKind = 'fact' | 'preference' | 'event' | 'context'

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
}

export interface MemoryEntry {
  id: string
  text: string
  kind: MemoryKind
  importance: number
  characterId: string | null
  embedding: number[]
  createdAt: Date
}

export interface MemoryRecallResult {
  id: string
  text: string
  kind: MemoryKind
  importance: number
  score: number
  createdAt: Date
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
}

export interface ShortTermMemoryReader {
  recall: (queryEmbedding: number[], k?: number, characterId?: string) => Promise<MemoryRecallResult[]>
}

export interface WorkspaceMemorySource {
  store: ShortTermMemoryStore
  reader: ShortTermMemoryReader
}

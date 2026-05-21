import type {
  MemoryEmbeddingProvider,
  MemoryEntry,
  MemoryKind,
  MemoryRecallResult,
} from '@proj-airi/memory-pgvector/ports'

import type { Database } from '../libs/db'

import { useLogger } from '@guiiai/logg'
import { PgliteMemoryStore } from '@proj-airi/memory-pgvector/store-pglite'
import { sql } from 'drizzle-orm'

import { memories, MEMORY_EMBEDDING_DIMENSIONS } from '../schemas/memories'

export interface MemoryWriteArgs {
  text: string
  kind?: MemoryKind
  importance?: number
  characterId?: string
}

export async function ensureMemoryTable(db: Database): Promise<void> {
  const logger = useLogger('memory').useGlobalConfig()
  await (db as any).execute(sql`CREATE EXTENSION IF NOT EXISTS vector`)
  await (db as any).execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS memories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      text text NOT NULL,
      kind text NOT NULL,
      importance integer NOT NULL DEFAULT 1,
      character_id text,
      embedding vector(${MEMORY_EMBEDDING_DIMENSIONS}) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `))
  logger.log('Memory table ready')
}

export function createMemoryService(db: Database, embedder: MemoryEmbeddingProvider) {
  const store = new PgliteMemoryStore(db, memories as any)

  return {
    async write({ text, kind = 'fact', importance = 3, characterId }: MemoryWriteArgs): Promise<MemoryEntry> {
      const embedding = await embedder.embed(text)
      return store.write({ text, kind, importance, characterId, embedding })
    },

    async recall(query: string, k = 5, characterId?: string): Promise<MemoryRecallResult[]> {
      const embedding = await embedder.embed(query)
      return store.recall(embedding, k, characterId)
    },

    async recent(n = 10, characterId?: string): Promise<MemoryEntry[]> {
      return store.recent(n, characterId)
    },
  }
}

export type MemoryService = ReturnType<typeof createMemoryService>

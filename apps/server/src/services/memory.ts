import type {
  MemoryEmbeddingProvider,
  MemoryEntry,
  MemoryKind,
  MemoryListOptions,
  MemoryNeighbor,
  MemoryRecallResult,
  MemorySource,
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
  source?: MemorySource
  confidence?: number
}

export interface MemoryUpdateArgs {
  text?: string
  kind?: MemoryKind
  importance?: number
  confidence?: number
}

// --- Dedup / provenance knobs --------------------------------------------
// Cosine at/above which a new write is treated as a re-statement of an existing
// memory (reinforce instead of insert). Tuned against real MiniLM embeddings:
// paraphrases of the same fact sit ~0.90+, distinct same-topic facts stay below.
export const DEDUP_THRESHOLD = 0.9
// Fuzzy delete/correct must clear a HIGH bar — a loose query must never delete a
// barely-related (often important) memory. Below this, forget/correct no-op.
export const FORGET_COSINE_FLOOR = 0.6
// Importance at/above which a memory is protected from FUZZY (query-based)
// deletion — those require an explicit id via /delete, never a vague "forget X".
export const PROTECTED_IMPORTANCE = 4
// How long a soft-deleted row is retained (undo window) before hard pruning.
export const SOFT_DELETE_TTL_DAYS = 30
// Default trust by who asserted the memory. The planner (extracted) is the
// least trusted; a fact Nova deliberately saved or the user confirmed is more.
const DEFAULT_CONFIDENCE: Record<MemorySource, number> = {
  extracted: 0.55,
  self: 0.85,
  user_confirmed: 0.95,
}
// Reinforcement can corroborate a memory but must NOT let a low-trust source
// ratchet to full trust just by being repeated — "seen often" ≠ "asserted by a
// trusted source". Confidence from reinforcement is capped per source tier.
const CONFIDENCE_CEILING: Record<MemorySource, number> = {
  extracted: 0.7,
  self: 0.9,
  user_confirmed: 1.0,
}

export async function ensureMemoryTable(db: Database): Promise<void> {
  const logger = useLogger('memory').useGlobalConfig()
  await (db as any).execute(sql`CREATE EXTENSION IF NOT EXISTS vector`)
  await (db as any).execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS memories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      text text NOT NULL,
      kind text NOT NULL,
      importance integer NOT NULL DEFAULT 3,
      character_id text,
      embedding vector(${MEMORY_EMBEDDING_DIMENSIONS}) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `))

  // Idempotent, additive migration for the foolproofing columns. ADD COLUMN
  // IF NOT EXISTS backfills existing rows with the column default, so no data
  // is lost; last_seen_at is then seeded from created_at for legacy rows.
  // Run one statement per execute() — PGlite's driver doesn't reliably accept
  // multiple semicolon-separated statements in a single prepared query.
  const migrations = [
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'extracted'`,
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence real NOT NULL DEFAULT 0.6`,
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS reinforce_count integer NOT NULL DEFAULT 1`,
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_seen_at timestamptz`,
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS deleted_at timestamptz`,
    // Stamp the embedding model so a future model/dim change is detectable rather
    // than silently making old and new vectors incomparable.
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_model text NOT NULL DEFAULT 'Xenova/all-MiniLM-L6-v2'`,
    `UPDATE memories SET last_seen_at = created_at WHERE last_seen_at IS NULL`,
  ]
  for (const stmt of migrations)
    await (db as any).execute(sql.raw(stmt))

  // Indexes are best-effort: an ANN index needs pgvector >= 0.5 (hnsw) and is
  // pure speed — recall is correct without it. Never let an index failure block
  // boot (which would take Nova's whole memory backend down).
  const indexes = [
    `CREATE INDEX IF NOT EXISTS memories_active_idx ON memories (character_id) WHERE deleted_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS memories_embedding_hnsw ON memories USING hnsw (embedding vector_cosine_ops)`,
  ]
  for (const stmt of indexes) {
    try {
      await (db as any).execute(sql.raw(stmt))
    }
    catch (err) {
      logger.withError(err as Error).warn(`memory index skipped: ${stmt.slice(0, 48)}…`)
    }
  }

  logger.log('Memory table ready (foolproofing columns + indexes ensured)')
}

export function createMemoryService(db: Database, embedder: MemoryEmbeddingProvider) {
  const store = new PgliteMemoryStore(db, memories as any)
  const logger = useLogger('memory').useGlobalConfig()

  return {
    /**
     * Write a memory, deduping against the nearest existing one. A near-duplicate
     * REINFORCES metadata only (reinforce_count / recency / confidence, capped by
     * the source's trust ceiling) instead of inserting a second row. It never
     * rewrites the existing row's text/embedding — two distinct facts can hit
     * cosine ≥ 0.90 in MiniLM, and overwriting one with the other would be silent
     * data loss. Sharpening an existing fact is the job of correct()/update().
     */
    async write({ text, kind = 'fact', importance = 3, characterId, source = 'extracted', confidence }: MemoryWriteArgs): Promise<MemoryEntry> {
      const clean = text.trim()
      const baseConfidence = typeof confidence === 'number'
        ? confidence
        : (DEFAULT_CONFIDENCE[source] ?? 0.6)

      const embedding = await embedder.embed(clean)

      const [near] = await store.nearest(embedding, characterId, 1)
      if (near && near.cosine >= DEDUP_THRESHOLD) {
        const ceiling = Math.max(CONFIDENCE_CEILING[near.source] ?? 0.7, CONFIDENCE_CEILING[source] ?? 0.7)
        // Reinforcement only ratchets confidence UP toward the ceiling — it must
        // never drop an already-high confidence (e.g. a prior user_confirmed write).
        const target = Math.min(ceiling, Math.max(near.confidence, baseConfidence) + 0.08)
        const reinforced = await store.reinforce(near.id, {
          reinforce: true,
          importance: Math.max(near.importance, importance),
          confidence: Math.max(near.confidence, target),
        })
        if (reinforced) {
          logger.withFields({ id: reinforced.id, cosine: near.cosine.toFixed(3) }).log('reinforced existing memory')
          return reinforced
        }
        // Row vanished between read and write (race) — fall through to insert.
      }

      return store.write({ text: clean, kind, importance, characterId, embedding, source, confidence: baseConfidence })
    },

    async recall(query: string, k = 5, characterId?: string): Promise<MemoryRecallResult[]> {
      const embedding = await embedder.embed(query)
      return store.recall(embedding, k, characterId)
    },

    async recent(n = 10, characterId?: string): Promise<MemoryEntry[]> {
      return store.recent(n, characterId)
    },

    async list(opts: MemoryListOptions = {}): Promise<MemoryEntry[]> {
      return store.list(opts)
    },

    /** Soft delete by id. Returns false if the id was unknown / already deleted. */
    async delete(id: string): Promise<boolean> {
      return store.softDelete(id)
    },

    /** Undo a soft delete by id. */
    async restore(id: string): Promise<boolean> {
      return store.restore(id)
    },

    /** Edit a memory in place; re-embeds when the text changes so recall stays accurate. */
    async update(id: string, patch: MemoryUpdateArgs): Promise<MemoryEntry | null> {
      const embedding = typeof patch.text === 'string'
        ? await embedder.embed(patch.text.trim())
        : undefined
      return store.update(id, {
        text: typeof patch.text === 'string' ? patch.text.trim() : undefined,
        kind: patch.kind,
        importance: patch.importance,
        confidence: patch.confidence,
        embedding,
      })
    },

    /**
     * Forget the memory that a free-text query refers to (powers the "forget" tool).
     * Selection is by RAW cosine via nearest() — NOT recall()'s boosted score, which
     * would make important memories MORE likely to be the deletion victim. Requires
     * a high cosine match and refuses to fuzzy-delete protected (important) rows, so
     * a vague "forget X" can never silently nuke a safety-critical fact.
     * Returns: the removed entry, or { skipped } describing why nothing was deleted.
     */
    async forgetByQuery(query: string, characterId?: string): Promise<{ removed?: MemoryNeighbor, skipped?: string }> {
      const embedding = await embedder.embed(query.trim())
      const [near] = await store.nearest(embedding, characterId, 1)
      if (!near || near.cosine < FORGET_COSINE_FLOOR)
        return { skipped: 'no_close_match' }
      if (near.importance >= PROTECTED_IMPORTANCE || near.source === 'user_confirmed')
        return { skipped: 'protected', removed: undefined }
      const ok = await store.softDelete(near.id)
      return ok ? { removed: near } : { skipped: 'gone' }
    },

    /**
     * Correct a memory in place: find the row a free-text query refers to and
     * replace its text (re-embedding), PRESERVING its importance so a correction
     * never downgrades a safety-critical fact. Atomic single-row update — no
     * delete-then-write window. If nothing matches closely, inserts the corrected
     * fact as a new 'self' memory rather than deleting anything.
     */
    async correct(wrong: string, correct: string, characterId?: string): Promise<MemoryEntry | null> {
      const clean = correct.trim()
      const wrongEmbedding = await embedder.embed(wrong.trim())
      const [near] = await store.nearest(wrongEmbedding, characterId, 1)
      if (near && near.cosine >= FORGET_COSINE_FLOOR) {
        const newEmbedding = await embedder.embed(clean)
        const updated = await store.update(near.id, {
          text: clean,
          embedding: newEmbedding,
          // keep the matched row's importance; corrections shouldn't demote it
          confidence: Math.max(near.confidence, DEFAULT_CONFIDENCE.self),
        })
        if (updated) {
          logger.withFields({ id: updated.id, cosine: near.cosine.toFixed(3) }).log('corrected memory in place')
          return updated
        }
      }
      // Nothing close to correct → record the corrected fact fresh (non-destructive).
      return this.write({ text: clean, kind: 'fact', importance: 3, characterId, source: 'self' })
    },

    /** Hard-delete soft-deleted rows past the undo window — bounds table growth. */
    async pruneSoftDeleted(olderThanDays = SOFT_DELETE_TTL_DAYS): Promise<number> {
      const n = await store.pruneSoftDeleted(olderThanDays)
      if (n > 0)
        logger.withFields({ pruned: n }).log('pruned expired soft-deleted memories')
      return n
    },

    /** Warm the embedding pipeline so the first real recall doesn't time out. */
    async warm(): Promise<void> {
      try {
        await embedder.embed('warmup')
        logger.log('embedding pipeline warmed')
      }
      catch (err) {
        logger.withError(err as Error).warn('embedding warmup failed (will lazy-load on first use)')
      }
    },
  }
}

export type MemoryService = ReturnType<typeof createMemoryService>

import type { SQL } from 'drizzle-orm'

import type {
  MemoryEntry,
  MemoryKind,
  MemoryListOptions,
  MemoryNeighbor,
  MemoryRecallResult,
  MemoryReinforcePatch,
  MemorySource,
  MemoryUpdatePatch,
  MemoryWriteInput,
  ShortTermMemoryReader,
  ShortTermMemoryStore,
} from './ports'

import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'

interface MemoryRow {
  id: string
  text: string
  kind: string
  importance: number
  characterId: string | null
  embedding: number[] | string
  source: string | null
  confidence: number | null
  reinforceCount: number | null
  lastSeenAt: Date | string | null
  deletedAt: Date | string | null
  createdAt: Date | string
}

function asDate(v: Date | string | null | undefined): Date | null {
  if (v == null)
    return null
  return typeof v === 'string' ? new Date(v) : v
}

function toEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    text: row.text,
    kind: row.kind as MemoryKind,
    importance: row.importance,
    characterId: row.characterId,
    embedding: typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding,
    source: (row.source ?? 'extracted') as MemorySource,
    confidence: typeof row.confidence === 'number' ? row.confidence : 0.6,
    reinforceCount: typeof row.reinforceCount === 'number' ? row.reinforceCount : 1,
    lastSeenAt: asDate(row.lastSeenAt),
    deletedAt: asDate(row.deletedAt),
    createdAt: asDate(row.createdAt) ?? new Date(0),
  }
}

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

interface MemoriesTable {
  id: any
  text: any
  embedding: any
  kind: any
  importance: any
  characterId: any
  source: any
  confidence: any
  reinforceCount: any
  lastSeenAt: any
  deletedAt: any
  createdAt: any
}

// --- Recall ranking knobs -------------------------------------------------
// Ranking is MULTIPLICATIVE: score = cosine * (1 + importance + recency +
// confidence + reinforce). Relevance (cosine) is always the base, so a more
// relevant memory can't be overtaken by a less relevant but "important" one —
// the boosts only re-order memories of comparable relevance. (An additive blend
// was tried first and let an importance-5 fact outrank a directly-on-topic one,
// because MiniLM compresses cosines into a narrow ~0.2–0.7 band.)
export const RECALL_WEIGHTS = { importance: 0.15, recency: 0.08, confidence: 0.08, reinforce: 0.04 }
// Hard relevance floor for INJECTION. Tuned on real MiniLM cosines for this
// store: clearly-relevant queries land ~0.33+ ("his school" → "international
// school" = 0.335), while off-topic queries top out well below ("weather" ≈
// 0.06, "quantum physics" ≈ 0.18). 0.33 keeps on-topic facts and stops random
// fact-blurting. (Dedup uses nearest() with raw cosine + its own threshold.)
export const RECALL_COSINE_FLOOR = 0.33
// Relative gate: once we have a best hit, drop anything more than this far below
// it. Strong match => only closely-related facts inject; weak best => inject little.
export const RECALL_REL_GATE = 0.13
// Recency half-life: a fact last seen this many days ago contributes ~0.5 recency.
export const RECALL_RECENCY_HALF_LIFE_DAYS = 45
// Importance at/above which a memory NEVER decays out of recall (safety-critical
// facts like allergies must not age away). Recency is pinned to 1 for these.
export const RECALL_NO_DECAY_IMPORTANCE = 4
// Over-fetch this many nearest rows, then re-rank with the blend and take top-k.
export const RECALL_OVERFETCH = 50

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * PGlite (and stock pgvector) implementation of the Alaya STM store/reader.
 * Constructed with a Drizzle db instance and the `memories` table schema —
 * the package stays free of the schema's host-app dependencies.
 *
 * Beyond the original write/recent/recall it adds the foolproofing primitives:
 * nearest (write-time dedup), reinforce/update (correctability), softDelete,
 * a soft-delete-aware list, and a blended recall ranking.
 */
export class PgliteMemoryStore implements ShortTermMemoryStore, ShortTermMemoryReader {
  constructor(private readonly db: any, private readonly memories: MemoriesTable) {}

  /** Active = not soft-deleted and has an embedding. */
  private activeFilter(characterId?: string): SQL | undefined {
    const base = and(isNull(this.memories.deletedAt), isNotNull(this.memories.embedding))
    return characterId ? and(eq(this.memories.characterId, characterId), base) : base
  }

  async write(entry: MemoryWriteInput): Promise<MemoryEntry> {
    if (!entry.embedding)
      throw new Error('PgliteMemoryStore.write requires entry.embedding (caller must embed first)')

    const [row] = await this.db
      .insert(this.memories)
      .values({
        text: entry.text,
        kind: entry.kind,
        importance: entry.importance,
        characterId: entry.characterId ?? null,
        embedding: entry.embedding,
        source: entry.source ?? 'extracted',
        confidence: typeof entry.confidence === 'number' ? clamp(entry.confidence, 0, 1) : 0.6,
        reinforceCount: 1,
        lastSeenAt: sql`now()`,
      })
      .returning()

    return toEntry(row)
  }

  async recent(n = 10, characterId?: string): Promise<MemoryEntry[]> {
    const rows = await this.db
      .select()
      .from(this.memories)
      .where(this.activeFilter(characterId))
      .orderBy(desc(this.memories.createdAt))
      .limit(n)

    return rows.map(toEntry)
  }

  async list(opts: MemoryListOptions = {}): Promise<MemoryEntry[]> {
    const { n = 200, characterId, includeDeleted = false } = opts
    const where = includeDeleted
      ? (characterId ? eq(this.memories.characterId, characterId) : undefined)
      : this.activeFilter(characterId)

    const rows = await this.db
      .select()
      .from(this.memories)
      .where(where)
      .orderBy(desc(this.memories.importance), desc(this.memories.lastSeenAt), desc(this.memories.createdAt))
      .limit(n)

    return rows.map(toEntry)
  }

  /** Nearest active neighbours by cosine — used to dedup before insert. */
  async nearest(queryEmbedding: number[], characterId?: string, limit = 1): Promise<MemoryNeighbor[]> {
    const literal = vectorLiteral(queryEmbedding)
    const cosineExpr = sql<number>`1 - (${this.memories.embedding} <=> ${literal}::vector)`
    const distExpr = sql`${this.memories.embedding} <=> ${literal}::vector`

    const rows = await this.db
      .select({
        id: this.memories.id,
        text: this.memories.text,
        kind: this.memories.kind,
        importance: this.memories.importance,
        source: this.memories.source,
        confidence: this.memories.confidence,
        reinforceCount: this.memories.reinforceCount,
        cosine: cosineExpr,
      })
      .from(this.memories)
      .where(this.activeFilter(characterId))
      .orderBy(distExpr)
      .limit(limit)

    return rows.map((r: any): MemoryNeighbor => ({
      id: r.id,
      text: r.text,
      kind: r.kind as MemoryKind,
      importance: r.importance,
      source: (r.source ?? 'extracted') as MemorySource,
      confidence: typeof r.confidence === 'number' ? r.confidence : 0.6,
      reinforceCount: typeof r.reinforceCount === 'number' ? r.reinforceCount : 1,
      cosine: typeof r.cosine === 'number' ? r.cosine : 0,
    }))
  }

  /** Bump an existing memory on re-observation (and optionally sharpen its text). */
  async reinforce(id: string, patch: MemoryReinforcePatch): Promise<MemoryEntry | null> {
    const set: Record<string, unknown> = { lastSeenAt: sql`now()` }
    if (patch.reinforce)
      set.reinforceCount = sql`${this.memories.reinforceCount} + 1`
    if (typeof patch.importance === 'number')
      set.importance = patch.importance
    if (typeof patch.confidence === 'number')
      set.confidence = clamp(patch.confidence, 0, 1)
    if (typeof patch.text === 'string')
      set.text = patch.text
    if (patch.embedding)
      set.embedding = patch.embedding

    const [row] = await this.db
      .update(this.memories)
      .set(set)
      .where(and(eq(this.memories.id, id), isNull(this.memories.deletedAt)))
      .returning()

    return row ? toEntry(row) : null
  }

  /** Edit a memory in place (used by correction tools / admin). Re-embeds via caller. */
  async update(id: string, patch: MemoryUpdatePatch): Promise<MemoryEntry | null> {
    const set: Record<string, unknown> = { lastSeenAt: sql`now()` }
    if (typeof patch.text === 'string')
      set.text = patch.text
    if (typeof patch.kind === 'string')
      set.kind = patch.kind
    if (typeof patch.importance === 'number')
      set.importance = patch.importance
    if (typeof patch.confidence === 'number')
      set.confidence = clamp(patch.confidence, 0, 1)
    if (patch.embedding)
      set.embedding = patch.embedding

    const [row] = await this.db
      .update(this.memories)
      .set(set)
      .where(and(eq(this.memories.id, id), isNull(this.memories.deletedAt)))
      .returning()

    return row ? toEntry(row) : null
  }

  /** Soft delete — keeps the row for audit/undo but excludes it everywhere. */
  async softDelete(id: string): Promise<boolean> {
    const rows = await this.db
      .update(this.memories)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(this.memories.id, id), isNull(this.memories.deletedAt)))
      .returning({ id: this.memories.id })

    return rows.length > 0
  }

  /** Undo a soft delete — brings a row back into recall/recent/dedup. */
  async restore(id: string): Promise<boolean> {
    const rows = await this.db
      .update(this.memories)
      .set({ deletedAt: null, lastSeenAt: sql`now()` })
      .where(and(eq(this.memories.id, id), isNotNull(this.memories.deletedAt)))
      .returning({ id: this.memories.id })

    return rows.length > 0
  }

  /** Hard-delete rows soft-deleted longer than the undo window — bounds growth. */
  async pruneSoftDeleted(olderThanDays: number): Promise<number> {
    const rows = await this.db
      .delete(this.memories)
      .where(and(
        isNotNull(this.memories.deletedAt),
        sql`${this.memories.deletedAt} < now() - make_interval(days => ${olderThanDays})`,
      ))
      .returning({ id: this.memories.id })

    return rows.length
  }

  async recall(
    queryEmbedding: number[],
    k = 5,
    characterId?: string,
  ): Promise<MemoryRecallResult[]> {
    const literal = vectorLiteral(queryEmbedding)
    const cosineExpr = sql<number>`1 - (${this.memories.embedding} <=> ${literal}::vector)`
    const distExpr = sql`${this.memories.embedding} <=> ${literal}::vector`

    const rows = await this.db
      .select({
        id: this.memories.id,
        text: this.memories.text,
        kind: this.memories.kind,
        importance: this.memories.importance,
        source: this.memories.source,
        confidence: this.memories.confidence,
        reinforceCount: this.memories.reinforceCount,
        lastSeenAt: this.memories.lastSeenAt,
        createdAt: this.memories.createdAt,
        cosine: cosineExpr,
      })
      .from(this.memories)
      .where(this.activeFilter(characterId))
      .orderBy(distExpr)
      .limit(Math.max(k, RECALL_OVERFETCH))

    const now = Date.now()
    const w = RECALL_WEIGHTS

    const scored = rows
      .filter((r: any) => typeof r.cosine === 'number' && r.cosine >= RECALL_COSINE_FLOOR)
      .map((r: any) => {
        const cosine = r.cosine as number
        const importance = clamp(r.importance ?? 1, 1, 5)
        const importanceNorm = (importance - 1) / 4
        const lastSeen = asDate(r.lastSeenAt) ?? asDate(r.createdAt) ?? new Date(now)
        const ageDays = Math.max(0, (now - lastSeen.getTime()) / 86_400_000)
        // Safety-critical facts never decay; everything else fades with a 45d half-life.
        const recency = importance >= RECALL_NO_DECAY_IMPORTANCE
          ? 1
          : Math.exp(-ageDays / RECALL_RECENCY_HALF_LIFE_DAYS)
        const confidence = clamp(typeof r.confidence === 'number' ? r.confidence : 0.6, 0, 1)
        const reinforceNorm = clamp(Math.log2((r.reinforceCount ?? 1) + 1) / 3, 0, 1)
        const boost = 1
          + w.importance * importanceNorm
          + w.recency * recency
          + w.confidence * confidence
          + w.reinforce * reinforceNorm
        const score = cosine * boost
        return {
          id: r.id,
          text: r.text,
          kind: r.kind as MemoryKind,
          importance: r.importance,
          score,
          cosine,
          source: (r.source ?? 'extracted') as MemorySource,
          confidence,
          createdAt: asDate(r.createdAt) ?? new Date(now),
        }
      })

    if (scored.length === 0)
      return []

    // Relative gate: keep only hits within RECALL_REL_GATE cosine of the best hit,
    // so a strong match doesn't drag along weakly-related facts.
    const topCosine = Math.max(...scored.map((s: MemoryRecallResult) => s.cosine ?? 0))
    return scored
      .filter((s: MemoryRecallResult) => (s.cosine ?? 0) >= topCosine - RECALL_REL_GATE)
      .sort((a: MemoryRecallResult, b: MemoryRecallResult) => b.score - a.score)
      .slice(0, k)
  }
}

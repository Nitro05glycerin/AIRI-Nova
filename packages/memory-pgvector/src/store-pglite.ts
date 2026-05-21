import type { SQL } from 'drizzle-orm'

import type {
  MemoryEntry,
  MemoryKind,
  MemoryRecallResult,
  MemoryWriteInput,
  ShortTermMemoryReader,
  ShortTermMemoryStore,
} from './ports'

import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'

interface MemoryRow {
  id: string
  text: string
  kind: string
  importance: number
  characterId: string | null
  embedding: number[] | string
  createdAt: Date | string
}

function toEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    text: row.text,
    kind: row.kind as MemoryKind,
    importance: row.importance,
    characterId: row.characterId,
    embedding: typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding,
    createdAt: typeof row.createdAt === 'string' ? new Date(row.createdAt) : row.createdAt,
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
  createdAt: any
}

/**
 * PGlite (and stock pgvector) implementation of the Alaya STM store/reader.
 * Constructed with a Drizzle db instance and the `memories` table schema —
 * the package stays free of the schema's host-app dependencies.
 */
export class PgliteMemoryStore implements ShortTermMemoryStore, ShortTermMemoryReader {
  constructor(private readonly db: any, private readonly memories: MemoriesTable) {}

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
      })
      .returning()

    return toEntry(row)
  }

  async recent(n = 10, characterId?: string): Promise<MemoryEntry[]> {
    const filter: SQL | undefined = characterId
      ? eq(this.memories.characterId, characterId)
      : undefined

    const rows = await this.db
      .select()
      .from(this.memories)
      .where(filter)
      .orderBy(desc(this.memories.createdAt))
      .limit(n)

    return rows.map(toEntry)
  }

  async recall(
    queryEmbedding: number[],
    k = 5,
    characterId?: string,
  ): Promise<MemoryRecallResult[]> {
    const literal = vectorLiteral(queryEmbedding)
    const scoreExpr = sql<number>`1 - (${this.memories.embedding} <=> ${literal}::vector)`
    const distExpr = sql`${this.memories.embedding} <=> ${literal}::vector`

    const whereClause = characterId
      ? and(eq(this.memories.characterId, characterId), isNotNull(this.memories.embedding))
      : isNotNull(this.memories.embedding)

    const rows = await this.db
      .select({
        id: this.memories.id,
        text: this.memories.text,
        kind: this.memories.kind,
        importance: this.memories.importance,
        createdAt: this.memories.createdAt,
        score: scoreExpr,
      })
      .from(this.memories)
      .where(whereClause)
      .orderBy(distExpr)
      .limit(k)

    return rows
      .filter((r: any) => typeof r.score === 'number' && r.score >= 0.2)
      .map((r: any) => ({
        id: r.id,
        text: r.text,
        kind: r.kind as MemoryKind,
        importance: r.importance,
        score: r.score,
        createdAt: typeof r.createdAt === 'string' ? new Date(r.createdAt) : r.createdAt,
      }))
  }
}

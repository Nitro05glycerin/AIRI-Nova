import type { InferSelectModel } from 'drizzle-orm'

import { customType, integer, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core'

const EMBEDDING_DIMENSIONS = 384

const vector = customType<{ data: number[], driverData: string }>({
  dataType() {
    return `vector(${EMBEDDING_DIMENSIONS})`
  },
  toDriver(value) {
    return `[${value.join(',')}]`
  },
  fromDriver(value) {
    if (typeof value === 'string')
      return JSON.parse(value) as number[]

    return value as unknown as number[]
  },
})

export const memories = pgTable('memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  text: text('text').notNull(),
  kind: text('kind').notNull(),
  importance: integer('importance').notNull().default(1),
  characterId: text('character_id'),
  embedding: vector('embedding').notNull(),
  // Provenance: who asserted this. 'extracted' = planner from the user's turn,
  // 'self' = Nova deliberately saved it via a tool, 'user_confirmed' = explicit.
  // Recall trusts higher-provenance memories slightly more (see confidence blend).
  source: text('source').notNull().default('extracted'),
  // 0..1 trust. Reinforced on dedup-merge; nudged up when corroborated.
  confidence: real('confidence').notNull().default(0.6),
  // Times this fact has been re-seen (dedup-merge bumps it). Drives a tiny recall boost.
  reinforceCount: integer('reinforce_count').notNull().default(1),
  // Last time the fact was written or reinforced — recency decay is computed from this.
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  // Soft delete: non-null => excluded from recall/recent/dedup but kept for audit/undo.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Memory = InferSelectModel<typeof memories>

export const MEMORY_EMBEDDING_DIMENSIONS = EMBEDDING_DIMENSIONS

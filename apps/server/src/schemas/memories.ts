import type { InferSelectModel } from 'drizzle-orm'

import { customType, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Memory = InferSelectModel<typeof memories>

export const MEMORY_EMBEDDING_DIMENSIONS = EMBEDDING_DIMENSIONS

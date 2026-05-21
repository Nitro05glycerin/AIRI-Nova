import type { MemoryService } from '../services/memory'
import type { HonoEnv } from '../types/hono'

import { Hono } from 'hono'
import { number, object, optional, picklist, pipe, safeParse, string, toMaxValue, toMinValue, integer as vInteger } from 'valibot'

import { authGuard } from '../middlewares/auth'
import { createBadRequestError } from '../utils/error'

const MemoryKindSchema = picklist(['fact', 'preference', 'event', 'context'] as const)

const WriteSchema = object({
  text: string(),
  kind: optional(MemoryKindSchema, 'fact'),
  importance: optional(pipe(number(), vInteger(), toMinValue(1), toMaxValue(5)), 3),
  characterId: optional(string()),
})

const RecallSchema = object({
  query: string(),
  k: optional(pipe(number(), vInteger(), toMinValue(1), toMaxValue(20)), 5),
  characterId: optional(string()),
})

export function createMemoryRoutes(memoryService: MemoryService) {
  return new Hono<HonoEnv>()
    .use('*', authGuard)

    .post('/write', async (c) => {
      const body = await c.req.json().catch(() => null)
      const parsed = safeParse(WriteSchema, body)
      if (!parsed.success)
        throw createBadRequestError('Invalid Request', 'INVALID_REQUEST', parsed.issues)

      const entry = await memoryService.write(parsed.output)
      return c.json(entry, 201)
    })

    .post('/recall', async (c) => {
      const body = await c.req.json().catch(() => null)
      const parsed = safeParse(RecallSchema, body)
      if (!parsed.success)
        throw createBadRequestError('Invalid Request', 'INVALID_REQUEST', parsed.issues)

      const results = await memoryService.recall(parsed.output.query, parsed.output.k, parsed.output.characterId)
      return c.json(results)
    })

    .get('/recent', async (c) => {
      const n = Number(c.req.query('n') ?? 10)
      const characterId = c.req.query('characterId')
      const results = await memoryService.recent(Number.isFinite(n) ? n : 10, characterId)
      return c.json(results)
    })
}

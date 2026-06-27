import type { MemoryService } from '../services/memory'
import type { HonoEnv } from '../types/hono'

import { Hono } from 'hono'
import { maxLength, minLength, number, object, optional, picklist, pipe, safeParse, string, toMaxValue, toMinValue, trim, integer as vInteger } from 'valibot'

import { authGuard } from '../middlewares/auth'
import { createBadRequestError } from '../utils/error'
import { MEMORY_ADMIN_HTML } from './memory-admin-page'

const MemoryKindSchema = picklist(['fact', 'preference', 'event', 'context'] as const)
const MemorySourceSchema = picklist(['extracted', 'self', 'user_confirmed'] as const)
const MemoryTextSchema = pipe(string(), trim(), minLength(8), maxLength(300))
const ConfidenceSchema = pipe(number(), toMinValue(0), toMaxValue(1))
const ImportanceSchema = pipe(number(), vInteger(), toMinValue(1), toMaxValue(5))

const WriteSchema = object({
  text: MemoryTextSchema,
  kind: optional(MemoryKindSchema, 'fact'),
  importance: optional(ImportanceSchema, 3),
  characterId: optional(string()),
  source: optional(MemorySourceSchema, 'extracted'),
  confidence: optional(ConfidenceSchema),
})

const RecallSchema = object({
  query: string(),
  k: optional(pipe(number(), vInteger(), toMinValue(1), toMaxValue(20)), 5),
  characterId: optional(string()),
})

const UpdateSchema = object({
  id: pipe(string(), minLength(1)),
  text: optional(MemoryTextSchema),
  kind: optional(MemoryKindSchema),
  importance: optional(ImportanceSchema),
  confidence: optional(ConfidenceSchema),
})

const DeleteSchema = object({
  id: pipe(string(), minLength(1)),
})

const ForgetSchema = object({
  query: pipe(string(), minLength(1)),
  characterId: optional(string()),
})

const CorrectSchema = object({
  wrong: pipe(string(), minLength(2)),
  correct: MemoryTextSchema,
  characterId: optional(string()),
})

function clampN(raw: string | undefined, dflt: number): number {
  const n = Number(raw ?? dflt)
  if (!Number.isFinite(n))
    return dflt
  return Math.min(500, Math.max(1, Math.trunc(n)))
}

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
      const characterId = c.req.query('characterId')
      const results = await memoryService.recent(clampN(c.req.query('n'), 10), characterId)
      return c.json(results)
    })

    // Full, soft-delete-aware dump for inspection / curation.
    .get('/list', async (c) => {
      const characterId = c.req.query('characterId')
      const includeDeleted = c.req.query('includeDeleted') === '1' || c.req.query('includeDeleted') === 'true'
      const results = await memoryService.list({ n: clampN(c.req.query('n'), 200), characterId, includeDeleted })
      return c.json(results)
    })

    // Edit a memory in place (text/kind/importance/confidence). Re-embeds on text change.
    .post('/update', async (c) => {
      const body = await c.req.json().catch(() => null)
      const parsed = safeParse(UpdateSchema, body)
      if (!parsed.success)
        throw createBadRequestError('Invalid Request', 'INVALID_REQUEST', parsed.issues)

      const { id, ...patch } = parsed.output
      const entry = await memoryService.update(id, patch)
      if (!entry)
        throw createBadRequestError('Memory not found', 'NOT_FOUND')
      return c.json(entry)
    })

    // Soft delete by id (kept for audit/undo, excluded everywhere).
    .post('/delete', async (c) => {
      const body = await c.req.json().catch(() => null)
      const parsed = safeParse(DeleteSchema, body)
      if (!parsed.success)
        throw createBadRequestError('Invalid Request', 'INVALID_REQUEST', parsed.issues)

      const ok = await memoryService.delete(parsed.output.id)
      return c.json({ ok, id: parsed.output.id })
    })

    // Undo a soft delete by id.
    .post('/restore', async (c) => {
      const body = await c.req.json().catch(() => null)
      const parsed = safeParse(DeleteSchema, body)
      if (!parsed.success)
        throw createBadRequestError('Invalid Request', 'INVALID_REQUEST', parsed.issues)

      const ok = await memoryService.restore(parsed.output.id)
      return c.json({ ok, id: parsed.output.id })
    })

    // Hard-delete (permanently) rows soft-deleted longer than ?olderThanDays.
    // Defaults to 30 (safe — only past the undo window); pass 0 to purge ALL
    // tombstones immediately. The daily background prune calls this at 30 too.
    .post('/purge', async (c) => {
      const raw = Number(c.req.query('olderThanDays') ?? 30)
      const days = Number.isFinite(raw) ? Math.max(0, Math.min(3650, raw)) : 30
      const purged = await memoryService.pruneSoftDeleted(days)
      return c.json({ ok: true, purged, olderThanDays: days })
    })

    // Self-contained curation UI — see/edit/delete/restore everything Nova remembers.
    .get('/admin', c => c.html(MEMORY_ADMIN_HTML))

    // Forget the best high-confidence match for a query (powers Nova's "forget"
    // tool). Refuses loose matches and protected (important) rows — see service.
    .post('/forget', async (c) => {
      const body = await c.req.json().catch(() => null)
      const parsed = safeParse(ForgetSchema, body)
      if (!parsed.success)
        throw createBadRequestError('Invalid Request', 'INVALID_REQUEST', parsed.issues)

      const { removed, skipped } = await memoryService.forgetByQuery(parsed.output.query, parsed.output.characterId)
      return c.json({ ok: !!removed, removed: removed ?? null, skipped: skipped ?? null })
    })

    // Correct a memory in place (find by free-text 'wrong', replace with 'correct').
    // Atomic, importance-preserving; powers Nova's "correct_memory" tool.
    .post('/correct', async (c) => {
      const body = await c.req.json().catch(() => null)
      const parsed = safeParse(CorrectSchema, body)
      if (!parsed.success)
        throw createBadRequestError('Invalid Request', 'INVALID_REQUEST', parsed.issues)

      const entry = await memoryService.correct(parsed.output.wrong, parsed.output.correct, parsed.output.characterId)
      return c.json({ ok: !!entry, entry: entry ?? null })
    })
}

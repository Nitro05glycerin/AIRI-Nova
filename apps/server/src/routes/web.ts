import type { HonoEnv } from '../types/hono'

import { Hono } from 'hono'

import { authGuard } from '../middlewares/auth'
import { createBadRequestError } from '../utils/error'

interface SearxResult {
  title?: string
  url?: string
  content?: string
  engine?: string
  publishedDate?: string | null
  score?: number
}

interface CacheEntry {
  at: number
  body: unknown
}

const CACHE_TTL_MS = 60_000
const CACHE_MAX = 50
const DAILY_BUDGET = 200
const SEARCH_TIMEOUT_MS = 8_000

class LRU {
  private map = new Map<string, CacheEntry>()
  get(k: string): unknown | undefined {
    const v = this.map.get(k)
    if (!v)
      return undefined
    if (Date.now() - v.at > CACHE_TTL_MS) {
      this.map.delete(k)
      return undefined
    }
    this.map.delete(k)
    this.map.set(k, v)
    return v.body
  }

  set(k: string, body: unknown): void {
    this.map.set(k, { at: Date.now(), body })
    while (this.map.size > CACHE_MAX) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined)
        break
      this.map.delete(oldest)
    }
  }
}

const cache = new LRU()
const counter = { day: '', count: 0 }

function bumpDailyCounter(): boolean {
  const today = new Date().toISOString().slice(0, 10)
  if (counter.day !== today) {
    counter.day = today
    counter.count = 0
  }
  if (counter.count >= DAILY_BUDGET)
    return false
  counter.count += 1
  return true
}

export function createWebRoutes(searxngUrl: string) {
  const base = searxngUrl.replace(/\/$/, '')

  return new Hono<HonoEnv>()
    .use('*', authGuard)

    .get('/search', async (c) => {
      const q = c.req.query('q')?.trim()
      if (!q)
        throw createBadRequestError('q required')
      const count = Math.min(Math.max(Number(c.req.query('count') ?? 5) || 5, 1), 10)

      const cacheKey = `${q}|${count}`
      const cached = cache.get(cacheKey)
      if (cached)
        return c.json(cached)

      if (!bumpDailyCounter())
        return c.json({ error: 'daily budget exhausted', results: [] }, 429)

      const params = new URLSearchParams({ q, format: 'json', safesearch: '0' })
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
      try {
        const res = await fetch(`${base}/search?${params}`, { signal: controller.signal })
        if (!res.ok)
          return c.json({ error: `searxng ${res.status}`, results: [] }, 502)

        const body = await res.json() as { results?: SearxResult[] }
        const results = (body.results ?? []).slice(0, count).map(r => ({
          title: r.title ?? '',
          url: r.url ?? '',
          snippet: r.content ?? '',
          engine: r.engine ?? '',
          publishedDate: r.publishedDate ?? null,
        }))

        const payload = { query: q, results }
        cache.set(cacheKey, payload)
        return c.json(payload)
      }
      catch (err) {
        return c.json({ error: (err as Error).message, results: [] }, 502)
      }
      finally {
        clearTimeout(timer)
      }
    })

    .get('/stats', async c => c.json({ today: counter.day, queriesToday: counter.count, dailyBudget: DAILY_BUDGET }))
}

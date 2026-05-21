import type { HonoEnv } from '../types/hono'

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import { Hono } from 'hono'

import { authGuard } from '../middlewares/auth'
import { createBadRequestError, createNotFoundError } from '../utils/error'

const MAX_FILE_SIZE = 64 * 1024 // ignore files > 64KB during search
const MAX_READ_BYTES = 8 * 1024 // /read caps response at 8KB
const MAX_MATCHES = 50
const MAX_PREVIEW_CHARS = 200
const SEARCHABLE_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.org', '.rst'])

interface SearchHit {
  path: string
  line: number
  preview: string
}

function isUnderRoot(root: string, candidate: string): boolean {
  const resolved = resolve(candidate)
  return resolved === root || resolved.startsWith(root + sep)
}

function looksLikeText(buf: Buffer): boolean {
  const len = Math.min(buf.length, 1024)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0)
      return false
  }
  return true
}

async function* walk(dir: string, root: string): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  }
  catch {
    return
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.'))
      continue
    if (entry.isSymbolicLink())
      continue
    const full = join(dir, entry.name)
    if (!isUnderRoot(root, full))
      continue
    if (entry.isDirectory()) {
      yield* walk(full, root)
    }
    else if (entry.isFile()) {
      yield full
    }
  }
}

async function searchKnowledge(root: string, query: string, max: number): Promise<SearchHit[]> {
  const needle = query.toLowerCase()
  const hits: SearchHit[] = []

  for await (const filePath of walk(root, root)) {
    if (hits.length >= max)
      break
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
    if (!SEARCHABLE_EXTENSIONS.has(ext))
      continue

    let st: Awaited<ReturnType<typeof stat>>
    try { st = await stat(filePath) }
    catch { continue }

    if (st.size > MAX_FILE_SIZE)
      continue

    let buf: Buffer
    try { buf = await readFile(filePath) }
    catch { continue }

    if (!looksLikeText(buf))
      continue

    const lines = buf.toString('utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        hits.push({
          path: relative(root, filePath),
          line: i + 1,
          preview: lines[i].slice(0, MAX_PREVIEW_CHARS),
        })
        if (hits.length >= max)
          break
      }
    }
  }

  return hits
}

export function createKnowledgeRoutes(knowledgeRoot: string) {
  const root = resolve(knowledgeRoot)

  return new Hono<HonoEnv>()
    .use('*', authGuard)

    .get('/search', async (c) => {
      const q = c.req.query('q')?.trim()
      if (!q)
        throw createBadRequestError('q required')
      const max = Math.min(Number(c.req.query('max') ?? 20) || 20, MAX_MATCHES)

      const hits = await searchKnowledge(root, q, max)
      return c.json(hits)
    })

    .get('/read', async (c) => {
      const requested = c.req.query('path')
      if (!requested)
        throw createBadRequestError('path required')

      const candidate = resolve(root, requested)
      if (!isUnderRoot(root, candidate))
        throw createBadRequestError('path outside knowledge root', 'PATH_OUTSIDE_ROOT')

      let st: Awaited<ReturnType<typeof stat>>
      try { st = await stat(candidate) }
      catch { throw createNotFoundError() }

      if (!st.isFile())
        throw createBadRequestError('not a file')

      const buf = await readFile(candidate)
      if (!looksLikeText(buf))
        throw createBadRequestError('binary file refused', 'BINARY_REFUSED')

      const startLine = Number(c.req.query('start') ?? 1)
      const endLine = Number(c.req.query('end') ?? 0)
      const all = buf.toString('utf8')

      let body: string
      if (startLine > 1 || endLine > 0) {
        const lines = all.split(/\r?\n/)
        const start = Math.max(0, Math.floor(startLine) - 1)
        const end = endLine > 0 ? Math.min(lines.length, Math.floor(endLine)) : lines.length
        body = lines.slice(start, end).join('\n')
      }
      else {
        body = all
      }

      const truncated = Buffer.byteLength(body, 'utf8') > MAX_READ_BYTES
      if (truncated)
        body = body.slice(0, MAX_READ_BYTES)

      return c.json({
        path: relative(root, candidate),
        bytes: Buffer.byteLength(body, 'utf8'),
        truncated,
        content: body,
      })
    })

    .get('/root', async c => c.json({ root, exists: true }))
}

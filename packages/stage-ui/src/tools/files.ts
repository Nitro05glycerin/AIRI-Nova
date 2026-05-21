import { tool } from '@xsai/tool'
import { z } from 'zod'

const tools = [
  tool({
    name: 'knowledge_search',
    description: 'Search Florian\'s personal knowledge notes by keyword. Use only when he references his notes, journals, or asks you to recall something he wrote down. Returns matching lines with file paths.',
    execute: async ({ query, max }) => {
      try {
        const url = `/api/knowledge/search?q=${encodeURIComponent(query)}&max=${max ?? 10}`
        const res = await fetch(url, { credentials: 'include' })
        if (!res.ok)
          return { isError: true, content: [{ type: 'text', text: `knowledge_search ${res.status}` }] }
        const hits = await res.json() as Array<{ path: string, line: number, preview: string }>
        if (hits.length === 0)
          return { content: [{ type: 'text', text: 'No matches.' }] }
        return {
          content: [{
            type: 'text',
            text: hits.map(h => `${h.path}:${h.line}  ${h.preview}`).join('\n'),
          }],
        }
      }
      catch (err) {
        return { isError: true, content: [{ type: 'text', text: (err as Error).message }] }
      }
    },
    parameters: z.object({
      query: z.string().describe('Keyword or phrase to search for (case-insensitive substring match).'),
      max: z.number().int().min(1).max(50).optional().describe('Max number of matches to return. Default 10.'),
    }).strict(),
  }),

  tool({
    name: 'knowledge_read',
    description: 'Read a file from Florian\'s knowledge notes. Use after knowledge_search returns a relevant path. Reads up to 8KB; pass start/end (1-indexed line numbers) to narrow the range.',
    execute: async ({ path, start, end }) => {
      try {
        const params = new URLSearchParams({ path })
        if (start != null)
          params.set('start', String(start))
        if (end != null)
          params.set('end', String(end))
        const res = await fetch(`/api/knowledge/read?${params}`, { credentials: 'include' })
        if (!res.ok)
          return { isError: true, content: [{ type: 'text', text: `knowledge_read ${res.status}` }] }
        const body = await res.json() as { content: string, truncated: boolean, path: string }
        const note = body.truncated ? `\n\n[truncated at 8KB]` : ''
        return { content: [{ type: 'text', text: `${body.path}:\n${body.content}${note}` }] }
      }
      catch (err) {
        return { isError: true, content: [{ type: 'text', text: (err as Error).message }] }
      }
    },
    parameters: z.object({
      path: z.string().describe('Relative path from the knowledge root, as returned by knowledge_search.'),
      start: z.number().int().min(1).optional().describe('Optional 1-indexed start line.'),
      end: z.number().int().min(1).optional().describe('Optional 1-indexed end line (inclusive).'),
    }).strict(),
  }),
]

export const files = async () => Promise.all(tools)

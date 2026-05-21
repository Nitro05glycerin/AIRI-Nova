import { tool } from '@xsai/tool'
import { z } from 'zod'

const tools = [
  tool({
    name: 'web_search',
    description: 'Search the web for current information. Use ONLY when the answer requires fresh facts you don\'t know, recent events, or Florian explicitly asks you to look something up. Do not use for general chat, opinions, or things you can reason about. Returns title, url, and snippet for each hit.',
    execute: async ({ query, count }) => {
      try {
        const url = `/api/web/search?q=${encodeURIComponent(query)}&count=${count ?? 5}`
        const res = await fetch(url, { credentials: 'include' })
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          return { isError: true, content: [{ type: 'text', text: `web_search ${res.status}: ${body.slice(0, 200)}` }] }
        }
        const body = await res.json() as { results: Array<{ title: string, url: string, snippet: string }> }
        if (!body.results?.length)
          return { content: [{ type: 'text', text: 'No results.' }] }

        const formatted = body.results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
          .join('\n\n')
        return { content: [{ type: 'text', text: formatted }] }
      }
      catch (err) {
        return { isError: true, content: [{ type: 'text', text: (err as Error).message }] }
      }
    },
    parameters: z.object({
      query: z.string().describe('The search query.'),
      count: z.number().int().min(1).max(10).optional().describe('Number of results to return. Default 5.'),
    }).strict(),
  }),
]

export const web = async () => Promise.all(tools)

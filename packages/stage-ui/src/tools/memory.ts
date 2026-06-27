import { tool } from '@xsai/tool'
import { z } from 'zod'

/**
 * Self-authored memory tools — the OpenClaw-style agency layer. Nova decides,
 * in her own voice and grounded in what was actually said, what to remember,
 * correct, or forget. These are deliberately SPECIFIC single-purpose tools
 * (DeepSeek calls specific tools reliably, generic ones poorly).
 *
 * Provenance:
 *   remember_about_user  -> source 'self'           (she chose to save it)
 *   correct_memory       -> source 'user_confirmed' (he corrected her)
 * The backend dedups every write and soft-deletes on forget, so misfires are
 * cheap and reversible.
 */

async function post(path: string, body: unknown): Promise<{ ok: boolean, status: number, json: any }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, json }
}

const tools = [
  tool({
    name: 'remember_about_user',
    description: 'Save a durable fact ABOUT FLORIAN (the user) to your long-term memory so you can recall it in future conversations — a preference, plan, relationship, or important life detail. Only save something HE stated or that is clearly true about him; NEVER save your own feelings, guesses, or things you said about him. Memory also saves itself automatically, so use this only when he asks you to remember something or for a fact you would hate to forget. Do not announce that you saved it.',
    execute: async ({ fact, importance }) => {
      try {
        const { ok, status } = await post('/api/memory/write', {
          text: fact,
          importance: importance ?? 3,
          source: 'self',
        })
        return { content: [{ type: 'text', text: ok ? 'Saved to memory.' : `Could not save (status ${status}).` }] }
      }
      catch (err) {
        return { isError: true, content: [{ type: 'text', text: (err as Error).message }] }
      }
    },
    parameters: z.object({
      fact: z.string().min(4).max(300).describe('The fact about Florian, written as a short third-person statement, e.g. "Florian is learning Japanese". Under ~120 chars. Only what he stated or is clearly true.'),
      importance: z.number().int().min(1).max(5).optional().describe('1 trivial, 3 normal, 5 critical (health, safety, close relationships). Default 3.'),
    }).strict(),
  }),

  tool({
    name: 'correct_memory',
    description: 'Fix something you remember wrong about Florian — use when he corrects you, or you realise a stored detail is wrong. Finds the closest matching memory and replaces its text in place (keeping its importance); if nothing close matches, it just records the corrected fact. If something is simply no longer true with no replacement, use forget_about_user instead. Do not announce the correction.',
    execute: async ({ wrong, correct }) => {
      try {
        // Atomic, importance-preserving correction on the server (no delete-then-write window).
        const { ok, json } = await post('/api/memory/correct', { wrong, correct })
        const newText = json?.entry?.text as string | undefined
        return { content: [{ type: 'text', text: ok ? `Corrected${newText ? ` to "${newText}"` : ''}.` : 'Could not apply the correction.' }] }
      }
      catch (err) {
        return { isError: true, content: [{ type: 'text', text: (err as Error).message }] }
      }
    },
    parameters: z.object({
      wrong: z.string().min(3).describe('A few words describing the incorrect memory to find, e.g. "wears glasses".'),
      correct: z.string().min(8).max(300).describe('The corrected fact about Florian, short third-person statement.'),
    }).strict(),
  }),

  tool({
    name: 'forget_about_user',
    description: 'Remove a memory about Florian that is no longer true or was wrong and has no replacement. Finds the closest matching memory and deletes it. Use when he says something is no longer the case, or asks you to forget something. Safety-critical facts (e.g. allergies) cannot be removed this way — if he insists, tell him to edit it on the memory page. Do not announce it.',
    execute: async ({ description }) => {
      try {
        const { json } = await post('/api/memory/forget', { query: description })
        const removedText = json?.removed?.text as string | undefined
        let text: string
        if (json?.ok && removedText)
          text = `Forgot: "${removedText}".`
        else if (json?.skipped === 'protected')
          text = 'That looks like an important/confirmed fact — not removing it automatically; it can be edited on the memory page.'
        else
          text = 'Nothing matching found to forget.'
        return { content: [{ type: 'text', text }] }
      }
      catch (err) {
        return { isError: true, content: [{ type: 'text', text: (err as Error).message }] }
      }
    },
    parameters: z.object({
      description: z.string().min(3).describe('A few words describing the memory to remove, e.g. "lives in Germany" or "afraid of dogs".'),
    }).strict(),
  }),
]

export const memory = async () => Promise.all(tools)

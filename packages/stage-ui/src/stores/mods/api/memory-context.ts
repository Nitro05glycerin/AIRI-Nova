/**
 * Memory context mod — Nova's backend brain integration on the client side.
 *
 * Registers:
 *   - onChatTurnComplete: runs a small planner LLM call against the same
 *     provider/model Nova is using, extracts memory candidates, and writes
 *     them to apps/server via /api/memory/write. Fire-and-forget; never
 *     blocks the chat path.
 *
 * Auto-recall (onBeforeSend) is registered in a later phase from the same
 * store so all memory-side wiring lives in one place.
 */

import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type { MemoryKind } from '../../memory-bridge'

import { streamText } from '@xsai/stream-text'
import { Mutex } from 'es-toolkit'
import { defineStore, storeToRefs } from 'pinia'
import { ref } from 'vue'

import { useChatOrchestratorStore } from '../../chat'
import { recallMemory, writeMemory } from '../../memory-bridge'
import { useConsciousnessStore } from '../../modules/consciousness'
import { useProvidersStore } from '../../providers'

interface PlannerCandidate {
  text: string
  kind: MemoryKind
  importance: number
}

const PLANNER_SYSTEM_PROMPT = `You are a memory curator for an AI companion named Nova. Given one user/assistant turn, identify durable information worth remembering about the USER (the human, not Nova).

Output ONLY a JSON array. Each item: {"text": string, "kind": "fact"|"preference"|"event"|"context", "importance": 1-5}. No preamble, no markdown fences, no commentary.

Rules:
- Only record information ABOUT THE USER: preferences, facts, decisions, ongoing situations they mention. Never record Nova's actions, opinions, or filler.
- Each "text" under 120 chars, third-person about the user.
- kinds: "fact" = stable info; "preference" = likes/dislikes; "event" = something that happened; "context" = ongoing project/situation.
- importance: 1 trivial, 3 normal, 5 critical (health, allergies, relationships).
- If nothing is worth saving, output [].`

const MIN_USER_TEXT_LEN = 40
const PLANNER_TIMEOUT_MS = 10_000
const MAX_CANDIDATES_PER_TURN = 5

const RECALL_K = 4
const RECALL_TIMEOUT_MS = 800
const RECALL_MIN_QUERY_LEN = 3

function dlog(...args: unknown[]): void {
  if (typeof localStorage !== 'undefined' && localStorage.getItem('airi:debug') === '1')
    console.log('[memory]', ...args)
}

const TOOL_GUIDANCE = [
  'You have access to: web_search (current web info), knowledge_search + knowledge_read (Florian\'s personal notes folder), and any MCP tools.',
  'Use tools sparingly — only when the answer requires fresh info, his notes, or something you genuinely don\'t know. Don\'t call them for casual chat or opinions you can reason about yourself.',
  'Never announce tool calls. Weave the findings into your own voice. Don\'t say "according to my memory" or "I searched the web" — just answer.',
].join(' ')

function parsePlannerOutput(raw: string): PlannerCandidate[] {
  const trimmed = raw.trim()
  // strip optional ```json ... ``` fences if the model adds them despite instruction
  const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  const start = stripped.indexOf('[')
  const end = stripped.lastIndexOf(']')
  if (start < 0 || end < start)
    return []

  let parsed: unknown
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1))
  }
  catch {
    return []
  }
  if (!Array.isArray(parsed))
    return []

  const validKinds = new Set(['fact', 'preference', 'event', 'context'])
  const out: PlannerCandidate[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object')
      continue
    const text = String((item as any).text ?? '').trim()
    const kind = String((item as any).kind ?? '').trim()
    const importance = Number((item as any).importance)
    if (!text || text.length > 240)
      continue
    if (!validKinds.has(kind))
      continue
    if (!Number.isFinite(importance) || importance < 1 || importance > 5)
      continue
    out.push({ text, kind: kind as MemoryKind, importance: Math.round(importance) })
    if (out.length >= MAX_CANDIDATES_PER_TURN)
      break
  }
  return out
}

async function runPlanner(
  chatProvider: ChatProvider,
  model: string,
  userText: string,
  assistantText: string,
): Promise<PlannerCandidate[]> {
  const chatConfig = chatProvider.chat(model)
  let collected = ''

  const planPromise = new Promise<string>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled)
        return
      settled = true
      fn()
    }

    try {
      streamText({
        ...chatConfig,
        messages: [
          { role: 'system', content: PLANNER_SYSTEM_PROMPT },
          { role: 'user', content: `User: ${userText}\nAssistant: ${assistantText}` },
        ],
        onEvent: async (event: any) => {
          if (event?.type === 'text-delta' && typeof event.text === 'string')
            collected += event.text
          else if (event?.type === 'finish')
            settle(() => resolve(collected))
          else if (event?.type === 'error')
            settle(() => reject(event.error ?? new Error('planner stream error')))
        },
      })
    }
    catch (err) {
      settle(() => reject(err))
    }
  })

  const timeout = new Promise<string>((_, reject) => {
    setTimeout(() => reject(new Error('planner timeout')), PLANNER_TIMEOUT_MS)
  })

  const raw = await Promise.race([planPromise, timeout])
  return parsePlannerOutput(raw)
}

export const useMemoryContextStore = defineStore('mods:api:memory-context', () => {
  const mutex = new Mutex()
  const chatOrchestrator = useChatOrchestratorStore()
  const consciousnessStore = useConsciousnessStore()
  const providersStore = useProvidersStore()
  const { activeProvider, activeModel } = storeToRefs(consciousnessStore)

  const disposeFns = ref<Array<() => void>>([])
  let initialized = false

  async function ingestTurn(userText: string, assistantText: string): Promise<void> {
    if (!userText || userText.length < MIN_USER_TEXT_LEN)
      return
    if (!activeProvider.value || !activeModel.value)
      return

    let chatProvider: ChatProvider
    try {
      chatProvider = await providersStore.getProviderInstance<ChatProvider>(activeProvider.value)
    }
    catch (err) {
      console.warn('[memory-context] getProviderInstance failed:', err)
      return
    }

    dlog('planner: user=', userText.length, 'chars, assistant=', assistantText.length, 'chars')

    let candidates: PlannerCandidate[]
    try {
      candidates = await runPlanner(chatProvider, activeModel.value, userText, assistantText)
    }
    catch (err) {
      console.warn('[memory-context] planner failed:', err)
      return
    }

    dlog('planner result:', candidates.length, 'candidate(s)', candidates)

    if (candidates.length === 0)
      return

    for (const c of candidates) {
      writeMemory({ text: c.text, kind: c.kind, importance: c.importance })
        .then(() => dlog('wrote memory:', c.kind, '·', c.text))
        .catch(err => console.warn('[memory-context] writeMemory failed:', err))
    }
  }

  async function injectMemoryContext(userText: string, composedMessage: Message[]): Promise<void> {
    // Always inject tool guidance after persona; conditionally inject recall block on top.
    const blocks: string[] = [TOOL_GUIDANCE]

    if (userText && userText.length >= RECALL_MIN_QUERY_LEN) {
      dlog('recall query:', JSON.stringify(userText.slice(0, 80)))
      const results = await recallMemory(userText, RECALL_K, undefined, RECALL_TIMEOUT_MS)
      dlog('recall hits:', results.length, results.map(r => ({ score: r.score.toFixed(3), text: r.text })))
      if (results.length > 0) {
        blocks.push(`Background you may know about the user (do not mention unless directly relevant):\n${results.map(r => `- ${r.text}`).join('\n')}`)
      }
    }

    // Insert just after the initial run of system messages so persona/SOUL keeps priority.
    let insertAt = 0
    while (insertAt < composedMessage.length && composedMessage[insertAt].role === 'system')
      insertAt++

    for (let i = blocks.length - 1; i >= 0; i--)
      composedMessage.splice(insertAt, 0, { role: 'system', content: blocks[i] })

    dlog('injected', blocks.length, 'system block(s) at index', insertAt)
  }

  async function initialize() {
    await mutex.acquire()
    try {
      if (initialized)
        return

      disposeFns.value.push(
        chatOrchestrator.onBeforeSend(async (message, context) => {
          const composed = context.composedMessage as Message[] | undefined
          if (!composed || !Array.isArray(composed))
            return

          try {
            await injectMemoryContext(message, composed)
          }
          catch (err) {
            console.warn('[memory-context] inject failed:', err)
          }
        }),

        chatOrchestrator.onChatTurnComplete(async (chat, context) => {
          const userText = typeof context.message?.content === 'string'
            ? context.message.content
            : Array.isArray(context.message?.content)
              ? context.message.content.map((p: any) => p?.text ?? '').join(' ').trim()
              : ''

          // Fire-and-forget so we never block the chat path.
          void ingestTurn(userText, chat.outputText)
        }),
      )

      initialized = true
    }
    finally {
      mutex.release()
    }
  }

  async function dispose() {
    await mutex.acquire()
    try {
      for (const fn of disposeFns.value)
        fn()

      disposeFns.value = []
      initialized = false
    }
    finally {
      mutex.release()
    }
  }

  return {
    initialize,
    dispose,
  }
})

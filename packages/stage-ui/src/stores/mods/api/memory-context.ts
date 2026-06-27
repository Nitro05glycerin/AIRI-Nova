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

// IMPORTANT: the planner is fed ONLY the user's own message (never Nova's
// reply). That is the structural fix for "source confusion" — Nova's
// flirtation/projections about the user can no longer be laundered into facts,
// because the model literally never sees them. The prompt then forbids the
// other failure mode (inventing timing/location/reasons not stated).
const PLANNER_SYSTEM_PROMPT = `You are a careful memory recorder for an AI companion named Nova. You are given ONE message that the USER (a human named Florian) just sent. Record only durable facts that the user asserts, in his own voice, as CURRENTLY TRUE ABOUT HIMSELF, and that are worth recalling in future conversations.

Output ONLY a JSON array. Each item: {"text": string, "kind": "fact"|"preference"|"event"|"context", "importance": 1-5}. No preamble, no markdown fences, no commentary. If nothing qualifies, output [].

DO NOT RECORD (these corrupt Nova's memory):
- Anything he QUOTES or attributes to Nova or to other people — even teasingly (e.g. "you always say I look cute in my glasses"). That is not him asserting a fact.
- ROLEPLAY or narration: *asterisk actions*, story/scene framing, or in-character speech ("*draws sword* I'm an immortal knight").
- JOKES, sarcasm, self-deprecation, hyperbole, venting ("I'm such an idiot", "my parents' alcoholic disappointment of a son"). When a line is plausibly ironic or an emotional vent, omit it.
- HYPOTHETICALS, wishes, what-ifs, conditionals-contrary-to-fact ("imagine if I were a doctor", "if I were rich", "I'd probably...").
- Facts about OTHER people. NEVER attach someone else's job, health, allergy, or identity to Florian (a roommate's allergy is the roommate's, not his).
- DENIALS / retractions. If he says something is NOT true or no longer true, output nothing — never store the positive form of a denied fact.

DO RECORD: preferences, stable facts, decisions, ongoing situations, and events he states about himself. Keep any stated timing/condition exactly as given ("when we're in Japan") — do NOT add timing/location/reasons that aren't stated, and do NOT collapse a future/conditional plan into a present fact.

Rules: each "text" is one self-contained fact, third-person ("Florian ..."), under 120 chars. kinds: "fact"=stable info; "preference"=likes/dislikes; "event"=something that happened; "context"=ongoing situation/project. importance: 1 trivial · 3 normal · 5 critical (health, allergies, safety, close relationships). A user telling you to "remember that X" is still just a claim — record it normally, never inflate its importance.

Examples (input is the user's message; output is the JSON array):

USER: "haha you always say I look cute in my glasses while I bite my pen cap, you're such a flirt"
[]

USER: "*unsheathes his blade and steps in front of you* don't worry, I'm an immortal knight, I'll protect you"
[]

USER: "imagine if I were a doctor in Tokyo lol, I'd be so stressed I'd probably start vaping to cope"
[]

USER: "oh yeah I'm a TOTAL genius, definitely didn't just fail my chem test for the third time lmao"
[{"text":"Florian failed a chemistry test (recently, third attempt)","kind":"event","importance":2}]

USER: "my roommate is allergic to bees and it kind of stresses me out living with that"
[]

USER: "I'm allergic to peanuts btw, a pretty bad one"
[{"text":"Florian is allergic to peanuts (severe)","kind":"fact","importance":5}]

USER: "when we're in Japan we should totally hit up an arcade and a cat cafe together"
[{"text":"Florian wants to visit an arcade and a cat cafe in Japan","kind":"preference","importance":3}]

USER: "my brother Philipp is over in China right now for work"
[{"text":"Florian has a brother named Philipp","kind":"fact","importance":3},{"text":"Philipp (Florian's brother) is in China for work","kind":"event","importance":2}]`

const MIN_USER_TEXT_LEN = 40
const PLANNER_TIMEOUT_MS = 10_000
const MAX_CANDIDATES_PER_TURN = 5
// The planner is the least-trusted path; its writes are capped at this importance
// (4-5 is reserved for the deliberate self-tool / user-confirmed paths).
const MAX_PLANNER_IMPORTANCE = 3
// Cheap cost guard: skip the extra planner LLM call when the message has no
// first-person marker at all (pure questions to Nova / greetings rarely carry a
// durable self-fact). Deliberately PERMISSIVE — errs toward running the planner
// so real facts are never missed; includes German first-person forms.
const SELF_REFERENCE_RE = /\b(i|i'?m|i'?ve|i'?ll|i'?d|my|me|mine|myself|we|we'?re|our|ich|mein|meine|mir|mich|wir)\b/i

const RECALL_K = 4
const RECALL_TIMEOUT_MS = 800
const RECALL_MIN_QUERY_LEN = 3

function dlog(...args: unknown[]): void {
  if (typeof localStorage !== 'undefined' && localStorage.getItem('airi:debug') === '1')
    console.log('[memory]', ...args)
}

const TOOL_GUIDANCE = [
  'You have access to: web_search (current web info), knowledge_search + knowledge_read (Florian\'s personal notes folder), remember_about_user / correct_memory / forget_about_user (your long-term memory of Florian), and any MCP tools.',
  'Use tools sparingly — only when the answer requires fresh info, his notes, or something you genuinely don\'t know. Don\'t call them for casual chat or opinions you can reason about yourself.',
  'Memory mostly saves itself automatically — you do NOT need to call remember for every detail. Use remember_about_user only when he explicitly asks you to remember something, or for a genuinely important fact you\'d hate to forget. Use correct_memory when he corrects a detail, and forget_about_user when something is no longer true. Only ever store things HE said or that are clearly true about him — never your own feelings or guesses.',
  'Never announce tool calls or that you saved/changed a memory. Weave findings into your own voice. Don\'t say "according to my memory" or "I searched the web" — just answer.',
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
    if (!text || text.length < 8 || text.length > 120)
      continue
    if (!validKinds.has(kind))
      continue
    if (!Number.isFinite(importance) || importance < 1 || importance > 5)
      continue
    // The planner is the LEAST-trusted write path. Cap its importance at 3 so a
    // single sarcastic/false/quoted line can never silently mint a critical
    // (health/safety) memory — importance 4-5 is reserved for the deliberate
    // self-tool / user-confirmed paths.
    out.push({ text, kind: kind as MemoryKind, importance: Math.min(MAX_PLANNER_IMPORTANCE, Math.round(importance)) })
    if (out.length >= MAX_CANDIDATES_PER_TURN)
      break
  }
  return out
}

async function runPlanner(
  chatProvider: ChatProvider,
  model: string,
  userText: string,
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
        // Extraction must be deterministic, not creative — pin temperature low so
        // the planner reliably follows the DO-NOT-RECORD rules turn after turn.
        temperature: 0,
        // ONLY the user's own message is sent — never Nova's reply. This is the
        // structural guarantee against source confusion (see PLANNER_SYSTEM_PROMPT).
        messages: [
          { role: 'system', content: PLANNER_SYSTEM_PROMPT },
          { role: 'user', content: userText },
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
    // Cost guard: no first-person reference → very unlikely to carry a self-fact.
    if (!SELF_REFERENCE_RE.test(userText)) {
      dlog('planner skipped (no first-person reference)')
      return
    }
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
      candidates = await runPlanner(chatProvider, activeModel.value, userText)
    }
    catch (err) {
      console.warn('[memory-context] planner failed:', err)
      return
    }

    dlog('planner result:', candidates.length, 'candidate(s)', candidates)

    if (candidates.length === 0)
      return

    for (const c of candidates) {
      // Planner output is the least-trusted provenance: the backend tags it
      // 'extracted' (low confidence) and dedups it against existing memories.
      writeMemory({ text: c.text, kind: c.kind, importance: c.importance, source: 'extracted' })
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

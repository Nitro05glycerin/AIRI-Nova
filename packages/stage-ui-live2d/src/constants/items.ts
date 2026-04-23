// Single source of truth for Live2D item toggles (accessories, hairstyle, hand items)
// for the kyokiStudio bear pajama model. Used by:
// - stores/live2d.ts (canonical state + setters)
// - components/scenarios/settings/model-settings/live2d.vue (settings UI)
// - composables/queues.ts (ITEM token parser from LLM output)
//
// The params referenced here are specific to the kyokiStudio bear pajama Live2D rig.
// To support other models, extend this with per-model item catalogs.

export interface ItemDef {
  label: string
  params: Record<string, number>
}

export const ACCESSORIES: ItemDef[] = [
  { label: 'Glasses', params: { Param8: 1 } },
  { label: 'Hat', params: { Param11: 1 } },
  { label: 'Cat Ears', params: { Param90: 1 } },
  { label: 'Box', params: { Param74: 1 } },
  { label: 'Pillow', params: { Param123: 1 } },
  { label: 'Sticky Note', params: { Param57: 1 } },
  { label: 'White Board', params: { Param127: 1 } },
  { label: 'Mouse', params: { Param139: 0.964 } },
  { label: 'Coat', params: { Param22: 1 } },
  { label: 'Sweater', params: { Param148: 1 } },
  { label: 'Flying', params: { Param: 1 } },
]

export const HAIRSTYLES: ItemDef[] = [
  { label: 'Default', params: {} },
  { label: 'Black Braids', params: { Param16: 1 } },
  { label: 'White Hair', params: { Param14: 1, Param15: 1, Param144: 1 } },
  { label: 'White Ponytail', params: { Param14: 1, Param15: 1 } },
  { label: 'White Hair Braids', params: { Param14: 1, Param15: 1, Param17: 1 } },
  { label: 'Braided Pigtail', params: { Param62: 1, Param59: 1 } },
  { label: 'Half-up', params: { Param62: 1, Param61: 1 } },
  { label: 'Two Ball', params: { Param62: 1, Param125: 1 } },
]

export const HAND_ITEMS: ItemDef[] = [
  { label: 'None', params: {} },
  { label: 'Teddy Bear', params: { Param5: 1, Param3: 1, Param152: 1 } },
  { label: 'Pen (left)', params: { Param128: 1, Param4: 1, Param152: 1 } },
  { label: 'Pen (right)', params: { Param139: 1, Param4: 1, Param152: 1 } },
  { label: 'Eating', params: { Param6: 1, Param152: 1 } },
  { label: 'Game Controller', params: { Param3: 1, Param152: 1 } },
]

// Emotion-controlled params — itemParams never writes to these.
// The emotion pipeline (expressionParams) owns them.
export const EMOTION_PARAMS = new Set([
  'Param9',
  'Param10',
  'Param12',
  'Param87',
  'Param88',
  'Param94',
  'Param95',
  'Param96',
  'Param97',
])

// Union of every Param any item in any category touches.
// Used by rebuildItemParams to zero the whole surface before applying active state.
const ALL_ITEM_PARAMS: Set<string> = new Set([
  ...ACCESSORIES.flatMap(a => Object.keys(a.params)),
  ...HAIRSTYLES.flatMap(h => Object.keys(h.params)),
  ...HAND_ITEMS.flatMap(h => Object.keys(h.params)),
])

export interface ItemState {
  accessories: boolean[]
  hairstyle: number
  handItem: number
}

export function defaultItemState(): ItemState {
  return {
    accessories: ACCESSORIES.map(() => false),
    hairstyle: 0,
    handItem: 0,
  }
}

// Rebuild the full Live2D param map from the current state.
// Order: zero every item param, then apply hairstyle, accessories, handItem.
// handItem applies last so it wins on shared params (Param139 conflicts with Mouse accessory).
export function buildItemParams(state: ItemState): Record<string, number> {
  const params: Record<string, number> = {}

  for (const p of ALL_ITEM_PARAMS) params[p] = 0

  const hair = HAIRSTYLES[state.hairstyle]
  if (hair)
    Object.assign(params, hair.params)

  state.accessories.forEach((on, i) => {
    if (on && ACCESSORIES[i])
      Object.assign(params, ACCESSORIES[i].params)
  })

  const hand = HAND_ITEMS[state.handItem]
  if (hand)
    Object.assign(params, hand.params)

  for (const p of EMOTION_PARAMS) delete params[p]

  return params
}

export function findAccessoryIndex(label: string): number {
  return ACCESSORIES.findIndex(a => a.label.toLowerCase() === label.toLowerCase())
}

export function findHairstyleIndex(label: string): number {
  return HAIRSTYLES.findIndex(h => h.label.toLowerCase() === label.toLowerCase())
}

export function findHandItemIndex(label: string): number {
  return HAND_ITEMS.findIndex(h => h.label.toLowerCase() === label.toLowerCase())
}

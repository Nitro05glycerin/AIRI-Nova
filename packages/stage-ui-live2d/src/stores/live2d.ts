import type { ItemState } from '../constants/items'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { useBroadcastChannel } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import {
  buildItemParams,
  defaultItemState,
  findAccessoryIndex,
  findHairstyleIndex,
  findHandItemIndex,
} from '../constants/items'

type BroadcastChannelEvents
  = | BroadcastChannelEventShouldUpdateView

interface BroadcastChannelEventShouldUpdateView {
  type: 'live2d-should-update-view'
}

export const defaultModelParameters = {
  angleX: 0,
  angleY: 0,
  angleZ: 0,
  leftEyeOpen: 1,
  rightEyeOpen: 1,
  leftEyeSmile: 0,
  rightEyeSmile: 0,
  leftEyebrowLR: 0,
  rightEyebrowLR: 0,
  leftEyebrowY: 0,
  rightEyebrowY: 0,
  leftEyebrowAngle: 0,
  rightEyebrowAngle: 0,
  leftEyebrowForm: 0,
  rightEyebrowForm: 0,
  mouthOpen: 0,
  mouthForm: 0,
  cheek: 0,
  bodyAngleX: 0,
  bodyAngleY: 0,
  bodyAngleZ: 0,
  breath: 0,
}

const ITEM_TOGGLES_STORAGE_KEY = 'settings/live2d/item-toggles'

function loadItemStateFromStorage(): ItemState {
  try {
    const raw = localStorage.getItem(ITEM_TOGGLES_STORAGE_KEY)
    if (!raw)
      return defaultItemState()
    const parsed = JSON.parse(raw) as Partial<ItemState>
    const base = defaultItemState()
    return {
      accessories: Array.isArray(parsed.accessories) && parsed.accessories.length === base.accessories.length
        ? parsed.accessories.map(v => !!v)
        : base.accessories,
      hairstyle: typeof parsed.hairstyle === 'number' ? parsed.hairstyle : base.hairstyle,
      handItem: typeof parsed.handItem === 'number' ? parsed.handItem : base.handItem,
    }
  }
  catch {
    return defaultItemState()
  }
}

function persistItemState(state: ItemState) {
  try {
    localStorage.setItem(ITEM_TOGGLES_STORAGE_KEY, JSON.stringify(state))
  }
  catch {}
}

export const useLive2d = defineStore('live2d', () => {
  const { post, data } = useBroadcastChannel<BroadcastChannelEvents, BroadcastChannelEvents>({ name: 'airi-stores-stage-ui-live2d' })
  const shouldUpdateViewHooks = ref(new Set<() => void>())

  const onShouldUpdateView = (hook: () => void) => {
    shouldUpdateViewHooks.value.add(hook)
    return () => {
      shouldUpdateViewHooks.value.delete(hook)
    }
  }

  function shouldUpdateView() {
    post({ type: 'live2d-should-update-view' })
    shouldUpdateViewHooks.value.forEach(hook => hook())
  }

  watch(data, (event) => {
    if (event?.type === 'live2d-should-update-view') {
      shouldUpdateViewHooks.value.forEach(hook => hook())
    }
  })

  const position = useLocalStorageManualReset<{ x: number, y: number }>('settings/live2d/position', { x: 0, y: 0 })
  const positionInPercentageString = computed(() => ({
    x: `${position.value.x}%`,
    y: `${position.value.y}%`,
  }))
  const currentMotion = useLocalStorageManualReset<{ group: string, index?: number }>('settings/live2d/current-motion', () => ({ group: 'Idle', index: 0 }))
  const availableMotions = useLocalStorageManualReset<{ motionName: string, motionIndex: number, fileName: string }[]>('settings/live2d/available-motions', () => [])
  const motionMap = useLocalStorageManualReset<Record<string, string>>('settings/live2d/motion-map', {})
  const scale = useLocalStorageManualReset('settings/live2d/scale', 1)

  const modelParameters = useLocalStorageManualReset<Record<string, number>>('settings/live2d/parameters', defaultModelParameters)

  // Expression parameters for emotion overrides (e.g. Param9, Param12 for kyokiStudio models)
  const expressionParams = ref<Record<string, number>>({})

  // Canonical item state: drives the itemParams derived below.
  // Both UI toggles and the LLM ITEM-token dispatcher mutate these refs via the setters.
  const itemState = ref<ItemState>(loadItemStateFromStorage())

  // Derived Live2D param map applied every frame by Model.vue.
  // Always a fresh object that zeros all item params first, then sets active ones —
  // fixes the "4 arms" residue bug where a prior item's params weren't cleared when swapping.
  const itemParams = ref<Record<string, number>>(buildItemParams(itemState.value))

  function syncItemParams() {
    itemParams.value = buildItemParams(itemState.value)
    persistItemState(itemState.value)
  }

  function setAccessoryByIndex(idx: number, on: boolean) {
    if (idx < 0 || idx >= itemState.value.accessories.length)
      return false
    const next = itemState.value.accessories.slice()
    next[idx] = on
    itemState.value = { ...itemState.value, accessories: next }
    syncItemParams()
    return true
  }

  function setHairstyleByIndex(idx: number) {
    if (idx < 0)
      return false
    itemState.value = { ...itemState.value, hairstyle: idx }
    syncItemParams()
    return true
  }

  function setHandItemByIndex(idx: number) {
    if (idx < 0)
      return false
    itemState.value = { ...itemState.value, handItem: idx }
    syncItemParams()
    return true
  }

  // Label-based setters for LLM ITEM-token dispatch.
  // Return false on unknown label so the caller can log/drop silently.
  function setAccessory(label: string, on: boolean) {
    const idx = findAccessoryIndex(label)
    if (idx === -1) {
      console.warn(`[live2d] setAccessory: unknown label "${label}"`)
      return false
    }
    return setAccessoryByIndex(idx, on)
  }

  function setHairstyle(label: string) {
    const idx = findHairstyleIndex(label)
    if (idx === -1) {
      console.warn(`[live2d] setHairstyle: unknown label "${label}"`)
      return false
    }
    return setHairstyleByIndex(idx)
  }

  function setHandItem(label: string) {
    const idx = findHandItemIndex(label)
    if (idx === -1) {
      console.warn(`[live2d] setHandItem: unknown label "${label}"`)
      return false
    }
    return setHandItemByIndex(idx)
  }

  function resetState() {
    position.reset()
    currentMotion.reset()
    availableMotions.reset()
    motionMap.reset()
    scale.reset()
    modelParameters.reset()
    shouldUpdateView()
  }

  return {
    position,
    positionInPercentageString,
    currentMotion,
    availableMotions,
    motionMap,
    scale,
    modelParameters,
    expressionParams,

    // Item state + derived params
    itemState,
    itemParams,
    setAccessoryByIndex,
    setHairstyleByIndex,
    setHandItemByIndex,
    setAccessory,
    setHairstyle,
    setHandItem,

    onShouldUpdateView,
    shouldUpdateView,
    resetState,
  }
})

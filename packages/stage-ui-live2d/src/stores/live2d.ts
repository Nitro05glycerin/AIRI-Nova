import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { useBroadcastChannel } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

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

  const position = useLocalStorageManualReset<{ x: number, y: number }>('settings/live2d/position', { x: 0, y: 0 }) // position is relative to the center of the screen, units are %
  const positionInPercentageString = computed(() => ({
    x: `${position.value.x}%`,
    y: `${position.value.y}%`,
  }))
  const currentMotion = useLocalStorageManualReset<{ group: string, index?: number }>('settings/live2d/current-motion', () => ({ group: 'Idle', index: 0 }))
  const availableMotions = useLocalStorageManualReset<{ motionName: string, motionIndex: number, fileName: string }[]>('settings/live2d/available-motions', () => [])
  const motionMap = useLocalStorageManualReset<Record<string, string>>('settings/live2d/motion-map', {})
  const scale = useLocalStorageManualReset('settings/live2d/scale', 1)

  // Live2D model parameters
  const modelParameters = useLocalStorageManualReset<Record<string, number>>('settings/live2d/parameters', defaultModelParameters)

  // Expression parameters for emotion overrides (e.g. Param9, Param12 for kyokiStudio models)
  const expressionParams = ref<Record<string, number>>({})

  // Item parameters for accessories/hairstyles/hand items (applied every frame like expressionParams)
  // Restore saved item toggles from localStorage on store init
  const itemParams = ref<Record<string, number>>({})
  try {
    const raw = localStorage.getItem('settings/live2d/item-toggles')
    if (raw) {
      const saved = JSON.parse(raw)
      // Rebuild itemParams from saved state using the same logic as the settings component
      const accessoryDefs = [
        { params: { Param8: 1 } }, { params: { Param11: 1 } }, { params: { Param90: 1 } },
        { params: { Param74: 1 } }, { params: { Param123: 1 } }, { params: { Param57: 1 } },
        { params: { Param127: 1 } }, { params: { Param139: 0.964 } }, { params: { Param22: 1 } },
        { params: { Param148: 1 } }, { params: { Param: 1 } },
      ]
      const hairstyleDefs = [
        {}, { Param16: 1 }, { Param14: 1, Param15: 1, Param144: 1 },
        { Param14: 1, Param15: 1 }, { Param14: 1, Param15: 1, Param17: 1 },
        { Param62: 1, Param59: 1 }, { Param62: 1, Param61: 1 }, { Param62: 1, Param125: 1 },
      ]
      const handItemDefs = [
        {}, { Param5: 1, Param3: 1, Param152: 1 }, { Param128: 1, Param4: 1, Param152: 1 },
        { Param139: 1, Param4: 1, Param152: 1 }, { Param6: 1, Param152: 1 }, { Param3: 1, Param152: 1 },
      ]
      const result: Record<string, number> = {}
      // Zero all, then set active
      for (const a of accessoryDefs) for (const p of Object.keys(a.params)) result[p] = 0
      if (saved.accessories) saved.accessories.forEach((on: boolean, i: number) => { if (on && accessoryDefs[i]) Object.assign(result, accessoryDefs[i].params) })
      const allHairKeys = new Set(hairstyleDefs.flatMap(h => Object.keys(h)))
      for (const p of allHairKeys) result[p] = 0
      if (hairstyleDefs[saved.hairstyle ?? 0]) Object.assign(result, hairstyleDefs[saved.hairstyle ?? 0])
      const allHandKeys = new Set(handItemDefs.flatMap(h => Object.keys(h)))
      for (const p of allHandKeys) result[p] = 0
      if (handItemDefs[saved.handItem ?? 0]) Object.assign(result, handItemDefs[saved.handItem ?? 0])
      itemParams.value = result
    }
  } catch {}

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
    itemParams,

    onShouldUpdateView,
    shouldUpdateView,
    resetState,
  }
})

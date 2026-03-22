import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { onMounted, watch } from 'vue'

import { useAudioDevice } from '../audio'

export const useSettingsAudioDevice = defineStore('settings-audio-devices', () => {
  const { audioInputs, deviceConstraints, selectedAudioInput: selectedAudioInputNonPersist, startStream, stopStream, stream, askPermission } = useAudioDevice()

  const selectedAudioInputPersist = useLocalStorageManualReset<string>('settings/audio/input', selectedAudioInputNonPersist.value)
  const selectedAudioInputEnabledPersist = useLocalStorageManualReset<boolean>('settings/audio/input/enabled', false)

  watch(selectedAudioInputPersist, (newValue) => {
    selectedAudioInputNonPersist.value = newValue
  })

  watch(selectedAudioInputEnabledPersist, async (val) => {
    if (val) {
      // Ensure permissions first so devices are enumerated (Firefox requires getUserMedia before enumerateDevices)
      if (audioInputs.value.length === 0) {
        try { await askPermission() } catch {}
      }
      // If still no selected input, pick default
      if (!selectedAudioInputPersist.value && audioInputs.value.length > 0) {
        selectedAudioInputPersist.value = audioInputs.value.find(d => d.deviceId === 'default')?.deviceId || audioInputs.value[0].deviceId
        selectedAudioInputNonPersist.value = selectedAudioInputPersist.value
      }
      startStream()
    }
    else {
      stopStream()
    }
  })

  onMounted(() => {
    const hasSelectedInput = selectedAudioInputPersist.value
      && audioInputs.value.some(device => device.deviceId === selectedAudioInputPersist.value)

    if (selectedAudioInputEnabledPersist.value && hasSelectedInput) {
      startStream()
    }
    if (selectedAudioInputNonPersist.value && !selectedAudioInputEnabledPersist.value) {
      selectedAudioInputPersist.value = selectedAudioInputNonPersist.value
    }
  })

  function resetState() {
    selectedAudioInputPersist.reset()
    selectedAudioInputNonPersist.value = ''
    selectedAudioInputEnabledPersist.reset()
    stopStream()
  }

  return {
    audioInputs,
    deviceConstraints,
    selectedAudioInput: selectedAudioInputPersist,
    enabled: selectedAudioInputEnabledPersist,

    stream,

    askPermission,
    startStream,
    stopStream,
    resetState,
  }
})

import type { WavAgentApi } from '@shared/api'

declare global {
  interface Window {
    api: WavAgentApi
  }
}

export {}

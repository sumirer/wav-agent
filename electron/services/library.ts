/**
 * 音频素材库。
 * 统一负责「PCM -> wav 文件 -> 索引记录」这条链路，
 * Agent 生成、波形编辑另存、外部导入三条路径共用同一套逻辑。
 */
import type { ArtifactSource, AudioArtifact, AudioPayload, SynthRecipe } from '../../shared/types'
import { getStore } from './store'
import { computePeaks, decodeWav, encodeWav, MAX_DURATION_SEC } from './wav'

export interface CreateArtifactInput {
  title: string
  description?: string
  prompt?: string
  sampleRate: number
  channels: Float32Array[]
  source: ArtifactSource
  recipe: SynthRecipe | null
  originId?: string | null
  sessionId?: string | null
}

function createId(): string {
  return `a_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function clampChannels(channels: Float32Array[]): Float32Array[] {
  const usable = channels.filter((channel) => channel && channel.length > 0).slice(0, 2)
  if (usable.length === 0) throw new Error('音频数据为空')
  const length = Math.min(...usable.map((channel) => channel.length))
  const maxLength = Math.round(MAX_DURATION_SEC * 192000)
  const finalLength = Math.min(length, maxLength)
  return usable.map((channel) => (channel.length === finalLength ? channel : channel.slice(0, finalLength)))
}

export function createArtifact(input: CreateArtifactInput): AudioArtifact {
  const channels = clampChannels(input.channels)
  const sampleRate = Math.round(input.sampleRate)
  const buffer = encodeWav(channels, sampleRate)
  const id = createId()
  const store = getStore()
  store.writeArtifactAudio(id, buffer)

  const artifact: AudioArtifact = {
    id,
    title: input.title.trim() || '未命名音频',
    description: input.description?.trim() ?? '',
    prompt: input.prompt?.trim() ?? '',
    createdAt: Date.now(),
    sampleRate,
    channels: channels.length,
    duration: channels[0].length / sampleRate,
    savedPath: null,
    source: input.source,
    originId: input.originId ?? null,
    sessionId: input.sessionId ?? null,
    recipe: input.recipe,
    peaks: computePeaks(channels, 768),
    sizeBytes: buffer.length
  }

  store.addArtifact(artifact)
  return artifact
}

/** 读取完整 PCM，供渲染层播放与波形编辑使用 */
export function readArtifactPayload(id: string): AudioPayload | null {
  const store = getStore()
  const artifact = store.getArtifact(id)
  if (!artifact) return null
  const buffer = store.readArtifactAudio(id)
  if (!buffer) return null
  const decoded = decodeWav(buffer)
  return {
    id,
    sampleRate: decoded.sampleRate,
    channels: decoded.channels,
    duration: decoded.duration,
    length: decoded.length,
    data: decoded.data,
    peaks: computePeaks(decoded.data, 2048)
  }
}

export function deleteArtifact(id: string): void {
  getStore().deleteArtifact(id)
}

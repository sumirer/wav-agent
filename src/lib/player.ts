/**
 * 全局唯一的音频播放器。
 *
 * 设计意图：应用里同时存在「聊天卡片试听」和「编辑器播放」两种场景，
 * 如果各自 new 一个 AudioContext 会出现多路同时发声的混乱，
 * 因此收敛成一个单例，并用两套订阅分离「状态变化」与「播放进度」，
 * 避免进度每帧刷新时把所有订阅者一起重渲染。
 */
import { useSyncExternalStore } from 'react'

export interface PlayerSource {
  sampleRate: number
  data: Float32Array[]
}

export interface PlayerState {
  artifactId: string | null
  status: 'idle' | 'loading' | 'playing' | 'paused'
  duration: number
  volume: number
  loop: boolean
}

interface TimeSnapshot {
  artifactId: string | null
  position: number
}

const IDLE_STATE: PlayerState = {
  artifactId: null,
  status: 'idle',
  duration: 0,
  volume: 0.9,
  loop: false
}

class AudioPlayer {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private node: AudioBufferSourceNode | null = null
  private buffer: AudioBuffer | null = null
  /** 本轮播放的起点在 AudioContext 时间轴上的位置 */
  private startedAt = 0
  /** 暂停时记录的播放位置（秒） */
  private offset = 0
  private raf = 0

  private state: PlayerState = IDLE_STATE
  private time: TimeSnapshot = { artifactId: null, position: 0 }
  private stateListeners = new Set<() => void>()
  private timeListeners = new Set<() => void>()

  /* --------------------------- 订阅接口 --------------------------- */

  subscribeState = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  subscribeTime = (listener: () => void): (() => void) => {
    this.timeListeners.add(listener)
    return () => this.timeListeners.delete(listener)
  }

  getState = (): PlayerState => this.state

  getTime = (): TimeSnapshot => this.time

  /* --------------------------- 内部工具 --------------------------- */

  private setState(patch: Partial<PlayerState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.stateListeners) listener()
  }

  private setTime(position: number, artifactId = this.state.artifactId): void {
    this.time = { artifactId, position }
    for (const listener of this.timeListeners) listener()
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.gain = this.ctx.createGain()
      this.gain.gain.value = this.state.volume
      this.gain.connect(this.ctx.destination)
    }
    return this.ctx
  }

  private tick = (): void => {
    if (this.state.status !== 'playing') {
      this.raf = 0
      return
    }
    this.setTime(this.computePosition())
    this.raf = requestAnimationFrame(this.tick)
  }

  private startTicking(): void {
    if (this.raf === 0) this.raf = requestAnimationFrame(this.tick)
  }

  private stopTicking(): void {
    if (this.raf !== 0) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
  }

  private computePosition(): number {
    if (this.state.status !== 'playing' || !this.ctx) return this.offset
    const elapsed = this.ctx.currentTime - this.startedAt
    const duration = this.state.duration
    if (duration <= 0) return 0
    return this.state.loop ? elapsed % duration : Math.min(elapsed, duration)
  }

  private teardownNode(): void {
    if (!this.node) return
    this.node.onended = null
    try {
      this.node.stop()
    } catch {
      /* 已经停止的节点再次 stop 会抛错，忽略即可 */
    }
    this.node.disconnect()
    this.node = null
  }

  /* --------------------------- 对外操作 --------------------------- */

  private toAudioBuffer(ctx: AudioContext, source: PlayerSource): AudioBuffer {
    const length = source.data[0]?.length ?? 0
    const buffer = ctx.createBuffer(Math.max(1, source.data.length), Math.max(1, length), source.sampleRate)
    source.data.forEach((channel, index) => {
      buffer.copyToChannel(channel.subarray(0, length), index)
    })
    return buffer
  }

  /** 载入一段音频并从头播放 */
  async open(artifactId: string, source: PlayerSource): Promise<void> {
    const ctx = this.ensureContext()
    if (ctx.state === 'suspended') await ctx.resume()
    this.teardownNode()
    this.buffer = this.toAudioBuffer(ctx, source)
    this.offset = 0
    this.setState({ artifactId, duration: this.buffer.duration, status: 'paused' })
    this.setTime(0, artifactId)
    this.play()
  }

  play(): void {
    if (!this.buffer || !this.ctx || !this.gain) return
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    this.teardownNode()
    const node = this.ctx.createBufferSource()
    node.buffer = this.buffer
    node.loop = this.state.loop
    node.connect(this.gain)
    const duration = this.buffer.duration
    const start = this.offset >= duration ? 0 : this.offset
    node.onended = () => {
      if (this.state.loop) return
      this.stopTicking()
      this.offset = 0
      this.setState({ status: 'paused' })
      this.setTime(0)
    }
    node.start(0, start)
    this.node = node
    this.startedAt = this.ctx.currentTime - start
    this.setState({ status: 'playing' })
    this.startTicking()
  }

  pause(): void {
    if (this.state.status !== 'playing') return
    this.offset = this.computePosition()
    this.teardownNode()
    this.stopTicking()
    this.setState({ status: 'paused' })
    this.setTime(this.offset)
  }

  toggle(): void {
    if (this.state.status === 'playing') this.pause()
    else this.play()
  }

  stop(): void {
    this.teardownNode()
    this.stopTicking()
    this.offset = 0
    this.setState({ status: this.state.artifactId ? 'paused' : 'idle' })
    this.setTime(0)
  }

  seek(seconds: number): void {
    const duration = this.state.duration
    const target = Math.min(Math.max(seconds, 0), Math.max(0, duration))
    if (this.state.status === 'playing') {
      this.offset = target
      this.play()
    } else {
      this.offset = target
      this.setTime(target)
    }
  }

  setVolume(volume: number): void {
    const value = Math.min(Math.max(volume, 0), 1)
    if (this.gain) this.gain.gain.value = value
    this.setState({ volume: value })
  }

  setLoop(loop: boolean): void {
    this.setState({ loop })
    if (this.node) this.node.loop = loop
  }

  /** 素材被删除或切换会话时清空当前曲目 */
  reset(): void {
    this.teardownNode()
    this.stopTicking()
    this.buffer = null
    this.offset = 0
    this.state = { ...IDLE_STATE, volume: this.state.volume, loop: this.state.loop }
    for (const listener of this.stateListeners) listener()
    this.setTime(0, null)
  }
}

export const player = new AudioPlayer()

export function usePlayerState(): PlayerState {
  return useSyncExternalStore(player.subscribeState, player.getState, player.getState)
}

export function usePlayerTime(): TimeSnapshot {
  return useSyncExternalStore(player.subscribeTime, player.getTime, player.getTime)
}

/** 格式化秒为 mm:ss.mmm */
export function formatDuration(seconds: number, withMs = false): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  const whole = Math.floor(rest)
  const ms = Math.round((rest - whole) * 1000)
  const base = `${String(minutes).padStart(2, '0')}:${String(whole).padStart(2, '0')}`
  return withMs ? `${base}.${String(ms).padStart(3, '0')}` : base
}

/** 音频时长的可读化显示：短音效用 ms / 秒，长音频回落到 mm:ss */
export function formatSpan(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s'
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`
  if (seconds < 60) return `${Number(seconds.toFixed(2))}s`
  return formatDuration(seconds)
}

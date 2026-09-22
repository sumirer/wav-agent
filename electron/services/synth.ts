/**
 * 结构化规格合成引擎。
 *
 * 设计意图：把模型输出限制在"参数"层面而不是"代码"层面，
 * 参数可校验、可复现、可回放，且不需要执行模型提供的代码。
 * 表达力不足时由 sandbox.ts 的代码模式兜底。
 */
import type { Curve, EnvelopeSpec, LayerEffects, LayerSpec, OscWaveform, SynthSpec } from '../../shared/types'
import { MAX_DURATION_SEC } from './wav'

export interface RenderedAudio {
  sampleRate: number
  channels: Float32Array[]
  duration: number
}

const TWO_PI = Math.PI * 2

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 折线断点线性插值 */
function sampleCurve(curve: Curve | undefined, t: number, fallback: number): number {
  if (!curve || curve.length === 0) return fallback
  if (t <= curve[0][0]) return curve[0][1]
  const last = curve[curve.length - 1]
  if (t >= last[0]) return last[1]
  for (let i = 1; i < curve.length; i += 1) {
    const [t1, v1] = curve[i]
    if (t >= t1) continue
    const [t0, v0] = curve[i - 1]
    const span = t1 - t0
    if (span <= 0) return v1
    return v0 + ((v1 - v0) * (t - t0)) / span
  }
  return last[1]
}

/** 解析后的 ADSR 参数，避免在逐采样循环里做对象分配 */
interface Envelope {
  attack: number
  decay: number
  sustain: number
  release: number
  releaseStart: number
}

function resolveEnvelope(env: EnvelopeSpec | undefined, duration: number): Envelope | null {
  if (!env) return null
  const release = Math.max(0, toNumber(env.release, 0))
  return {
    attack: Math.max(0, toNumber(env.attack, 0)),
    decay: Math.max(0, toNumber(env.decay, 0)),
    sustain: clamp(toNumber(env.sustain, 1), 0, 1),
    release,
    releaseStart: Math.max(0, duration - release)
  }
}

/** 不含 release 段的 ADSR 电平 */
function adsrLevel(t: number, env: Envelope): number {
  if (t < env.attack && env.attack > 0) return t / env.attack
  const decayEnd = env.attack + env.decay
  if (t < decayEnd && env.decay > 0) return 1 + (env.sustain - 1) * ((t - env.attack) / env.decay)
  return env.sustain
}

function envelopeAt(t: number, env: Envelope | null): number {
  if (!env) return 1
  if (env.release > 0 && t >= env.releaseStart) {
    const level = adsrLevel(env.releaseStart, env)
    return level * Math.max(0, 1 - (t - env.releaseStart) / env.release)
  }
  return adsrLevel(t, env)
}

function oscillator(waveform: OscWaveform, phase: number, pulseWidth: number): number {
  const cycle = phase / TWO_PI
  const frac = cycle - Math.floor(cycle)
  switch (waveform) {
    case 'sine':
      return Math.sin(phase)
    case 'square':
      return frac < 0.5 ? 1 : -1
    case 'triangle':
      return 4 * Math.abs(frac - 0.5) - 1
    case 'saw':
      return 2 * frac - 1
    case 'pulse':
      return frac < pulseWidth ? 1 : -1
    default:
      return 0
  }
}

interface NoiseSource {
  white(): number
  pink(): number
}

function createNoise(): NoiseSource {
  // Paul Kellet 的 pink noise 近似滤波器系数
  let b0 = 0
  let b1 = 0
  let b2 = 0
  let b3 = 0
  let b4 = 0
  let b5 = 0
  let b6 = 0
  return {
    white: () => Math.random() * 2 - 1,
    pink: () => {
      const white = Math.random() * 2 - 1
      b0 = 0.99886 * b0 + white * 0.0555179
      b1 = 0.99332 * b1 + white * 0.0750759
      b2 = 0.969 * b2 + white * 0.153852
      b3 = 0.8665 * b3 + white * 0.3104856
      b4 = 0.55 * b4 + white * 0.5329522
      b5 = -0.7616 * b5 - white * 0.016898
      const out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362
      b6 = white * 0.115926
      return clamp(out * 0.11, -1, 1)
    }
  }
}

function applyDistortion(buffer: Float32Array, drive: number): void {
  const amount = clamp(drive, 0, 1)
  if (amount <= 0) return
  const k = amount * 40
  for (let i = 0; i < buffer.length; i += 1) {
    buffer[i] = Math.tanh(buffer[i] * (1 + k)) / Math.tanh(1 + k)
  }
}

function applyBitcrush(buffer: Float32Array, bits: number): void {
  const levels = 2 ** clamp(Math.round(bits), 2, 16)
  for (let i = 0; i < buffer.length; i += 1) {
    buffer[i] = Math.round(buffer[i] * levels) / levels
  }
}

function applyOnePole(buffer: Float32Array, cutoff: number, sampleRate: number, mode: 'lowpass' | 'highpass'): void {
  if (!Number.isFinite(cutoff) || cutoff <= 0 || cutoff >= sampleRate / 2) return
  const dt = 1 / sampleRate
  const rc = 1 / (TWO_PI * cutoff)
  const alpha = dt / (rc + dt)
  let last = 0
  if (mode === 'lowpass') {
    for (let i = 0; i < buffer.length; i += 1) {
      last += alpha * (buffer[i] - last)
      buffer[i] = last
    }
  } else {
    for (let i = 0; i < buffer.length; i += 1) {
      last += alpha * (buffer[i] - last)
      buffer[i] = buffer[i] - last
    }
  }
}

function applyDelay(buffer: Float32Array, sampleRate: number, time: number, feedback: number, mix: number): void {
  const delaySamples = Math.round(clamp(time, 0, 2) * sampleRate)
  if (delaySamples <= 0) return
  const wet = clamp(mix, 0, 1)
  const fb = clamp(feedback, 0, 0.95)
  const dry = 1 - wet
  for (let i = delaySamples; i < buffer.length; i += 1) {
    const delayed = buffer[i - delaySamples] * fb
    buffer[i] = buffer[i] * dry + (buffer[i] + delayed) * wet
  }
}

/** 简易 Schroeder 混响：4 个并联梳状滤波器 + 2 个串联全通 */
function applyReverb(buffer: Float32Array, sampleRate: number, decay: number, mix: number): void {
  const wet = clamp(mix, 0, 1)
  if (wet <= 0) return
  const combDelays = [0.0297, 0.0371, 0.0411, 0.0437].map((s) => Math.round(s * sampleRate))
  const feedback = clamp(0.7 + decay * 0.28, 0, 0.98)
  const wetBuffer = new Float32Array(buffer.length)
  for (const delay of combDelays) {
    const line = new Float32Array(delay)
    let idx = 0
    for (let i = 0; i < buffer.length; i += 1) {
      const delayed = line[idx]
      line[idx] = buffer[i] + delayed * feedback
      wetBuffer[i] += delayed * 0.25
      idx = (idx + 1) % delay
    }
  }
  for (const delay of [0.005, 0.0017].map((s) => Math.round(s * sampleRate))) {
    let idx = 0
    const line = new Float32Array(delay)
    for (let i = 0; i < wetBuffer.length; i += 1) {
      const delayed = line[idx]
      const out = -wetBuffer[i] + delayed
      line[idx] = wetBuffer[i] + delayed * 0.5
      wetBuffer[i] = out
      idx = (idx + 1) % delay
    }
  }
  for (let i = 0; i < buffer.length; i += 1) {
    buffer[i] = buffer[i] * (1 - wet) + wetBuffer[i] * wet
  }
}

function applyEffects(buffer: Float32Array, effects: LayerEffects | undefined, sampleRate: number): void {
  if (!effects) return
  if (effects.distortion) applyDistortion(buffer, effects.distortion)
  if (effects.lowpass) applyOnePole(buffer, effects.lowpass, sampleRate, 'lowpass')
  if (effects.highpass) applyOnePole(buffer, effects.highpass, sampleRate, 'highpass')
  if (effects.bitcrush) applyBitcrush(buffer, effects.bitcrush)
  if (effects.delay) applyDelay(buffer, sampleRate, effects.delay.time, effects.delay.feedback, effects.delay.mix)
  if (effects.reverb) applyReverb(buffer, sampleRate, effects.reverb.decay, effects.reverb.mix)
}

function renderLayer(layer: LayerSpec, length: number, sampleRate: number, duration: number): Float32Array {
  const buffer = new Float32Array(length)
  const waveform: OscWaveform = layer.waveform ?? 'sine'
  const noise = createNoise()
  const isNoise = waveform === 'noise' || waveform === 'pink'
  const baseFrequency = toNumber(layer.frequency, 440)
  const detuneRatio = 2 ** (toNumber(layer.detune, 0) / 1200)
  const amplitude = clamp(toNumber(layer.amplitude, 1), 0, 4)
  const pulseWidth = clamp(toNumber(layer.pulseWidth, 0.5), 0.01, 0.99)
  const startTime = Math.max(0, toNumber(layer.startTime, 0))
  const endTime = Math.min(duration, toNumber(layer.endTime, duration))
  const localDuration = Math.max(0, endTime - startTime)
  const envelope = resolveEnvelope(layer.envelope, localDuration)
  const fm = layer.fm
  const fmRatio = toNumber(fm?.ratio, 1)
  const fmIndex = toNumber(fm?.index, 0)
  const fmWaveform = fm?.waveform ?? 'sine'
  const phaseStep = TWO_PI / sampleRate

  // 相位累加而非按 t 直接计算，才能正确表达 frequencyCurve 这类变频扫频
  let phase = 0
  let fmPhase = 0
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate
    if (t < startTime || t >= endTime) continue

    const localT = t - startTime
    const frequency = Math.max(0, sampleCurve(layer.frequencyCurve, t, baseFrequency) * detuneRatio)
    const amp = amplitude * envelopeAt(localT, envelope) * sampleCurve(layer.amplitudeCurve, t, 1)

    let value: number
    if (isNoise) {
      value = waveform === 'pink' ? noise.pink() : noise.white()
    } else if (fm) {
      fmPhase += phaseStep * frequency * fmRatio
      if (fmPhase > TWO_PI) fmPhase -= TWO_PI * Math.floor(fmPhase / TWO_PI)
      const mod = fmIndex * oscillator(fmWaveform, fmPhase, 0.5)
      value = oscillator(waveform, phase + mod, pulseWidth)
    } else {
      value = oscillator(waveform, phase, pulseWidth)
    }

    phase += phaseStep * frequency
    if (phase > TWO_PI) phase -= TWO_PI * Math.floor(phase / TWO_PI)

    buffer[i] = value * amp
  }

  applyEffects(buffer, layer.effects, sampleRate)
  return buffer
}

/** 把结构化规格渲染为浮点 PCM */
export function renderSpec(spec: SynthSpec, defaultSampleRate: number): RenderedAudio {
  if (!spec || !Array.isArray(spec.layers) || spec.layers.length === 0) {
    throw new Error('spec 缺少 layers，无法合成音频')
  }
  const sampleRate = clamp(Math.round(toNumber(spec.sampleRate, defaultSampleRate)), 8000, 192000)
  const duration = clamp(toNumber(spec.duration, 1), 0.01, MAX_DURATION_SEC)
  const channelCount = clamp(Math.round(toNumber(spec.channels, 1)), 1, 2)
  const length = Math.max(1, Math.round(duration * sampleRate))

  const channels: Float32Array[] = []
  for (let c = 0; c < channelCount; c += 1) channels.push(new Float32Array(length))

  for (const layer of spec.layers) {
    const mono = renderLayer(layer, length, sampleRate, duration)
    // 等功率声像，pan=0 时两声道电平一致
    const pan = clamp(toNumber(layer.pan, 0), -1, 1)
    if (channelCount === 1) {
      for (let i = 0; i < length; i += 1) channels[0][i] += mono[i]
    } else {
      const angle = ((pan + 1) * Math.PI) / 4
      const gainLeft = Math.cos(angle)
      const gainRight = Math.sin(angle)
      for (let i = 0; i < length; i += 1) {
        channels[0][i] += mono[i] * gainLeft
        channels[1][i] += mono[i] * gainRight
      }
    }
  }

  const gain = toNumber(spec.gain, 1)
  const fadeIn = Math.max(0, toNumber(spec.fadeIn, 0))
  const fadeOut = Math.max(0, toNumber(spec.fadeOut, 0))
  let peak = 0
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      const t = i / sampleRate
      let value = channel[i] * gain
      if (fadeIn > 0 && t < fadeIn) value *= t / fadeIn
      if (fadeOut > 0 && t > duration - fadeOut) value *= Math.max(0, (duration - t) / fadeOut)
      channel[i] = value
      const abs = Math.abs(value)
      if (abs > peak) peak = abs
    }
  }

  if (spec.normalize !== false && peak > 0) {
    const scale = 0.99 / peak
    if (peak > 0.99 || peak < 0.2) {
      for (const channel of channels) {
        for (let i = 0; i < channel.length; i += 1) channel[i] *= scale
      }
    }
  }

  // 最后一道软限幅，避免叠加多层后削波失真
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      const value = channel[i]
      channel[i] = value > 1 ? 1 : value < -1 ? -1 : value
    }
  }

  return { sampleRate, channels, duration: length / sampleRate }
}

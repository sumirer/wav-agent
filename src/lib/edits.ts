/**
 * 纯函数音频编辑算法库（无 React 依赖）。
 *
 * 约定：
 * - 所有函数都不修改入参，返回新的 Float32Array[]；
 * - 多声道按同一区间同步处理，返回数组的声道数与入参一致；
 * - 区间一律使用采样点下标，左闭右开 [startSample, endSample)。
 */

/** 把区间夹取到 [0, length] 并取整，非法输入退化为 0 */
function clampRange(length: number, startSample: number, endSample: number): [number, number] {
  const len = Math.max(0, Number.isFinite(length) ? Math.floor(length) : 0)
  const toInt = (value: number): number => (Number.isFinite(value) ? Math.floor(value) : 0)
  const start = Math.min(Math.max(toInt(startSample), 0), len)
  const end = Math.min(Math.max(toInt(endSample), 0), len)
  return [start, end]
}

/**
 * 删除 / 裁剪可能得到 0 长度结果，这里兜底成 1 个静音采样，
 * 避免后续 duration = length / sampleRate、峰值归一化等计算出 0 或除零。
 */
function ensureNonEmpty(channels: Float32Array[]): Float32Array[] {
  if (channels.length === 0) return channels
  if (channels.every((ch) => ch.length > 0)) return channels
  return channels.map(() => new Float32Array(1))
}

/** 保留 [startSample, endSample) 区间 */
export function trimRange(channels: Float32Array[], startSample: number, endSample: number): Float32Array[] {
  if (channels.length === 0) return []
  const [start, end] = clampRange(channels[0].length, startSample, endSample)
  const length = Math.max(0, end - start)
  return ensureNonEmpty(channels.map((ch) => ch.slice(start, start + length)))
}

/** 删除 [startSample, endSample) 区间（后续内容前移） */
export function removeRange(channels: Float32Array[], startSample: number, endSample: number): Float32Array[] {
  if (channels.length === 0) return []
  const [start, end] = clampRange(channels[0].length, startSample, endSample)
  if (end <= start) return channels.map((ch) => ch.slice())
  return ensureNonEmpty(
    channels.map((ch) => {
      const out = new Float32Array(ch.length - (end - start))
      out.set(ch.subarray(0, start), 0)
      out.set(ch.subarray(end), start)
      return out
    })
  )
}

/** 把区间内样本置零 */
export function silenceRange(channels: Float32Array[], startSample: number, endSample: number): Float32Array[] {
  if (channels.length === 0) return []
  const [start, end] = clampRange(channels[0].length, startSample, endSample)
  return channels.map((ch) => {
    const out = ch.slice()
    if (end > start) out.fill(0, start, end)
    return out
  })
}

/** 区间内线性淡入 / 淡出 */
export function fadeRange(
  channels: Float32Array[],
  startSample: number,
  endSample: number,
  type: 'in' | 'out'
): Float32Array[] {
  if (channels.length === 0) return []
  const [start, end] = clampRange(channels[0].length, startSample, endSample)
  const span = end - start
  return channels.map((ch) => {
    const out = ch.slice()
    if (span <= 0) return out
    for (let i = 0; i < span; i++) {
      const t = i / span
      out[start + i] = out[start + i] * (type === 'in' ? t : 1 - t)
    }
    return out
  })
}

/** 区间内增益，gainDb 为分贝（可正可负） */
export function gainRange(
  channels: Float32Array[],
  startSample: number,
  endSample: number,
  gainDb: number
): Float32Array[] {
  if (channels.length === 0) return []
  const [start, end] = clampRange(channels[0].length, startSample, endSample)
  const factor = Math.pow(10, gainDb / 20)
  return channels.map((ch) => {
    const out = ch.slice()
    if (!Number.isFinite(factor) || factor === 1) return out
    for (let i = start; i < end; i++) out[i] = out[i] * factor
    return out
  })
}

/** 整体归一化到 targetPeak（默认 0.99） */
export function normalize(channels: Float32Array[], targetPeak = 0.99): Float32Array[] {
  if (channels.length === 0) return []
  const target = Number.isFinite(targetPeak) && targetPeak > 0 ? targetPeak : 0.99
  const peak = peakOf(channels)
  if (peak <= 0) return channels.map((ch) => ch.slice())
  const factor = target / peak
  return channels.map((ch) => {
    const out = ch.slice()
    for (let i = 0; i < out.length; i++) out[i] = out[i] * factor
    return out
  })
}

/** 整体反转 */
export function reverseAll(channels: Float32Array[]): Float32Array[] {
  return channels.map((ch) => {
    const out = new Float32Array(ch.length)
    for (let i = 0; i < ch.length; i++) out[i] = ch[ch.length - 1 - i]
    return out
  })
}

/** 计算整体峰值（0~1） */
export function peakOf(channels: Float32Array[]): number {
  let peak = 0
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i])
      if (v > peak) peak = v
    }
  }
  return peak
}

/** 峰值的分贝表示：20*log10(peak)，peak 为 0 时返回 -Infinity */
export function peakToDb(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return -Infinity
  return 20 * Math.log10(peak)
}

/**
 * WAV 编解码与波形包络计算。
 * 应用内部统一使用 [-1, 1] 的 Float32 多声道 PCM 作为中间表示，
 * 仅在写入磁盘时编码为 16bit PCM WAV。
 */

export interface DecodedWav {
  sampleRate: number
  channels: number
  length: number
  duration: number
  data: Float32Array[]
}

const MAX_DURATION_SEC = 120

function readAscii(view: DataView, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i))
  return out
}

/** 把多声道浮点 PCM 编码为 16bit PCM WAV */
export function encodeWav(channels: Float32Array[], sampleRate: number): Buffer {
  const channelCount = channels.length
  if (channelCount === 0) throw new Error('至少需要一个声道')
  const frames = channels[0].length
  const bytesPerSample = 2
  const blockAlign = channelCount * bytesPerSample
  const dataSize = frames * blockAlign
  const buffer = Buffer.alloc(44 + dataSize)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  view.setUint32(0, 0x46464952, true) // 'RIFF'
  view.setUint32(4, 36 + dataSize, true)
  view.setUint32(8, 0x45564157, true) // 'WAVE'
  view.setUint32(12, 0x20746d66, true) // 'fmt '
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 8 * bytesPerSample, true)
  view.setUint32(36, 0x61746164, true) // 'data'
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channelCount; c += 1) {
      const sample = Math.max(-1, Math.min(1, channels[c][i]))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return buffer
}

/** 解码 WAV，支持 8/16/24/32bit 整型与 32/64bit 浮点 */
export function decodeWav(buffer: Buffer): DecodedWav {
  if (buffer.length < 44) throw new Error('不是有效的 WAV 文件')
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('不是有效的 WAV 文件')
  }

  let format = 0
  let channelCount = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataOffset = -1
  let dataSize = 0

  let cursor = 12
  while (cursor + 8 <= view.byteLength) {
    const chunkId = readAscii(view, cursor, 4)
    const chunkSize = view.getUint32(cursor + 4, true)
    const body = cursor + 8
    if (chunkId === 'fmt ' && body + 16 <= view.byteLength) {
      format = view.getUint16(body, true)
      channelCount = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
      // WAVE_FORMAT_EXTENSIBLE：真实格式藏在 SubFormat 的前两字节
      if (format === 0xfffe && chunkSize >= 40) format = view.getUint16(body + 24, true)
    } else if (chunkId === 'data') {
      dataOffset = body
      dataSize = Math.min(chunkSize, view.byteLength - body)
    }
    cursor = body + chunkSize + (chunkSize % 2)
  }

  if (dataOffset < 0 || channelCount <= 0 || sampleRate <= 0) throw new Error('WAV 文件缺少必要的块')
  const bytesPerSample = bitsPerSample / 8
  const frames = Math.floor(dataSize / (bytesPerSample * channelCount))
  if (frames <= 0) throw new Error('WAV 文件没有音频数据')

  const data: Float32Array[] = []
  for (let c = 0; c < channelCount; c += 1) data.push(new Float32Array(frames))

  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channelCount; c += 1) {
      const pos = dataOffset + (i * channelCount + c) * bytesPerSample
      let value = 0
      if (format === 3) {
        value = bitsPerSample === 64 ? view.getFloat64(pos, true) : view.getFloat32(pos, true)
      } else if (bitsPerSample === 8) {
        value = (view.getUint8(pos) - 128) / 128
      } else if (bitsPerSample === 16) {
        value = view.getInt16(pos, true) / 32768
      } else if (bitsPerSample === 24) {
        const b0 = view.getUint8(pos)
        const b1 = view.getUint8(pos + 1)
        const b2 = view.getUint8(pos + 2)
        let int24 = (b2 << 16) | (b1 << 8) | b0
        if (int24 & 0x800000) int24 -= 0x1000000
        value = int24 / 8388608
      } else if (bitsPerSample === 32) {
        value = view.getInt32(pos, true) / 2147483648
      } else {
        throw new Error(`不支持的位深: ${bitsPerSample}`)
      }
      data[c][i] = Math.max(-1, Math.min(1, value))
    }
  }

  return { sampleRate, channels: channelCount, length: frames, duration: frames / sampleRate, data }
}

/**
 * 计算用于绘制的包络峰值（每桶取绝对值最大）。
 * 生成素材与编辑画面共用同一套数据，保证缩略图与主视图观感一致。
 */
export function computePeaks(channels: Float32Array[], buckets = 1024): number[][] {
  return channels.map((channel) => {
    const count = Math.max(16, Math.min(buckets, channel.length || 1))
    const blockSize = Math.max(1, Math.ceil(channel.length / count))
    const peaks = new Array<number>(count).fill(0)
    for (let b = 0; b < count; b += 1) {
      const start = b * blockSize
      const end = Math.min(channel.length, start + blockSize)
      let max = 0
      for (let i = start; i < end; i += 1) {
        const abs = Math.abs(channel[i])
        if (abs > max) max = abs
      }
      peaks[b] = max
    }
    return peaks
  })
}

export { MAX_DURATION_SEC }

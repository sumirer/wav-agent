/**
 * Canvas 波形绘制工具（无 React 依赖）。
 *
 * 高清渲染约定（两个绘制函数保持一致）：
 * width / height 传入的是 **CSS 逻辑像素**，调用方需要把 canvas.width / canvas.height
 * 设为「逻辑像素 * devicePixelRatio」；本文件内部按 ctx.canvas.width / width 推断缩放比例
 * 并自动 ctx.setTransform，因此函数内所有绘制坐标都是逻辑像素。
 */

const WAVE_COLOR = '#4f9cf9'
const CENTER_COLOR = 'rgba(147, 161, 184, 0.35)'
const SELECTION_FILL = 'rgba(79, 156, 249, 0.18)'
const SELECTION_EDGE = 'rgba(79, 156, 249, 0.75)'
const PLAYHEAD_COLOR = '#f87171'

/** 按 canvas 物理尺寸与逻辑尺寸的比值设置缩放，保证逻辑像素绘制 */
function applyDeviceScale(ctx: CanvasRenderingContext2D, width: number): void {
  const scale = width > 0 && ctx.canvas.width > 0 ? ctx.canvas.width / width : 1
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
}

/** 半透明高亮 + 左右边界线，x0 / x1 为已换算的像素坐标 */
function drawSelection(
  ctx: CanvasRenderingContext2D,
  height: number,
  x0: number,
  x1: number,
  color: string
): void {
  ctx.fillStyle = color
  ctx.fillRect(x0, 0, x1 - x0, height)
  ctx.strokeStyle = SELECTION_EDGE
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x0 + 0.5, 0)
  ctx.lineTo(x0 + 0.5, height)
  ctx.moveTo(x1 - 0.5, 0)
  ctx.lineTo(x1 - 0.5, height)
  ctx.stroke()
}

/** 用 artifact.peaks 这类降采样包络绘制缩略波形 */
export function drawPeaks(
  ctx: CanvasRenderingContext2D,
  peaks: number[][],
  width: number,
  height: number,
  options?: {
    color?: string
    background?: string
    /** 归一化比例选区（0~1，相对整段时长），缩略图没有采样点信息所以用比例 */
    selection?: { start: number; end: number } | null
    selectionColor?: string
  }
): void {
  const opts = options ?? {}
  applyDeviceScale(ctx, width)
  ctx.clearRect(0, 0, width, height)
  if (opts.background) {
    ctx.fillStyle = opts.background
    ctx.fillRect(0, 0, width, height)
  }
  if (peaks.length === 0 || width <= 0 || height <= 0) return

  const bandHeight = height / peaks.length
  ctx.fillStyle = opts.color ?? WAVE_COLOR
  peaks.forEach((buckets, channelIndex) => {
    const center = channelIndex * bandHeight + bandHeight / 2
    const half = (bandHeight / 2) * 0.92
    const count = buckets.length
    if (count === 0) return
    for (let i = 0; i < count; i++) {
      const x = Math.floor((i / count) * width)
      const nextX = Math.max(x + 1, Math.floor(((i + 1) / count) * width))
      const value = Math.min(1, Math.abs(buckets[i]))
      const h = Math.max(1, value * half)
      ctx.fillRect(x, center - h, nextX - x, h * 2)
    }
  })

  const selection = opts.selection
  if (selection) {
    const from = Math.min(Math.max(selection.start, 0), 1) * width
    const to = Math.min(Math.max(selection.end, 0), 1) * width
    if (to > from) {
      drawSelection(ctx, height, from, to, opts.selectionColor ?? SELECTION_FILL)
    }
  }
}

/** 用原始 PCM 绘制可缩放的详细波形，view.start / view.end 为采样点下标 */
export function drawSamples(
  ctx: CanvasRenderingContext2D,
  channels: Float32Array[],
  width: number,
  height: number,
  view: { start: number; end: number },
  options?: {
    color?: string
    centerLine?: string
    selection?: { start: number; end: number } | null
    selectionColor?: string
    playhead?: number | null
    playheadColor?: string
    totalLength?: number
  }
): void {
  const opts = options ?? {}
  applyDeviceScale(ctx, width)
  ctx.clearRect(0, 0, width, height)
  if (channels.length === 0 || width <= 0 || height <= 0) return

  const totalLength = Math.max(0, opts.totalLength ?? channels[0].length)
  const viewStart = Math.min(Math.max(view.start, 0), totalLength)
  const viewEnd = Math.min(Math.max(view.end, viewStart + 1), Math.max(totalLength, viewStart + 1))
  const span = viewEnd - viewStart
  const waveColor = opts.color ?? WAVE_COLOR
  const bandHeight = height / channels.length

  const sampleToX = (sample: number): number => ((sample - viewStart) / span) * width

  channels.forEach((data, channelIndex) => {
    const center = channelIndex * bandHeight + bandHeight / 2
    const half = (bandHeight / 2) * 0.92

    // 声道中线
    ctx.strokeStyle = opts.centerLine ?? CENTER_COLOR
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, center + 0.5)
    ctx.lineTo(width, center + 0.5)
    ctx.stroke()

    if (span <= width) {
      // 采样点比像素列更密（已放大到单采样级别）：折线连接，视觉平滑
      ctx.strokeStyle = waveColor
      ctx.lineWidth = 1.4
      ctx.beginPath()
      const count = Math.max(1, Math.floor(span))
      for (let i = 0; i < count; i++) {
        const index = Math.floor(viewStart) + i
        const value = index < data.length ? data[index] : 0
        const x = sampleToX(index + 0.5)
        const y = center - value * half
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    } else {
      // 一个像素列可能覆盖多个采样点：取 min/max 画竖线
      ctx.fillStyle = waveColor
      const perColumn = span / width
      for (let x = 0; x < width; x++) {
        const columnStart = viewStart + x * perColumn
        const columnEnd = viewStart + (x + 1) * perColumn
        let first = Math.floor(columnStart)
        const last = Math.max(first + 1, Math.ceil(columnEnd))
        if (first < 0) first = 0
        let min = Infinity
        let max = -Infinity
        for (let i = first; i < last; i++) {
          const value = i < data.length ? data[i] : 0
          if (value < min) min = value
          if (value > max) max = value
        }
        if (min === Infinity) {
          min = 0
          max = 0
        }
        const top = center - max * half
        const bottom = center - min * half
        ctx.fillRect(x, top, 1, Math.max(1, bottom - top))
      }
    }
  })

  const selection = opts.selection
  if (selection) {
    const x0 = Math.min(Math.max(sampleToX(selection.start), 0), width)
    const x1 = Math.min(Math.max(sampleToX(selection.end), 0), width)
    if (x1 > x0) {
      drawSelection(ctx, height, x0, x1, opts.selectionColor ?? SELECTION_FILL)
    }
  }

  const playhead = opts.playhead
  if (typeof playhead === 'number' && Number.isFinite(playhead)) {
    const x = sampleToX(playhead)
    if (x >= 0 && x <= width) {
      ctx.strokeStyle = opts.playheadColor ?? PLAYHEAD_COLOR
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()
    }
  }
}

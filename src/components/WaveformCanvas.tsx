import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { drawPeaks, drawSamples } from '../lib/waveform'

export interface WaveformCanvasProps {
  channels: Float32Array[]
  sampleRate: number
  peaks?: number[][]
  /** 只读缩略模式：不支持选区与缩放，用于列表/聊天卡片 */
  compact?: boolean
  height?: number
  selection: { start: number; end: number } | null
  onSelectionChange(next: { start: number; end: number } | null): void
  playheadSample?: number | null
  onSeek?(sample: number): void
  /** 由父组件传入的缩放级别（1 表示铺满宽度） */
  zoom?: number
  onZoomChange?(zoom: number): void
  className?: string
}

const DEFAULT_HEIGHT = 96
const MIN_ZOOM = 1
const MAX_ZOOM = 128

type DragState = {
  mode: 'select' | 'pan'
  anchorSample: number
  startX: number
  startViewStart: number
  moved: boolean
}

export default function WaveformCanvas({
  channels,
  sampleRate,
  peaks,
  compact = false,
  height = DEFAULT_HEIGHT,
  selection,
  onSelectionChange,
  playheadSample = null,
  onSeek,
  zoom,
  onZoomChange,
  className
}: WaveformCanvasProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [width, setWidth] = useState(0)
  const [innerZoom, setInnerZoom] = useState(1)
  const [viewStart, setViewStart] = useState(0)
  const [isPanning, setIsPanning] = useState(false)

  const effectiveZoom = Math.min(Math.max(zoom ?? innerZoom, MIN_ZOOM), MAX_ZOOM)
  const totalLength = channels[0]?.length ?? 0
  const visibleSamples = effectiveZoom > 1 ? totalLength / effectiveZoom : totalLength
  const maxViewStart = Math.max(0, totalLength - visibleSamples)
  const clampedViewStart = Math.min(Math.max(0, viewStart), maxViewStart)
  const selectionStart = selection ? selection.start : null
  const selectionEnd = selection ? selection.end : null

  // 原生 wheel 监听里需要读取最新的视图状态，这里始终保存一份
  const viewStateRef = useRef({ viewStart: 0, visible: 0, maxViewStart: 0, zoom: 1, total: 0 })
  viewStateRef.current = {
    viewStart: clampedViewStart,
    visible: visibleSamples,
    maxViewStart,
    zoom: effectiveZoom,
    total: totalLength
  }

  const clampViewStart = (value: number): number =>
    Math.min(Math.max(0, value), viewStateRef.current.maxViewStart)

  // 容器宽度自适应
  useEffect(() => {
    const element = wrapRef.current
    if (!element) return
    setWidth(Math.round(element.getBoundingClientRect().width))
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // 视图越界（缩放 / 数据变短后）自动回拉
  useEffect(() => {
    if (viewStart > maxViewStart) setViewStart(maxViewStart)
  }, [viewStart, maxViewStart])

  // 数据被清空时回到起点
  useEffect(() => {
    if (totalLength === 0) setViewStart(0)
  }, [totalLength])

  // 重绘：依赖全部为原始值，避免对象字面量导致每次渲染都重绘
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= 0 || height <= 0) return
    const dpr = window.devicePixelRatio || 1
    const pixelWidth = Math.max(1, Math.round(width * dpr))
    const pixelHeight = Math.max(1, Math.round(height * dpr))
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight
    canvas.style.height = `${height}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    if (compact) {
      if (peaks && peaks.length > 0) {
        drawPeaks(ctx, peaks, width, height, { color: '#4f9cf9' })
      } else {
        drawSamples(ctx, channels, width, height, { start: 0, end: Math.max(1, totalLength) })
      }
      return
    }

    const activeSelection =
      selectionStart === null || selectionEnd === null ? null : { start: selectionStart, end: selectionEnd }
    drawSamples(
      ctx,
      channels,
      width,
      height,
      { start: clampedViewStart, end: clampedViewStart + Math.max(1, visibleSamples) },
      {
        totalLength,
        selection: activeSelection,
        playhead: playheadSample
      }
    )
  }, [
    compact,
    peaks,
    channels,
    width,
    height,
    clampedViewStart,
    visibleSamples,
    totalLength,
    selectionStart,
    selectionEnd,
    playheadSample
  ])

  // 缩放 / 水平滚动：必须用非 passive 监听才能阻止页面滚动
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || compact) return
    const onWheel = (event: WheelEvent): void => {
      const state = viewStateRef.current
      const rect = canvas.getBoundingClientRect()
      const ratio = rect.width > 0 ? Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1) : 0.5
      if (event.ctrlKey || event.altKey || event.metaKey) {
        event.preventDefault()
        const anchorSample = state.viewStart + ratio * state.visible
        const nextZoom = Math.min(
          Math.max(state.zoom * (event.deltaY < 0 ? 1.25 : 1 / 1.25), MIN_ZOOM),
          MAX_ZOOM
        )
        const nextVisible = state.total / nextZoom
        onZoomChange?.(nextZoom)
        setInnerZoom(nextZoom)
        setViewStart(Math.min(Math.max(0, anchorSample - ratio * nextVisible), Math.max(0, state.total - nextVisible)))
      } else {
        event.preventDefault()
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
        const samplesPerPx = rect.width > 0 ? state.visible / rect.width : 0
        setViewStart(clampViewStart(state.viewStart + delta * samplesPerPx))
      }
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
    // 处理函数只读取 ref 与 setState，zoom / 视图变化无需重新挂载监听
  }, [compact, onZoomChange])

  const sampleFromClientX = (clientX: number): number => {
    const canvas = canvasRef.current
    if (!canvas) return 0
    const rect = canvas.getBoundingClientRect()
    const ratio = rect.width > 0 ? Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) : 0
    if (compact) return Math.round(ratio * totalLength)
    return clampedViewStart + ratio * visibleSamples
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (compact) {
      onSeek?.(sampleFromClientX(event.clientX))
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    const mode: DragState['mode'] = event.shiftKey ? 'pan' : 'select'
    dragRef.current = {
      mode,
      anchorSample: sampleFromClientX(event.clientX),
      startX: event.clientX,
      startViewStart: clampedViewStart,
      moved: false
    }
    if (mode === 'pan') setIsPanning(true)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.mode === 'pan') {
      const rect = event.currentTarget.getBoundingClientRect()
      const samplesPerPx = rect.width > 0 ? visibleSamples / rect.width : 0
      setViewStart(clampViewStart(drag.startViewStart - (event.clientX - drag.startX) * samplesPerPx))
      return
    }
    if (Math.abs(event.clientX - drag.startX) > 2) drag.moved = true
    if (!drag.moved) return
    const current = sampleFromClientX(event.clientX)
    const start = Math.floor(Math.min(drag.anchorSample, current))
    const end = Math.ceil(Math.max(drag.anchorSample, current))
    onSelectionChange({ start, end })
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    dragRef.current = null
    setIsPanning(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!drag || drag.mode !== 'select') return
    if (!drag.moved) {
      // 单击：设置播放头并清空选区
      onSelectionChange(null)
      onSeek?.(sampleFromClientX(event.clientX))
    }
  }

  const handleDoubleClick = (event: ReactMouseEvent<HTMLCanvasElement>): void => {
    if (compact) {
      onSeek?.(sampleFromClientX(event.clientX))
      return
    }
    event.preventDefault()
    onSelectionChange(null)
  }

  const cursor = compact ? 'pointer' : isPanning ? 'grabbing' : 'crosshair'

  return (
    <div ref={wrapRef} className={className ? `ae-wave ${className}` : 'ae-wave'}>
      <canvas
        ref={canvasRef}
        className="ae-wave-canvas"
        style={{ width: '100%', height: `${height}px`, cursor }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
      />
      {!compact && (
        <div className="ae-wave-hint">
          <span>拖动选择区间</span>
          <span>Shift + 拖动移动视图</span>
          <span>Ctrl / Alt + 滚轮缩放</span>
          <span>{sampleRate > 0 ? `采样点 ${totalLength}` : ''}</span>
        </div>
      )}
    </div>
  )
}

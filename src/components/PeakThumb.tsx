import { useEffect, useRef } from 'react'
import { drawPeaks } from '@/lib/waveform'

interface PeakThumbProps {
  peaks: number[][]
  height?: number
  color?: string
  className?: string
  /** 0~1 的播放进度，用于绘制已播放区域 */
  progress?: number
}

/** 用降采样包络绘制的轻量波形缩略图，供列表与聊天卡片复用 */
export default function PeakThumb({ peaks, height = 30, color, className, progress }: PeakThumbProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    const render = (): void => {
      const width = wrap.clientWidth
      if (width <= 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      drawPeaks(ctx, peaks, width, height, { color, background: 'transparent' })
      if (progress !== undefined && progress > 0) {
        ctx.save()
        ctx.globalCompositeOperation = 'source-atop'
        ctx.fillStyle = 'rgba(79, 156, 249, 0.35)'
        ctx.fillRect(0, 0, width * Math.min(1, progress), height)
        ctx.restore()
      }
    }

    render()
    const observer = new ResizeObserver(render)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [peaks, height, color, progress])

  return (
    <div ref={wrapRef} className={className} style={{ width: '100%', height: `${height}px` }}>
      <canvas ref={canvasRef} style={{ display: 'block' }} />
    </div>
  )
}

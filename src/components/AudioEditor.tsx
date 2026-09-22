import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AudioArtifact, AudioPayload } from '@shared/types'
import SynthInspector from './SynthInspector'
import WaveformCanvas from './WaveformCanvas'
import {
  fadeRange,
  gainRange,
  normalize,
  peakOf,
  peakToDb,
  removeRange,
  reverseAll,
  silenceRange,
  trimRange
} from '../lib/edits'
import '../styles/editor.css'

export interface AudioEditorProps {
  artifact: AudioArtifact
  payload: AudioPayload
  onClose(): void
  /** 未编辑时直接保存原文件到本地 */
  onSaveToDisk(): void
  /** 另存为编辑后的新素材 */
  onExport(input: { channels: Float32Array[]; sampleRate: number; title: string }): void
  /** 编辑内容是否与磁盘上的原件不同（父组件用于显示未保存提示） */
  onDirtyChange?(dirty: boolean): void
}

/** 撤销栈上限，契约要求至少 30 步 */
const MAX_UNDO = 60

function pad(value: number, size: number): string {
  return String(value).padStart(size, '0')
}

/** 时长格式 mm:ss.mmm */
function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const totalMs = Math.round(safe * 1000)
  return `${pad(Math.floor(totalMs / 60000), 2)}:${pad(Math.floor((totalMs % 60000) / 1000), 2)}.${pad(
    totalMs % 1000,
    3
  )}`
}

function formatDb(db: number): string {
  return Number.isFinite(db) ? `${db.toFixed(1)} dB` : '-∞ dB'
}

/** 保证至少有 1 个声道、每个声道至少有 1 个采样点，避免出现 0 长度数据 */
function ensureChannels(input: Float32Array[]): Float32Array[] {
  if (input.length === 0) return [new Float32Array(1)]
  if (input.every((channel) => channel.length > 0)) return input
  return input.map((channel) => (channel.length > 0 ? channel : new Float32Array(1)))
}

function channelsEqual(a: Float32Array[], b: Float32Array[]): boolean {
  if (a.length !== b.length) return false
  for (let channel = 0; channel < a.length; channel++) {
    const left = a[channel]
    const right = b[channel]
    if (left === right) continue
    if (left.length !== right.length) return false
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return false
    }
  }
  return true
}

export default function AudioEditor({
  artifact,
  payload,
  onClose,
  onSaveToDisk,
  onExport,
  onDirtyChange
}: AudioEditorProps): JSX.Element {
  const sampleRate = payload.sampleRate
  const [channels, setChannels] = useState<Float32Array[]>(() => ensureChannels(payload.data))
  const [title, setTitle] = useState(artifact.title)
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null)
  const [playheadSample, setPlayheadSample] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [loop, setLoop] = useState(false)
  const [volume, setVolume] = useState(0.9)
  const [zoom, setZoom] = useState(1)
  const [gainDb, setGainDb] = useState(0)
  const [undoDepth, setUndoDepth] = useState(0)
  const [dirty, setDirty] = useState(false)

  // 编辑态数据以 ref 为准，便于在事件回调 / 播放循环里读取最新值
  const dataRef = useRef<Float32Array[]>(channels)
  const originalRef = useRef<Float32Array[]>(channels)
  const undoRef = useRef<Float32Array[][]>([])
  const headRef = useRef(0)
  const sampleRateRef = useRef(sampleRate)
  const ctxRef = useRef<AudioContext | null>(null)
  const gainRef = useRef<GainNode | null>(null)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const startedAtRef = useRef(0)
  const anchorRef = useRef(0)
  const playingRef = useRef(false)
  const loopRef = useRef(false)
  const volumeRef = useRef(0.9)

  /** 自然播放结束（非循环）时回到起点 */
  const handleNaturalEnd = useCallback((): void => {
    sourceRef.current = null
    playingRef.current = false
    anchorRef.current = 0
    headRef.current = 0
    setIsPlaying(false)
    setPlayheadSample(0)
  }, [])

  const teardownSource = useCallback((): void => {
    const source = sourceRef.current
    if (source) {
      source.onended = null
      source.stop()
      source.disconnect()
      sourceRef.current = null
    }
    playingRef.current = false
  }, [])

  /** 首次播放时才创建 AudioContext（浏览器要求用户手势后才能出声） */
  const ensureContext = useCallback((): AudioContext | null => {
    let ctx = ctxRef.current
    if (!ctx) {
      const globalScope = window as unknown as {
        AudioContext?: typeof AudioContext
        webkitAudioContext?: typeof AudioContext
      }
      const AudioContextCtor = globalScope.AudioContext ?? globalScope.webkitAudioContext
      if (!AudioContextCtor) return null
      ctx = new AudioContextCtor()
      const gain = ctx.createGain()
      gain.gain.value = volumeRef.current
      gain.connect(ctx.destination)
      ctxRef.current = ctx
      gainRef.current = gain
    }
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  }, [])

  /** 播放头位置（采样点）；未播放时返回静态播放头 */
  const currentSample = useCallback((): number => {
    if (!playingRef.current) return headRef.current
    const ctx = ctxRef.current
    const total = dataRef.current[0]?.length ?? 0
    if (!ctx || total === 0) return headRef.current
    const elapsed = (ctx.currentTime - startedAtRef.current) * sampleRateRef.current
    const position = loopRef.current ? (anchorRef.current + elapsed) % total : anchorRef.current + elapsed
    return Math.max(0, Math.min(position, total))
  }, [])

  const startPlayback = useCallback(
    (nextChannels: Float32Array[], fromSample: number): void => {
      const ctx = ensureContext()
      const gain = gainRef.current
      const total = nextChannels[0]?.length ?? 0
      if (!ctx || !gain || total === 0) return
      teardownSource()
      const buffer = ctx.createBuffer(nextChannels.length, total, sampleRateRef.current)
      nextChannels.forEach((channel, index) => buffer.getChannelData(index).set(channel.subarray(0, total)))
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.loop = loopRef.current
      source.connect(gain)
      gain.gain.value = volumeRef.current
      source.onended = handleNaturalEnd
      // offset 以秒为单位，略微内收避免正好落在缓冲区末尾
      source.start(0, Math.max(0, Math.min(fromSample / sampleRateRef.current, total / sampleRateRef.current - 1e-4)))
      sourceRef.current = source
      startedAtRef.current = ctx.currentTime
      anchorRef.current = fromSample
      headRef.current = fromSample
      playingRef.current = true
      setIsPlaying(true)
    },
    [ensureContext, handleNaturalEnd, teardownSource]
  )

  // 切换素材：重置编辑态；卸载或换素材时关闭 AudioContext，避免内存泄漏
  useEffect(() => {
    const base = ensureChannels(payload.data)
    sampleRateRef.current = payload.sampleRate
    originalRef.current = base
    dataRef.current = base
    undoRef.current = []
    anchorRef.current = 0
    headRef.current = 0
    setChannels(base)
    setTitle(artifact.title)
    setSelection(null)
    setUndoDepth(0)
    setDirty(false)
    setIsPlaying(false)
    setZoom(1)
    setGainDb(0)
    setPlayheadSample(0)
    return () => {
      teardownSource()
      const ctx = ctxRef.current
      ctxRef.current = null
      gainRef.current = null
      if (ctx) void ctx.close()
    }
    // 仅随素材 id 重建，忽略父组件偶然传入的新 payload 引用
  }, [artifact.id])

  // 音量 / 循环开关同步到正在播放的节点
  useEffect(() => {
    volumeRef.current = volume
    const gain = gainRef.current
    if (gain) gain.gain.value = volume
  }, [volume])

  useEffect(() => {
    loopRef.current = loop
    const source = sourceRef.current
    if (source) source.loop = loop
  }, [loop])

  // 播放期间用 rAF 刷新播放头，反映真实播放进度
  useEffect(() => {
    if (!isPlaying) return
    let raf = 0
    const tick = (): void => {
      const position = currentSample()
      headRef.current = position
      setPlayheadSample(position)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, currentSample])

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const commitData = (next: Float32Array[], clearSelection: boolean): void => {
    dataRef.current = next
    setChannels(next)
    if (clearSelection) setSelection(null)
    const total = next[0]?.length ?? 0
    const rawPosition = playingRef.current ? currentSample() : headRef.current
    const position = Math.max(0, Math.min(Math.round(rawPosition), Math.max(0, total - 1)))
    anchorRef.current = position
    headRef.current = position
    setPlayheadSample(position)
    // 正在播放时用新数据重建 buffer，并从原位置继续
    if (playingRef.current) startPlayback(next, position)
    setDirty(!channelsEqual(next, originalRef.current))
  }

  const applyEdit = (mutate: (input: Float32Array[]) => Float32Array[], clearSelection = false): void => {
    const previous = dataRef.current
    const next = mutate(previous)
    undoRef.current.push(previous)
    if (undoRef.current.length > MAX_UNDO) undoRef.current.shift()
    setUndoDepth(undoRef.current.length)
    commitData(next, clearSelection)
  }

  const handleUndo = (): void => {
    const previous = undoRef.current.pop()
    if (!previous) return
    setUndoDepth(undoRef.current.length)
    commitData(previous, false)
  }

  const handleReset = (): void => {
    if (dataRef.current === originalRef.current) return
    applyEdit(() => originalRef.current, true)
  }

  const handlePlayPause = (): void => {
    if (isPlaying) {
      const position = Math.round(currentSample())
      teardownSource()
      anchorRef.current = position
      headRef.current = position
      setPlayheadSample(position)
      setIsPlaying(false)
      return
    }
    const total = dataRef.current[0]?.length ?? 0
    const from = headRef.current >= total - 1 ? 0 : Math.max(0, Math.floor(headRef.current))
    startPlayback(dataRef.current, from)
    setPlayheadSample(from)
  }

  const handleStop = (): void => {
    teardownSource()
    anchorRef.current = 0
    headRef.current = 0
    setPlayheadSample(0)
    setIsPlaying(false)
  }

  const handleSeek = (sample: number): void => {
    const total = dataRef.current[0]?.length ?? 0
    const position = Math.max(0, Math.min(Math.round(sample), Math.max(0, total - 1)))
    anchorRef.current = position
    headRef.current = position
    setPlayheadSample(position)
    if (playingRef.current) startPlayback(dataRef.current, position)
  }

  const totalLength = channels[0]?.length ?? 0
  const duration = sampleRate > 0 ? totalLength / sampleRate : 0
  const playheadSeconds = sampleRate > 0 ? playheadSample / sampleRate : 0
  // 峰值计算是 O(n)，只在数据真正变化时重算
  const peakDb = useMemo(() => peakToDb(peakOf(channels)), [channels])

  const range = ((): { start: number; end: number } | null => {
    if (!selection) return null
    const start = Math.max(0, Math.min(selection.start, totalLength))
    const end = Math.max(0, Math.min(selection.end, totalLength))
    return end > start ? { start, end } : null
  })()
  const hasSelection = range !== null
  const selectionMs = range && sampleRate > 0 ? ((range.end - range.start) / sampleRate) * 1000 : 0

  const handleApplyGain = (): void => {
    applyEdit((input) =>
      range
        ? gainRange(input, range.start, range.end, gainDb)
        : gainRange(input, 0, input[0].length, gainDb)
    )
  }

  const handleExport = (): void => {
    onExport({ channels: dataRef.current, sampleRate, title: title.trim() || artifact.title })
  }

  return (
    <div className="ae-root">
      <header className="ae-header">
        <div className="ae-header-main">
          <input
            className="ae-title"
            value={title}
            placeholder="素材标题"
            onChange={(event) => setTitle(event.target.value)}
          />
          <span className="ae-desc">{artifact.description || '暂无描述'}</span>
        </div>
        <div className="ae-header-actions">
          {dirty && <span className="ae-badge ae-badge-dirty">已修改</span>}
          <button type="button" className="ae-btn ae-btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </header>

      <div className="ae-body">
        <div className="ae-meta">
        <span className="ae-chip">时长 {formatTime(duration)}</span>
        <span className="ae-chip">采样率 {sampleRate} Hz</span>
        <span className="ae-chip">声道 {channels.length}</span>
        <span className="ae-chip">峰值 {formatDb(peakDb)}</span>
        <span
          className={artifact.savedPath ? 'ae-chip ae-chip-ok ae-chip-path' : 'ae-chip ae-chip-warn'}
          title={artifact.savedPath ?? '尚未保存到本地'}
        >
          {artifact.savedPath ? `已保存到本地：${artifact.savedPath}` : '尚未保存到本地'}
        </span>
      </div>

      <div className="ae-canvas-wrap">
        <WaveformCanvas
          channels={channels}
          sampleRate={sampleRate}
          peaks={payload.peaks}
          height={190}
          selection={selection}
          onSelectionChange={setSelection}
          playheadSample={playheadSample}
          onSeek={handleSeek}
          zoom={zoom}
          onZoomChange={setZoom}
          className="ae-canvas"
        />
      </div>

      <div className="ae-transport">
        <button type="button" className="ae-btn ae-btn-primary" onClick={handlePlayPause}>
          {isPlaying ? '暂停' : '播放'}
        </button>
        <button type="button" className="ae-btn" onClick={handleStop} disabled={!isPlaying && playheadSample === 0}>
          停止
        </button>
        <button
          type="button"
          className={loop ? 'ae-btn ae-btn-active' : 'ae-btn'}
          onClick={() => setLoop((value) => !value)}
        >
          {loop ? '循环：开' : '循环：关'}
        </button>
        <span className="ae-time">
          {formatTime(playheadSeconds)} / {formatTime(duration)}
        </span>
        <label className="ae-field">
          <span className="ae-field-label">音量</span>
          <input
            type="range"
            className="ae-slider"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(event) => setVolume(Number(event.target.value))}
          />
          <span className="ae-field-value">{Math.round(volume * 100)}%</span>
        </label>
        <div className="ae-field">
          <span className="ae-field-label">缩放</span>
          <span className="ae-field-value">{zoom.toFixed(2)}x</span>
          <button
            type="button"
            className="ae-btn ae-btn-ghost"
            onClick={() => setZoom(1)}
            disabled={zoom <= 1}
          >
            全部显示
          </button>
        </div>
      </div>

      <div className={range ? 'ae-selection-bar ae-selection-bar-active' : 'ae-selection-bar'}>
        {range && selection ? (
          <>
            <span className="ae-selection-text">
              选区 {range.start} ~ {range.end}（时长 {selectionMs.toFixed(1)} ms）
            </span>
            <button type="button" className="ae-btn ae-btn-ghost" onClick={() => setSelection(null)}>
              清除选区
            </button>
          </>
        ) : (
          <span className="ae-selection-text ae-selection-empty">
            未选择区间：在波形上拖动可框选，增益等操作未选中时作用于全轨
          </span>
        )}
      </div>

      <div className="ae-tools">
        <div className="ae-tool-group">
          <span className="ae-tool-label">区间</span>
          <button
            type="button"
            className="ae-btn"
            disabled={!hasSelection}
            onClick={() => range && applyEdit((input) => trimRange(input, range.start, range.end), true)}
          >
            裁剪到选区
          </button>
          <button
            type="button"
            className="ae-btn"
            disabled={!hasSelection}
            onClick={() => range && applyEdit((input) => removeRange(input, range.start, range.end), true)}
          >
            删除选区
          </button>
          <button
            type="button"
            className="ae-btn"
            disabled={!hasSelection}
            onClick={() => range && applyEdit((input) => silenceRange(input, range.start, range.end))}
          >
            静音选区
          </button>
          <button
            type="button"
            className="ae-btn"
            disabled={!hasSelection}
            onClick={() => range && applyEdit((input) => fadeRange(input, range.start, range.end, 'in'))}
          >
            淡入选区
          </button>
          <button
            type="button"
            className="ae-btn"
            disabled={!hasSelection}
            onClick={() => range && applyEdit((input) => fadeRange(input, range.start, range.end, 'out'))}
          >
            淡出选区
          </button>
        </div>

        <div className="ae-tool-group">
          <span className="ae-tool-label">全轨</span>
          <button type="button" className="ae-btn" onClick={() => applyEdit((input) => normalize(input))}>
            归一化
          </button>
          <button type="button" className="ae-btn" onClick={() => applyEdit((input) => reverseAll(input))}>
            反转
          </button>
        </div>

        <div className="ae-tool-group">
          <span className="ae-tool-label">历史</span>
          <button type="button" className="ae-btn" disabled={undoDepth === 0} onClick={handleUndo}>
            撤销
          </button>
          <button type="button" className="ae-btn" disabled={!dirty} onClick={handleReset}>
            重置
          </button>
        </div>
      </div>

      <div className="ae-gain">
        <span className="ae-tool-label">增益</span>
        <input
          type="range"
          className="ae-slider"
          min={-24}
          max={24}
          step={0.5}
          value={gainDb}
          onChange={(event) => setGainDb(Number(event.target.value))}
        />
        <input
          type="number"
          className="ae-number"
          min={-24}
          max={24}
          step={0.5}
          value={gainDb}
          onChange={(event) => setGainDb(Math.min(24, Math.max(-24, Number(event.target.value) || 0)))}
        />
        <span className="ae-field-value">dB</span>
        <button type="button" className="ae-btn ae-btn-primary" onClick={handleApplyGain}>
          {hasSelection ? '应用增益（选区）' : '应用增益（全轨）'}
        </button>
      </div>

      <SynthInspector artifact={artifact} />
      </div>

      <footer className="ae-footer">
        <span className="ae-footer-info">
          {dirty ? '当前为编辑后的版本，原件不会被改动' : '当前与原件一致，可直接保存到本地'}
        </span>
        <div className="ae-footer-actions">
          <button type="button" className="ae-btn" onClick={onSaveToDisk}>
            保存到本地
          </button>
          <button type="button" className="ae-btn ae-btn-primary" onClick={handleExport} disabled={!dirty}>
            另存为
          </button>
        </div>
      </footer>
    </div>
  )
}

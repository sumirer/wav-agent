/**
 * 合成参数视图（Serum 风格的参数面板）。
 *
 * 设计意图：生成出来的 wav 只是结果，用户在编辑界面上往往需要知道「这段声音是怎么合成的」
 * 才能判断该怎么改。这里把持久化在素材上的 SynthRecipe 还原成
 * 声部 / 包络 / 频率走向 / FM / 效果链的可视化读数，而不是丢一段 JSON 让人自己读。
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { AudioArtifact, Curve, LayerSpec, OscWaveform, SynthSpec } from '@shared/types'
import { ChevronIcon } from '@/lib/icons'
import { formatSpan } from '@/lib/player'
import { useAppStore } from '@/store/useAppStore'
import '@/styles/synth.css'

/** 每个声部一个主题色，便于在多层叠加时快速区分 */
const LAYER_TONES = ['#4f9cf9', '#a78bfa', '#34d399', '#fbbf24', '#f87171', '#22d3ee']

const WAVEFORM_LABELS: Record<OscWaveform, string> = {
  sine: '正弦波',
  square: '方波',
  triangle: '三角波',
  saw: '锯齿波',
  pulse: '脉冲波',
  noise: '白噪声',
  pink: '粉噪声'
}

/* ------------------------------------------------------------------ */
/* 通用绘图容器                                                        */
/* ------------------------------------------------------------------ */

function Graph({
  height,
  signature,
  draw,
  className
}: {
  height: number
  /** 数据签名，变化即重绘 */
  signature: string
  draw(ctx: CanvasRenderingContext2D, width: number, height: number): void
  className?: string
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

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
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      draw(ctx, width, height)
    }

    render()
    const observer = new ResizeObserver(render)
    observer.observe(wrap)
    return () => observer.disconnect()
    // draw 是渲染期新建的闭包，signature 变化时取到的一定是对应数据的那一份
  }, [height, signature])

  return (
    <div ref={wrapRef} className={className} style={{ height }}>
      <canvas ref={canvasRef} style={{ display: 'block' }} />
    </div>
  )
}

/** 在 canvas 上画一条折线 */
function strokePath(
  ctx: CanvasRenderingContext2D,
  points: [number, number][],
  color: string,
  lineWidth = 1.6
): void {
  if (points.length < 2) return
  ctx.beginPath()
  ctx.moveTo(points[0][0], points[0][1])
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1])
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.stroke()
}

/* ------------------------------------------------------------------ */
/* 旋钮                                                                */
/* ------------------------------------------------------------------ */

function Knob({
  label,
  value,
  ratio,
  tone
}: {
  label: string
  value: string
  /** 0~1，决定环形进度 */
  ratio: number
  tone?: string
}): JSX.Element {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
  return (
    <div className="si-knob-cell">
      <div
        className="si-knob"
        style={
          {
            '--si-sweep': `${clamped * 270}deg`,
            '--si-tone': tone ?? 'var(--accent)'
          } as CSSProperties
        }
      >
        <span className="si-knob-value">{value}</span>
      </div>
      <span className="si-knob-label">{label}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 声部内部的各类图形                                                  */
/* ------------------------------------------------------------------ */

/** 一个周期的波形轮廓 */
function drawCycle(ctx: CanvasRenderingContext2D, waveform: OscWaveform, pulseWidth: number, width: number, height: number, tone: string): void {
  const mid = height / 2
  const amp = height / 2 - 4
  ctx.fillStyle = 'rgba(255, 255, 255, 0.03)'
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, mid)
  ctx.lineTo(width, mid)
  ctx.stroke()

  const steps = Math.max(64, Math.round(width))
  const points: [number, number][] = []
  let seed = 0.37
  const rand = (): number => {
    // 固定种子的伪随机，保证噪声波形每次绘制一致
    seed = (seed * 9301 + 49297) % 233280
    return seed / 233280
  }
  let pinkState = 0
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    let value: number
    switch (waveform) {
      case 'sine':
        value = Math.sin(2 * Math.PI * t)
        break
      case 'square':
        value = t < 0.5 ? 1 : -1
        break
      case 'triangle':
        value = 4 * Math.abs(t - 0.5) - 1
        break
      case 'saw':
        value = 2 * t - 1
        break
      case 'pulse':
        value = t < pulseWidth ? 1 : -1
        break
      case 'noise':
        value = rand() * 2 - 1
        break
      default:
        pinkState = pinkState * 0.86 + (rand() * 2 - 1) * 0.4
        value = Math.max(-1, Math.min(1, pinkState * 1.8))
        break
    }
    points.push([(i / steps) * width, mid - value * amp])
  }
  strokePath(ctx, points, tone, 1.8)
}

/** ADSR 包络曲线 */
function drawEnvelope(
  ctx: CanvasRenderingContext2D,
  env: { attack: number; decay: number; sustain: number; release: number } | undefined,
  width: number,
  height: number,
  tone: string
): void {
  const pad = 6
  const top = pad
  const bottom = height - pad
  const usable = bottom - top
  ctx.fillStyle = 'rgba(255, 255, 255, 0.03)'
  ctx.fillRect(0, 0, width, height)

  const attack = Math.max(0, env?.attack ?? 0)
  const decay = Math.max(0, env?.decay ?? 0)
  const release = Math.max(0, env?.release ?? 0)
  const sustain = Math.max(0, Math.min(1, env?.sustain ?? 1))

  // 横轴按时间加权排布；保持段没有固定时长，给它一个与其余部分成比例的视觉宽度
  const timed = attack + decay + release
  const sustainWeight = timed > 0 ? timed * 0.45 : 1
  const totalWeight = timed + sustainWeight || 1
  const scale = width / totalWeight

  const xAttack = attack * scale
  const xDecay = xAttack + decay * scale
  const xRelease = xDecay + sustainWeight * scale
  const level = bottom - sustain * usable

  const points: [number, number][] = [
    [0, bottom],
    [xAttack, top],
    [xDecay, level],
    [xRelease, level],
    [width, bottom]
  ]

  // 填充包络下方区域，视觉上接近合成器的包络显示
  ctx.beginPath()
  ctx.moveTo(0, bottom)
  for (const [x, y] of points.slice(1)) ctx.lineTo(x, y)
  ctx.lineTo(width, bottom)
  ctx.closePath()
  const gradient = ctx.createLinearGradient(0, top, 0, bottom)
  gradient.addColorStop(0, `${tone}44`)
  gradient.addColorStop(1, `${tone}05`)
  ctx.fillStyle = gradient
  ctx.fill()

  strokePath(ctx, points, tone, 1.8)

  // 三段分界用虚线标出，便于对照下方的 A/D/R 读数
  ctx.save()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)'
  ctx.setLineDash([3, 3])
  ctx.lineWidth = 1
  for (const x of [xAttack, xDecay]) {
    if (x <= 0 || x >= width) continue
    ctx.beginPath()
    ctx.moveTo(x, top)
    ctx.lineTo(x, bottom)
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.moveTo(0, bottom)
  ctx.lineTo(width, bottom)
  ctx.stroke()
  ctx.restore()
}

/** 折线参数曲线（频率走向 / 音量变化） */
function drawCurve(
  ctx: CanvasRenderingContext2D,
  curve: Curve,
  width: number,
  height: number,
  color: string,
  logarithmic: boolean
): void {
  const pad = 6
  const top = pad
  const bottom = height - pad
  ctx.fillStyle = 'rgba(255, 255, 255, 0.03)'
  ctx.fillRect(0, 0, width, height)

  const values = curve.map(([, value]) => (logarithmic ? Math.log2(Math.max(value, 1)) : value))
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const tMin = curve[0][0]
  const tMax = curve[curve.length - 1][0]
  const tSpan = tMax - tMin || 1

  const points: [number, number][] = curve.map(([time], index) => [
    ((time - tMin) / tSpan) * width,
    bottom - ((values[index] - min) / span) * (bottom - top)
  ])

  ctx.beginPath()
  ctx.moveTo(points[0][0], bottom)
  for (const [x, y] of points) ctx.lineTo(x, y)
  ctx.lineTo(width, bottom)
  ctx.closePath()
  ctx.fillStyle = `${color}22`
  ctx.fill()

  strokePath(ctx, points, color, 1.8)

  // 首尾数值标注，让「从多少扫到多少」一眼可见
  ctx.fillStyle = 'rgba(230, 236, 245, 0.72)'
  ctx.font = '10px system-ui, sans-serif'
  ctx.textBaseline = 'top'
  const startLabel = logarithmic ? `${Math.round(2 ** values[0])}Hz` : values[0].toFixed(2)
  const endLabel = logarithmic ? `${Math.round(2 ** values[values.length - 1])}Hz` : values[values.length - 1].toFixed(2)
  ctx.fillText(startLabel, 4, 2)
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  ctx.fillText(endLabel, width - 4, height - 2)
  ctx.textAlign = 'left'
}

/* ------------------------------------------------------------------ */
/* 声部卡片                                                            */
/* ------------------------------------------------------------------ */

function effectChips(layer: LayerSpec): string[] {
  const effects = layer.effects
  if (!effects) return []
  const chips: string[] = []
  if (effects.distortion) chips.push(`失真 ${effects.distortion.toFixed(2)}`)
  if (effects.bitcrush) chips.push(`降位 ${Math.round(effects.bitcrush)}bit`)
  if (effects.lowpass) chips.push(`低通 ${Math.round(effects.lowpass)}Hz`)
  if (effects.highpass) chips.push(`高通 ${Math.round(effects.highpass)}Hz`)
  if (effects.delay) {
    chips.push(`延迟 ${Math.round(effects.delay.time * 1000)}ms · 反馈 ${effects.delay.feedback.toFixed(2)} · 混合 ${effects.delay.mix.toFixed(2)}`)
  }
  if (effects.reverb) chips.push(`混响 衰减 ${effects.reverb.decay.toFixed(2)} · 混合 ${effects.reverb.mix.toFixed(2)}`)
  return chips
}

function LayerCard({ layer, index }: { layer: LayerSpec; index: number }): JSX.Element {
  const tone = LAYER_TONES[index % LAYER_TONES.length]
  const waveform = layer.waveform ?? 'sine'
  const envelope = layer.envelope
  const frequencyCurve = layer.frequencyCurve
  const amplitudeCurve = layer.amplitudeCurve
  const chips = effectChips(layer)
  const signature = JSON.stringify(layer)
  // 面板在窄抽屉里很高，默认只展开第一层的图形，数值读数则始终可见
  const [graphsOpen, setGraphsOpen] = useState(index === 0)

  return (
    <div className="si-layer" style={{ '--si-tone': tone } as CSSProperties}>
      <div className="si-layer-head">
        <span className="si-layer-index">声部 {index + 1}</span>
        <span className="si-layer-wave">{WAVEFORM_LABELS[waveform] ?? waveform}</span>
        <span style={{ flex: 1 }} />
        <span className="si-layer-amp">音量 {layer.amplitude ?? 1}</span>
        <button
          type="button"
          className="si-layer-toggle"
          onClick={() => setGraphsOpen((value) => !value)}
          title={graphsOpen ? '收起图形' : '展开图形'}
        >
          {graphsOpen ? '收起图形' : '展开图形'}
        </button>
      </div>

      {graphsOpen && (
        <div className="si-layer-graphs">
          <div className="si-graph-grid">
            <div className="si-graph-cell">
              <span className="si-graph-title">波形（一个周期）</span>
              <Graph
                height={54}
                signature={`cycle:${signature}`}
                className="si-graph"
                draw={(ctx, width, height) => drawCycle(ctx, waveform, layer.pulseWidth ?? 0.5, width, height, tone)}
              />
            </div>

            {envelope ? (
              <div className="si-graph-cell">
                <span className="si-graph-title">音量包络 ADSR</span>
                <Graph
                  height={54}
                  signature={`env:${signature}`}
                  className="si-graph"
                  draw={(ctx, width, height) => drawEnvelope(ctx, envelope, width, height, tone)}
                />
                <div className="si-adsr-row">
                  <span>A {envelope.attack.toFixed(3)}s</span>
                  <span>D {envelope.decay.toFixed(3)}s</span>
                  <span>S {envelope.sustain.toFixed(2)}</span>
                  <span>R {envelope.release.toFixed(3)}s</span>
                </div>
              </div>
            ) : (
              <div className="si-graph-cell">
                <span className="si-graph-title">音量包络 ADSR</span>
                <div className="si-graph si-graph-empty">未设置包络（保持恒定音量）</div>
              </div>
            )}
          </div>

          {frequencyCurve && frequencyCurve.length > 1 && (
            <div className="si-graph-cell">
              <span className="si-graph-title">频率走向（对数刻度）</span>
              <Graph
                height={58}
                signature={`freq:${signature}`}
                className="si-graph"
                draw={(ctx, width, height) => drawCurve(ctx, frequencyCurve, width, height, tone, true)}
              />
            </div>
          )}

          {amplitudeCurve && amplitudeCurve.length > 1 && (
            <div className="si-graph-cell">
              <span className="si-graph-title">音量变化</span>
              <Graph
                height={58}
                signature={`amp:${signature}`}
                className="si-graph"
                draw={(ctx, width, height) => drawCurve(ctx, amplitudeCurve, width, height, tone, false)}
              />
            </div>
          )}
        </div>
      )}

      <div className="si-params">
        {frequencyCurve && frequencyCurve.length > 1 ? (
          <span className="si-param">
            <b>扫频</b>
            {Math.round(frequencyCurve[0][1])} → {Math.round(frequencyCurve[frequencyCurve.length - 1][1])} Hz
          </span>
        ) : (
          <span className="si-param">
            <b>基频</b>
            {layer.frequency ?? 440} Hz
          </span>
        )}
        {layer.detune ? (
          <span className="si-param">
            <b>微调</b>
            {layer.detune > 0 ? '+' : ''}
            {layer.detune} 音分
          </span>
        ) : null}
        {layer.pan ? (
          <span className="si-param">
            <b>声像</b>
            {layer.pan < 0 ? `左 ${Math.round(Math.abs(layer.pan) * 100)}%` : `右 ${Math.round(layer.pan * 100)}%`}
          </span>
        ) : null}
        {layer.pulseWidth !== undefined && waveform === 'pulse' ? (
          <span className="si-param">
            <b>占空比</b>
            {Math.round(layer.pulseWidth * 100)}%
          </span>
        ) : null}
        {layer.startTime || layer.endTime ? (
          <span className="si-param">
            <b>时段</b>
            {(layer.startTime ?? 0).toFixed(3)}s ~ {layer.endTime !== undefined ? `${layer.endTime.toFixed(3)}s` : '结尾'}
          </span>
        ) : null}
      </div>

      {layer.fm && (
        <div className="si-fm">
          <span className="si-fm-title">FM 频率调制</span>
          <span className="si-param">
            <b>载波</b>
            {WAVEFORM_LABELS[layer.fm.waveform ?? 'sine']}
          </span>
          <span className="si-param">
            <b>倍频比</b>
            {layer.fm.ratio}
          </span>
          <span className="si-param">
            <b>调制深度</b>
            {layer.fm.index}
          </span>
        </div>
      )}

      {chips.length > 0 && (
        <div className="si-effects">
          <span className="si-fm-title">效果链</span>
          {chips.map((chip) => (
            <span key={chip} className="si-effect-chip">
              {chip}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 主组件                                                              */
/* ------------------------------------------------------------------ */

function MasterSection({ spec }: { spec: SynthSpec }): JSX.Element {
  const duration = spec.duration ?? 0
  const gain = spec.gain ?? 1
  const fadeIn = spec.fadeIn ?? 0
  const fadeOut = spec.fadeOut ?? 0
  const normalize = spec.normalize !== false

  return (
    <div className="si-master">
      <span className="si-section-title">主控</span>
      <div className="si-knobs">
        <Knob label="时长" value={formatSpan(duration)} ratio={Math.min(1, duration / 5)} />
        <Knob label="总增益" value={`${gain.toFixed(2)}x`} ratio={Math.min(1, gain / 2)} />
        <Knob label="淡入" value={fadeIn ? `${Math.round(fadeIn * 1000)}ms` : '关'} ratio={Math.min(1, fadeIn / 1)} />
        <Knob label="淡出" value={fadeOut ? `${Math.round(fadeOut * 1000)}ms` : '关'} ratio={Math.min(1, fadeOut / 1)} />
        <Knob
          label="归一化"
          value={normalize ? '开' : '关'}
          ratio={normalize ? 1 : 0}
          tone={normalize ? 'var(--success)' : 'var(--text-faint)'}
        />
        <Knob label="采样率" value={`${(spec.sampleRate ?? 44100) / 1000}k`} ratio={1} tone="#22d3ee" />
        <Knob label="声道" value={spec.channels === 2 ? '立体声' : '单声道'} ratio={spec.channels === 2 ? 1 : 0.5} tone="#22d3ee" />
      </div>
    </div>
  )
}

export default function SynthInspector({ artifact }: { artifact: AudioArtifact }): JSX.Element | null {
  const [expanded, setExpanded] = useState(true)
  const pushToast = useAppStore((state) => state.pushToast)
  const recipe = artifact.recipe

  if (!recipe) {
    return (
      <section className="si-root">
        <header className="si-head">
          <span className="si-title">合成方式</span>
          <span className="badge">无参数记录</span>
        </header>
        <p className="si-empty">
          这段音频没有可还原的合成参数。
          {artifact.source === 'import'
            ? '它是从外部导入的 WAV 文件，参数来自其它工具。'
            : '它是在本应用之外生成的。'}
        </p>
      </section>
    )
  }

  const layerCount = recipe.mode === 'spec' ? recipe.spec.layers.length : 0
  const summary =
    recipe.mode === 'code'
      ? `代码合成 · sample(t, ctx) · ${formatSpan(recipe.duration)}`
      : `参数合成 · ${layerCount} 个声部 · ${formatSpan(recipe.spec.duration ?? artifact.duration)}`

  const copyParams = async (): Promise<void> => {
    const payload =
      recipe.mode === 'spec'
        ? JSON.stringify(recipe.spec, null, 2)
        : JSON.stringify({ mode: 'code', duration: recipe.duration, sampleRate: recipe.sampleRate, code: recipe.code }, null, 2)
    try {
      await window.api.system.copyText(payload)
      pushToast('合成参数已复制到剪贴板', 'ok')
    } catch {
      pushToast('复制失败，请手动选择文本复制', 'err')
    }
  }

  const sourceNote =
    artifact.source === 'edit'
      ? '该音频经过波形编辑，以下配方来自它的来源素材，仅作参考，已不再精确对应当前波形。'
      : artifact.source === 'import'
        ? '这段音频由外部导入，以下参数来自它的来源素材。'
        : ''

  return (
    <section className="si-root">
      <header className="si-head">
        <button type="button" className="si-collapse" onClick={() => setExpanded((value) => !value)} title={expanded ? '收起' : '展开'}>
          <ChevronIcon width={14} height={14} className={expanded ? 'si-chevron is-open' : 'si-chevron'} />
        </button>
        <span className="si-title">合成方式</span>
        <span className={`si-mode si-mode-${recipe.mode}`}>{recipe.mode === 'code' ? '代码合成' : '参数合成'}</span>
        <span className="si-summary">{summary}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="si-copy" onClick={() => void copyParams()}>
          复制参数
        </button>
      </header>

      {expanded && (
        <div className="si-body">
          {sourceNote && <p className="si-note">{sourceNote}</p>}

          {recipe.mode === 'spec' ? (
            <>
              <MasterSection spec={recipe.spec} />
              <span className="si-section-title">声部明细</span>
              <div className="si-layers">
                {recipe.spec.layers.map((layer, index) => (
                  <LayerCard key={index} layer={layer} index={index} />
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="si-master">
                <span className="si-section-title">渲染参数</span>
                <div className="si-knobs">
                  <Knob label="时长" value={formatSpan(recipe.duration)} ratio={Math.min(1, recipe.duration / 5)} />
                  <Knob label="采样率" value={`${recipe.sampleRate / 1000}k`} ratio={1} tone="#22d3ee" />
                  <Knob label="声道" value="单声道" ratio={0.5} tone="#22d3ee" />
                </div>
              </div>
              <span className="si-section-title">采样函数</span>
              <pre className="si-code">{recipe.code.trim()}</pre>
              <p className="si-note">
                代码模式在沙箱中逐采样执行，可用 <code>ctx.sr</code>、<code>ctx.dur</code>、<code>ctx.length</code>、
                <code>ctx.note(音名)</code>，返回 -1~1 的单声道采样值。
              </p>
            </>
          )}
        </div>
      )}
    </section>
  )
}

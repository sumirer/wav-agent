/**
 * 代码模式沙箱。
 *
 * 设计意图：结构化 spec 无法表达复杂算法（物理建模、噪声整形等），
 * 因此允许模型给出 sample(t, ctx) 函数体。执行被限制在 vm context 中：
 * 无 require / process / global，且整个逐采样循环在沙箱内执行，
 * 这样 vm 的 timeout 才能真正中断死循环。
 */
import vm from 'node:vm'
import type { CodeSpec } from '../../shared/types'
import { MAX_DURATION_SEC } from './wav'
import type { RenderedAudio } from './synth'

const MAX_CODE_LENGTH = 20000
const EXECUTE_TIMEOUT_MS = 8000

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

const NOTE_OFFSETS: Record<string, number> = {
  C: 0,
  'C#': 1,
  D: 2,
  'D#': 3,
  E: 4,
  F: 5,
  'F#': 6,
  G: 7,
  'G#': 8,
  A: 9,
  'A#': 10,
  B: 11
}

/** 音名（如 A4 / C#5）或 MIDI 编号转频率 */
function noteToFrequency(input: unknown): number {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return 440 * 2 ** ((input - 69) / 12)
  }
  const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(String(input ?? '').trim())
  if (!match) return 440
  let semitone = NOTE_OFFSETS[match[1].toUpperCase()] ?? 0
  if (match[2] === '#') semitone += 1
  else if (match[2] === 'b') semitone -= 1
  const midi = (Number.parseInt(match[3], 10) + 1) * 12 + semitone
  return 440 * 2 ** ((midi - 69) / 12)
}

const SAFE_GLOBALS: Record<string, unknown> = {
  Math,
  Float32Array,
  Float64Array,
  Int32Array,
  Uint8Array,
  Uint32Array,
  Array,
  Object,
  Number,
  String,
  Boolean,
  JSON,
  isFinite,
  isNaN,
  parseInt,
  parseFloat,
  undefined,
  NaN,
  Infinity
}

/** 在沙箱中渲染模型给出的采样函数 */
export function renderCode(spec: CodeSpec, defaultSampleRate: number): RenderedAudio {
  const code = String(spec?.code ?? '')
  if (!code.trim()) throw new Error('code 为空，无法合成音频')
  if (code.length > MAX_CODE_LENGTH) throw new Error(`code 过长（上限 ${MAX_CODE_LENGTH} 字符）`)

  const sampleRate = clamp(Math.round(toNumber(spec.sampleRate, defaultSampleRate)), 8000, 192000)
  const duration = clamp(toNumber(spec.duration, 1), 0.01, MAX_DURATION_SEC)
  const length = Math.max(1, Math.round(duration * sampleRate))

  const sandbox: Record<string, unknown> = { ...SAFE_GLOBALS }
  const context = vm.createContext(sandbox, { name: 'wav-agent-synth' })

  const script = `"use strict";
(function () {
  var __len = ${length};
  var __sr = ${sampleRate};
  var __dur = ${length / sampleRate};
  function note(name) { return __note(name); }
  var ctx = { sr: __sr, dur: __dur, length: __len, note: note };

  /* ---- 模型提供的代码开始 ---- */
${code}
  /* ---- 模型提供的代码结束 ---- */

  if (typeof sample !== 'function') {
    throw new Error('代码必须定义 function sample(t, ctx) { ... }');
  }
  var out = new Float32Array(__len);
  for (var i = 0; i < __len; i++) {
    var t = i / __sr;
    var v = sample(t, ctx);
    if (typeof v !== 'number' || !isFinite(v)) v = 0;
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  globalThis.__wavAgentResult = out;
})();`

  sandbox.__note = noteToFrequency

  try {
    new vm.Script(script, { filename: 'wav-agent-sample.js' }).runInContext(context, {
      timeout: EXECUTE_TIMEOUT_MS
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/Script execution timed out/i.test(message)) {
      throw new Error(`代码执行超时（超过 ${EXECUTE_TIMEOUT_MS / 1000}s），请简化合成逻辑`)
    }
    throw new Error(`沙箱执行失败: ${message}`)
  }

  const result = sandbox.__wavAgentResult
  // 跨 realm 的 Float32Array 不满足宿主侧的 instanceof，改用结构化特征判断
  if (!result || !ArrayBuffer.isView(result) || result.byteLength !== length * 4) {
    throw new Error('沙箱未返回有效的音频数据')
  }
  // 拷贝回当前上下文，避免长期持有其它 realm 的引用
  const mono = new Float32Array(length)
  mono.set(result as unknown as ArrayLike<number>)
  delete sandbox.__wavAgentResult

  return {
    sampleRate,
    channels: [mono],
    duration: length / sampleRate
  }
}

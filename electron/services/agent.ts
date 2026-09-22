/**
 * WAV 生成 Agent。
 *
 * 一次「回合」= 用户输入 -> 组装上下文 -> 与模型多轮交互（含工具调用）-> 落盘。
 * 模型有两种产出音频的方式：
 *   1) 调用 generate_wav 工具（结构化 spec 或沙箱代码），这是首选路径；
 *   2) 若模型不支持 function calling，正文中的 ```json / ```js 代码块会被兜底执行。
 */
import type { WavAgentEvents } from '../../shared/api'
import type { ChatMessage, CodeSpec, SynthRecipe, SynthSpec, ToolCallRecord } from '../../shared/types'
import { renderCode } from './sandbox'
import { renderSpec, type RenderedAudio } from './synth'
import { ChatCompletionMessage, streamChat, ToolDefinition } from './llm'
import { createArtifact } from './library'
import { getSkillRegistry } from './skills'
import { getStore } from './store'

type Emit = <K extends keyof WavAgentEvents>(channel: K, payload: WavAgentEvents[K]) => void

const MAX_TOOL_ROUNDS = 6

/** 合成规格的字段说明，同时用于系统提示词与工具描述，保证两侧一致 */
const SPEC_REFERENCE = `layers[] 每层字段：
- waveform: sine|square|triangle|saw|pulse|noise|pink（必填）
- frequency: 基频 Hz（默认 440）；frequencyCurve: [[t秒, Hz], ...] 折线插值，用于扫频/滑音
- envelope: {attack, decay, sustain(0~1), release}，单位秒，release 从结尾向前倒推
- amplitude: 静态音量 0~1；amplitudeCurve: [[t, 0~1], ...] 时间轴音量变化
- detune: 音分微调；pan: -1 左 ~ 1 右；startTime/endTime: 该层的起止秒数
- pulseWidth: 0~1（waveform=pulse 时生效）
- fm: {waveform, ratio, index} 频率调制，ratio 为倍频比，index 为调制深度
- effects: {distortion(0~1), bitcrush(量化位数 2~16), delay:{time,feedback,mix}, reverb:{decay,mix}, lowpass(Hz), highpass(Hz)}
顶层字段：duration（秒，必填）、sampleRate、channels(1|2)、gain、fadeIn、fadeOut、normalize(默认 true)`

const SPEC_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    duration: { type: 'number', description: '总时长（秒），建议 0.1~5' },
    sampleRate: { type: 'number', description: '默认 44100' },
    channels: { type: 'number', enum: [1, 2] },
    gain: { type: 'number' },
    fadeIn: { type: 'number' },
    fadeOut: { type: 'number' },
    normalize: { type: 'boolean' },
    layers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          waveform: { type: 'string', enum: ['sine', 'square', 'triangle', 'saw', 'pulse', 'noise', 'pink'] },
          frequency: { type: 'number' },
          frequencyCurve: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
          envelope: {
            type: 'object',
            properties: {
              attack: { type: 'number' },
              decay: { type: 'number' },
              sustain: { type: 'number' },
              release: { type: 'number' }
            }
          },
          amplitude: { type: 'number' },
          amplitudeCurve: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
          detune: { type: 'number' },
          pan: { type: 'number' },
          startTime: { type: 'number' },
          endTime: { type: 'number' },
          pulseWidth: { type: 'number' },
          fm: {
            type: 'object',
            properties: {
              waveform: { type: 'string' },
              ratio: { type: 'number' },
              index: { type: 'number' }
            }
          },
          effects: {
            type: 'object',
            properties: {
              distortion: { type: 'number' },
              bitcrush: { type: 'number' },
              delay: {
                type: 'object',
                properties: { time: { type: 'number' }, feedback: { type: 'number' }, mix: { type: 'number' } }
              },
              reverb: { type: 'object', properties: { decay: { type: 'number' }, mix: { type: 'number' } } },
              lowpass: { type: 'number' },
              highpass: { type: 'number' }
            }
          }
        },
        required: ['waveform']
      }
    }
  },
  required: ['duration', 'layers']
}

function buildTools(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'list_skills',
        description: '列出当前可用的 skills。当用户提出的音效需求可能属于某个专门领域时，先调用它。',
        parameters: { type: 'object', properties: {}, required: [] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'use_skill',
        description: '加载指定 skill 的完整指导与示例规格，加载后请严格遵循其中的方法论来设计音频参数。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'skill 的 id，来自 list_skills 的返回结果' }
          },
          required: ['name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'save_skill',
        description: `把一套音频设计方法论保存成可复用的 skill，写入用户的固定 skill 目录，用户下次对话即可直接启用。

什么时候用：用户表达了「帮我创建/定制一个 XX 风格的 skill」「把我的偏好固化成 skill」「以后都按这个风格做」这类意图。
什么时候不用：用户只是要生成音频时，绝对不要调用本工具。

调用前必须先和用户确认风格要点（见系统提示词中的流程），不要凭空替用户决定。`,
        parameters: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: '英文小写目录名，用短横线连接，例如 cyberpunk-mech'
            },
            name: { type: 'string', description: '中文显示名，例如 赛博朋克机械音' },
            description: { type: 'string', description: '一句话说明适用场景，会显示在 skill 列表里' },
            instructions: {
              type: 'string',
              description:
                'Markdown 正文。必须写成可执行的方法论：适用场景、音色配方（具体到 waveform/frequency/envelope/effects 的取值区间）、可直接套用的参数模板、硬性要求与禁忌。建议 60~150 行，不要写空泛描述。'
            },
            examples: {
              type: 'array',
              description: '1~3 个完整可运行的合成规格示例，会被写入该 skill 的 examples 目录，供以后参考',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: '示例文件名，英文小写短横线' },
                  spec: { ...SPEC_SCHEMA, description: '完整的合成规格' }
                },
                required: ['name', 'spec']
              }
            }
          },
          required: ['id', 'name', 'description', 'instructions']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'generate_wav',
        description: `生成 WAV 波形文件。两种模式：
- mode="spec"（首选）：给出结构化合成规格，由本地合成引擎渲染，参数可复现。
- mode="code"：给出一段 JS 代码，必须定义 function sample(t, ctx) 并返回 -1~1 的单声道采样值；ctx 提供 { sr, dur, length, note(name) }。仅当 spec 无法表达（物理建模、复杂噪声塑形等）时使用。

${SPEC_REFERENCE}`,
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '简短的中文标题，会显示在素材列表中' },
            description: { type: 'string', description: '一句话说明音色特征与用途' },
            mode: { type: 'string', enum: ['spec', 'code'] },
            spec: { ...SPEC_SCHEMA, description: 'mode=spec 时的合成规格' },
            code: { type: 'string', description: 'mode=code 时的 JS 代码' },
            duration: { type: 'number', description: 'mode=code 时必填，总时长（秒）' },
            sampleRate: { type: 'number' },
            channels: { type: 'number', enum: [1, 2] }
          },
          required: ['title', 'mode']
        }
      }
    }
  ]
}

function buildSystemPrompt(extra: string, enabledSkills: string): string {
  const skills = getSkillRegistry().list()
  const skillList = skills.length
    ? skills
        .map(
          (skill) =>
            `- ${skill.id}：${skill.name}${skill.description ? ` —— ${skill.description}` : ''}${skill.builtin ? '（内置）' : '（自定义，可用 save_skill 覆盖）'}`
        )
        .join('\n')
    : '（当前没有可用 skill）'

  return `你是 WAV Agent 内置的音频合成专家，负责把用户的自然语言描述变成可直接使用的 WAV 波形文件。

## 工作方式
1. 先用一两句话确认你对音色的理解，然后调用 generate_wav 生成。
2. 绝大多数需求都应该用 mode="spec" 完成：通过叠加多个 layer 得到层次（例如底噪 + 主体音 + 高频点缀）。
3. 只有 spec 无法表达时才用 mode="code"。
4. 每次调用只产出一个音频；用户要多个就分多次调用。
5. 生成完成后用简短的中文说明你用了哪些参数手法，不要重复粘贴整段 JSON。
6. 如果生成报错，读懂错误信息后修正参数重试。
7. 用户对结果不满意时，在其基础上调整参数重新生成，而不是从头解释。

## 可用 skills
${skillList}

技能目录 skills 中可能有专门领域的方法论。当需求贴近某个 skill（例如 8-bit 音乐、UI 提示音）时，先 list_skills 再 use_skill，并遵循其指导。
${enabledSkills ? `\n## 本轮用户显式启用的 skill\n${enabledSkills}\n请务必先加载它们再动手设计参数。\n` : ''}
## 创建自定义 skill
当用户表达「帮我创建一个 XX 风格的 skill」「把我的偏好固化下来」「以后都按这个风格做」这类意图时，按以下流程：

1. **先澄清，不要直接写文件**。一次问 2~4 个关键问题，至少覆盖：
   - 目标场景（游戏音效 / UI 反馈 / 音乐片段 / 环境氛围）
   - 音色核心特征与参考对象（例如「像晶体管收音机」「像 F1 引擎」）
   - 时长与节奏习惯、音量取向
   - 明确不要出现的元素与命名偏好
   如果用户回答「你决定」「随便」，就按你的专业判断补齐，并在保存前用一两句话说明你的取舍。
2. **调用 save_skill 落盘**。instructions 必须是可执行的方法论，建议结构：
   - 适用场景
   - 音色配方：具体到 waveform / frequency 区间 / envelope 取值 / effects 类型与量级
   - 参数模板：给出 1~2 个可直接套用的 layers 结构说明
   - 硬性要求与禁忌
3. **examples 里放 1~3 个完整可运行的 spec**，它们会被写进该 skill 的 examples/*.json，成为以后的参考样例。
4. 保存成功后告诉用户 skill 的中文名、id 与落盘位置，并提醒「新建对话里启用它即可生效」。用户要调整时，再用同一个 id 调用 save_skill 覆盖。
5. 内置 skill 不能被覆盖，需要时换一个 id。
6. 用户只是想生成音频时，不要调用 save_skill。

## 参数规范
${SPEC_REFERENCE}

## 常见设计经验
- 短促提示音：duration 0.1~0.5s，envelope 用极短 attack（0.005s）配合 release 收尾，避免爆音。
- 金属感：多个不成整数倍关系的 layer 叠加 + fm 调制。
- 打击感：noise 层 + 极快衰减 + lowpass 扫频。
- 环境氛围：pink noise 打底 + 慢速 frequencyCurve + reverb 大 mix。
- 建议把 normalize 保持为 true，防止叠加多层后削波。
${extra.trim() ? `\n## 用户自定义要求\n${extra.trim()}` : ''}`
}

/** 把持久化的会话消息还原成 OpenAI 协议的消息数组 */
function toCompletionMessages(sessionId: string): ChatCompletionMessage[] {
  const session = getStore().getSession(sessionId)
  const output: ChatCompletionMessage[] = []
  if (!session) return output
  for (const message of session.messages) {
    if (message.role === 'user') {
      output.push({ role: 'user', content: message.content })
      continue
    }
    if (message.role !== 'assistant') continue
    const calls = (message.toolCalls ?? []).filter((call) => call.status !== 'error' || call.result)
    if (calls.length === 0) {
      if (message.content.trim()) output.push({ role: 'assistant', content: message.content })
      continue
    }
    output.push({
      role: 'assistant',
      content: message.content || null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.args || '{}' }
      }))
    })
    for (const call of calls) {
      output.push({
        role: 'tool',
        tool_call_id: call.id,
        content: call.result ?? '（无返回）'
      })
    }
  }
  return output
}

function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    // 模型偶尔会带 ```json 包裹，做一次清理重试
    const cleaned = raw.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim()
    try {
      const parsed = JSON.parse(cleaned)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
}

interface GeneratedAudio {
  audio: RenderedAudio
  recipe: SynthRecipe
}

function renderFromToolArgs(args: Record<string, unknown>): GeneratedAudio {
  const settings = getStore().getSettings()
  const mode = args.mode === 'code' ? 'code' : 'spec'
  const defaultSampleRate = settings.defaultSampleRate

  if (mode === 'code') {
    const code = typeof args.code === 'string' ? args.code : ''
    const duration = typeof args.duration === 'number' ? args.duration : 1
    const spec: CodeSpec = {
      code,
      duration,
      sampleRate: typeof args.sampleRate === 'number' ? args.sampleRate : defaultSampleRate,
      channels: typeof args.channels === 'number' ? args.channels : 1
    }
    const audio = renderCode(spec, defaultSampleRate)
    return {
      audio,
      recipe: { mode: 'code', code, duration: audio.duration, sampleRate: audio.sampleRate }
    }
  }

  const rawSpec = (args.spec ?? args) as Partial<SynthSpec>
  if (!rawSpec || typeof rawSpec !== 'object' || !Array.isArray((rawSpec as SynthSpec).layers)) {
    throw new Error('spec.layers 缺失，请按参数规范提供 layers 数组')
  }
  const finalSpec = rawSpec as SynthSpec
  const audio = renderSpec(finalSpec, defaultSampleRate)
  return {
    audio,
    // 回填实际生效的采样率与声道数，保证参数视图与产物完全一致
    recipe: {
      mode: 'spec',
      spec: { ...finalSpec, duration: audio.duration, sampleRate: audio.sampleRate, channels: audio.channels.length }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 正文代码块兜底                                                      */
/* ------------------------------------------------------------------ */

interface FallbackPayload {
  args: Record<string, unknown>
  reason: string
}

/** 解析模型正文里未走工具调用的规格代码块 */
function extractCodeBlockFallback(content: string): FallbackPayload | null {
  const jsonBlock = /```json\s*([\s\S]*?)```/i.exec(content)
  if (jsonBlock) {
    try {
      const parsed = JSON.parse(jsonBlock[1])
      if (parsed && Array.isArray(parsed.layers)) {
        return { args: { mode: 'spec', spec: parsed, title: '对话生成音频' }, reason: '检测到正文中的 JSON 规格' }
      }
    } catch {
      /* 交给下面的代码块分支处理 */
    }
  }
  const jsBlock = /```(?:js|javascript)\s*([\s\S]*?)```/i.exec(content)
  if (jsBlock && /function\s+sample\s*\(/.test(jsBlock[1])) {
    return {
      args: { mode: 'code', code: jsBlock[1], duration: 2, title: '对话生成音频' },
      reason: '检测到正文中的 sample 函数'
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 回合执行                                                            */
/* ------------------------------------------------------------------ */

export interface RunTurnOptions {
  sessionId: string
  userText: string
  skillNames: string[]
  emit: Emit
  signal: AbortSignal
}

function createMessage(role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    role,
    content,
    createdAt: Date.now(),
    ...extra
  }
}

export async function runAgentTurn(options: RunTurnOptions): Promise<void> {
  const { sessionId, userText, skillNames, emit, signal } = options
  const store = getStore()
  const settings = store.getSettings()
  const registry = getSkillRegistry()

  const userMessage = createMessage('user', userText, { skillNames })
  store.addMessage(sessionId, userMessage)
  const session = store.getSession(sessionId)
  // 首条消息顺便作为会话标题
  if (session && session.title === '新的对话') {
    store.renameSession(sessionId, userText.slice(0, 24))
  }
  emit('chat:message', { sessionId, message: userMessage })

  const assistant = createMessage('assistant', '', { toolCalls: [], artifactIds: [] })
  store.addMessage(sessionId, assistant)
  emit('chat:message', { sessionId, message: assistant })

  const fail = (error: string): void => {
    store.updateMessage(sessionId, assistant.id, { error, content: assistant.content })
    store.commit(sessionId)
    emit('chat:error', { sessionId, messageId: assistant.id, error })
    emit('chat:done', { sessionId, message: store.getSession(sessionId)?.messages.find((m) => m.id === assistant.id) ?? assistant })
  }

  if (!settings.model.apiKey.trim()) {
    fail('尚未配置 API Key，请先到左下角「设置」中填写模型信息。')
    return
  }
  if (!settings.model.model.trim()) {
    fail('尚未配置模型名称，请先到左下角「设置」中填写。')
    return
  }

  // 显式启用的 skill 直接把内容注入提示词，省掉一次工具往返
  let explicitSkillText = ''
  for (const name of skillNames) {
    const detail = registry.get(name)
    if (detail) explicitSkillText += `\n### skill: ${detail.name}\n${detail.instructions}\n`
  }

  const messages: ChatCompletionMessage[] = [
    { role: 'system', content: buildSystemPrompt(settings.systemPromptExtra, explicitSkillText) },
    ...toCompletionMessages(sessionId)
  ]

  const tools = buildTools()
  let usedTool = false

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      if (signal.aborted) throw new Error('已取消')

      emit('chat:status', {
        sessionId,
        messageId: assistant.id,
        label: round === 0 ? '正在思考…' : '正在继续处理…'
      })

      const result = await streamChat({
        config: settings.model,
        messages,
        tools,
        signal,
        onDelta: (delta) => {
          if (delta) emit('chat:delta', { sessionId, messageId: assistant.id, delta })
        }
      })

      if (result.content) {
        assistant.content = assistant.content ? `${assistant.content}\n${result.content}` : result.content
      }

      if (result.toolCalls.length === 0) {
        // 支持工具调用的模型走完流程；否则尝试从正文里兜底提取规格
        if (round === 0 && !usedTool && settings.autoRunCodeBlock) {
          const fallback = extractCodeBlockFallback(assistant.content)
          if (fallback) {
            emit('chat:status', { sessionId, messageId: assistant.id, label: fallback.reason })
            const callId = `fallback_${Date.now().toString(36)}`
            const record: ToolCallRecord = {
              id: callId,
              name: 'generate_wav',
              args: JSON.stringify(fallback.args),
              status: 'running'
            }
            assistant.toolCalls = [...(assistant.toolCalls ?? []), record]
            store.updateMessage(sessionId, assistant.id, { toolCalls: assistant.toolCalls })
            emit('chat:status', { sessionId, messageId: assistant.id, label: '正在合成音频…' })
            try {
              const artifact = generateArtifactFromArgs(fallback.args, { sessionId, prompt: userText, fallback: true })
              record.status = 'done'
              record.result = `已生成 ${artifact.title}`
              assistant.artifactIds = [...(assistant.artifactIds ?? []), artifact.id]
              emit('chat:artifact', { sessionId, artifact })
              emit('chat:status', { sessionId, messageId: assistant.id, label: '音频生成完成' })
            } catch (error) {
              record.status = 'error'
              record.result = error instanceof Error ? error.message : String(error)
              emit('chat:status', { sessionId, messageId: assistant.id, label: '音频生成失败' })
            }
            store.updateMessage(sessionId, assistant.id, { toolCalls: assistant.toolCalls })
          }
        }
        break
      }

      usedTool = true
      // 把本轮的 tool_calls 写入持久化记录，供下轮上下文还原
      const records: ToolCallRecord[] = result.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        args: call.arguments,
        status: 'running'
      }))
      assistant.toolCalls = [...(assistant.toolCalls ?? []), ...records]
      store.updateMessage(sessionId, assistant.id, { toolCalls: assistant.toolCalls })
      messages.push({
        role: 'assistant',
        content: result.content || null,
        tool_calls: result.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments }
        }))
      })

      for (const [index, call] of result.toolCalls.entries()) {
        const record = records[index]
        if (signal.aborted) throw new Error('已取消')
        emit('chat:status', { sessionId, messageId: assistant.id, label: `执行 ${call.name}…` })
        try {
          const outcome = await executeTool(call.name, call.arguments, { sessionId, prompt: userText, emit, assistant })
          record.status = 'done'
          record.result = outcome.text
          if (outcome.artifact) {
            assistant.artifactIds = [...(assistant.artifactIds ?? []), outcome.artifact.id]
            emit('chat:artifact', { sessionId, artifact: outcome.artifact })
          }
        } catch (error) {
          record.status = 'error'
          record.result = `错误：${error instanceof Error ? error.message : String(error)}`
        }
        store.updateMessage(sessionId, assistant.id, { toolCalls: assistant.toolCalls })
        messages.push({ role: 'tool', tool_call_id: call.id, content: record.result ?? '' })
      }
    }

    store.updateMessage(sessionId, assistant.id, {
      content: assistant.content,
      toolCalls: assistant.toolCalls,
      artifactIds: assistant.artifactIds
    })
    store.commit(sessionId)
    emit('chat:status', { sessionId, messageId: assistant.id, label: '' })
    emit('chat:done', {
      sessionId,
      message: store.getSession(sessionId)?.messages.find((m) => m.id === assistant.id) ?? assistant
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (signal.aborted || /aborted|cancel/i.test(message)) {
      assistant.content = assistant.content || '（已取消）'
      store.updateMessage(sessionId, assistant.id, {
        content: assistant.content,
        toolCalls: assistant.toolCalls,
        artifactIds: assistant.artifactIds
      })
      store.commit(sessionId)
      emit('chat:status', { sessionId, messageId: assistant.id, label: '' })
      emit('chat:done', { sessionId, message: assistant })
      return
    }
    assistant.toolCalls = (assistant.toolCalls ?? []).map((record) =>
      record.status === 'running' ? { ...record, status: 'error' as const, result: message } : record
    )
    fail(message)
  }
}

function generateArtifactFromArgs(
  args: Record<string, unknown>,
  context: { sessionId: string; prompt: string; fallback?: boolean }
): ReturnType<typeof createArtifact> {
  const { audio, recipe } = renderFromToolArgs(args)
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : '未命名音频'
  return createArtifact({
    title,
    description: typeof args.description === 'string' ? args.description : '',
    prompt: context.prompt,
    sampleRate: audio.sampleRate,
    channels: audio.channels,
    source: 'agent',
    recipe,
    sessionId: context.sessionId
  })
}

interface ToolOutcome {
  text: string
  artifact?: ReturnType<typeof createArtifact>
}

async function executeTool(
  name: string,
  rawArgs: string,
  context: {
    sessionId: string
    prompt: string
    emit: Emit
    assistant: ChatMessage
  }
): Promise<ToolOutcome> {
  const registry = getSkillRegistry()

  if (name === 'list_skills') {
    const skills = registry.list()
    if (skills.length === 0) return { text: '当前没有可用 skill。' }
    return {
      text: skills
        .map(
          (skill) =>
            `- ${skill.id}：${skill.name}${skill.description ? ` —— ${skill.description}` : ''}${skill.builtin ? '（内置）' : '（自定义，可用 save_skill 覆盖）'}`
        )
        .join('\n')
    }
  }

  if (name === 'save_skill') {
    const args = safeParseArgs(rawArgs)
    const examples = Array.isArray(args.examples)
      ? (args.examples as { name?: unknown; spec?: unknown }[])
          .filter((item) => item && item.spec)
          .map((item, index) => ({ name: String(item.name ?? `example-${index + 1}`), spec: item.spec }))
      : []
    const saved = registry.saveSkill({
      id: String(args.id ?? ''),
      name: String(args.name ?? ''),
      description: typeof args.description === 'string' ? args.description : '',
      instructions: String(args.instructions ?? ''),
      examples
    })
    context.emit('data:changed', { scope: 'skills' })
    context.emit('chat:status', {
      sessionId: context.sessionId,
      messageId: context.assistant.id,
      label: `已创建 skill「${saved.name}」`
    })
    return {
      text: `已保存 skill「${saved.name}」（id: ${saved.id}），落盘位置 ${saved.dir}，包含 ${saved.examples.length} 个示例。它已出现在用户的 skill 列表中，新建对话时可直接启用。`
    }
  }

  if (name === 'use_skill') {
    const args = safeParseArgs(rawArgs)
    const id = String(args.name ?? '')
    const detail = registry.get(id)
    if (!detail) {
      const available = registry.list().map((skill) => skill.id).join(', ') || '（无）'
      return { text: `未找到 skill「${id}」。可用：${available}` }
    }
    let text = `# skill ${detail.name}\n${detail.instructions}`
    const exampleName = detail.examples[0]
    if (exampleName) {
      const example = registry.readExample(detail.id, exampleName)
      if (example) text += `\n\n## 示例规格 (${exampleName})\n\`\`\`json\n${example.slice(0, 3000)}\n\`\`\``
    }
    return { text }
  }

  if (name === 'generate_wav') {
    const args = safeParseArgs(rawArgs)
    if (typeof args.mode !== 'string') args.mode = typeof args.code === 'string' ? 'code' : 'spec'
    context.emit('chat:status', { sessionId: context.sessionId, messageId: context.assistant.id, label: '正在合成音频…' })
    const artifact = generateArtifactFromArgs(args, { sessionId: context.sessionId, prompt: context.prompt })
    context.emit('chat:status', { sessionId: context.sessionId, messageId: context.assistant.id, label: '音频生成完成' })
    return { text: describeArtifact(artifact), artifact }
  }

  throw new Error(`未知工具: ${name}`)
}

function describeArtifact(artifact: { title: string; duration: number; sampleRate: number; channels: number; peaks: number[][] }): string {
  let peak = 0
  for (const channel of artifact.peaks) {
    for (const value of channel) if (value > peak) peak = value
  }
  return `已生成音频「${artifact.title}」：时长 ${artifact.duration.toFixed(2)}s，采样率 ${artifact.sampleRate}Hz，${artifact.channels} 声道，峰值约 ${peak.toFixed(3)}。音频已进入左侧素材列表，等待用户点击「保存到本地」选择保存路径。`
}

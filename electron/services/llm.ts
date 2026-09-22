/**
 * 标准 OpenAI 兼容协议的对话客户端。
 * 只依赖 /chat/completions 与 /models 两个端点，方便接入任意兼容服务
 * （OpenAI / DeepSeek / Qwen / Ollama / OneAPI / vLLM 等）。
 */
import type { ModelConfig } from '../../shared/types'

export interface ToolCall {
  id: string
  name: string
  /** 原始 JSON 字符串，由调用方负责解析与容错 */
  arguments: string
}

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface StreamResult {
  content: string
  toolCalls: ToolCall[]
}

function resolveEndpoint(baseUrl: string, suffix: string): string {
  const base = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('未配置 Base URL')
  if (base.endsWith('/chat/completions')) {
    return suffix === '/chat/completions' ? base : `${base.slice(0, -'/chat/completions'.length)}${suffix}`
  }
  return `${base}${suffix}`
}

export function chatEndpoint(baseUrl: string): string {
  return resolveEndpoint(baseUrl, '/chat/completions')
}

function buildHeaders(config: ModelConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`
  return headers
}

async function readError(response: Response): Promise<string> {
  let detail = ''
  try {
    detail = (await response.text()).slice(0, 500)
  } catch {
    detail = ''
  }
  return `请求失败 ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`
}

/** 流式对话。文字增量通过 onDelta 实时回调，工具调用在结束时一次性返回。 */
export async function streamChat(options: {
  config: ModelConfig
  messages: ChatCompletionMessage[]
  tools?: ToolDefinition[]
  signal?: AbortSignal
  onDelta?: (text: string) => void
  onReasoning?: (text: string) => void
}): Promise<StreamResult> {
  const { config, messages, tools, signal, onDelta, onReasoning } = options
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
    temperature: config.temperature
  }
  if (config.maxTokens > 0) body.max_tokens = config.maxTokens
  if (tools && tools.length > 0) {
    body.tools = tools
    body.tool_choice = 'auto'
  }

  const response = await fetch(chatEndpoint(config.baseUrl), {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify(body),
    signal
  })

  if (!response.ok) throw new Error(await readError(response))

  const contentType = response.headers.get('content-type') ?? ''
  // 部分网关不支持 SSE，会直接返回完整 JSON
  if (contentType.includes('application/json')) {
    const payload = (await response.json()) as any
    const message = payload?.choices?.[0]?.message ?? {}
    const content = typeof message.content === 'string' ? message.content : ''
    if (content && onDelta) onDelta(content)
    return { content, toolCalls: normalizeToolCalls(message.tool_calls) }
  }

  if (!response.body) throw new Error('服务端未返回响应体')

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let content = ''
  const toolCallAcc = new Map<number, { id: string; name: string; args: string }>()

  const consumeEvent = (rawEvent: string): boolean => {
    for (const line of rawEvent.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload) continue
      if (payload === '[DONE]') return true
      let parsed: any
      try {
        parsed = JSON.parse(payload)
      } catch {
        continue
      }
      const delta = parsed?.choices?.[0]?.delta
      if (!delta) continue
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content && onReasoning) {
        onReasoning(delta.reasoning_content)
      }
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content
        if (onDelta) onDelta(delta.content)
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = typeof call.index === 'number' ? call.index : 0
          const current = toolCallAcc.get(index) ?? { id: '', name: '', args: '' }
          if (call.id) current.id = call.id
          if (call.function?.name) current.name = call.function.name
          if (call.function?.arguments) current.args += call.function.arguments
          toolCallAcc.set(index, current)
        }
      }
    }
    return false
  }

  let finished = false
  while (!finished) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // 统一换行符后再切分事件：不少网关用 \r\n\r\n 分隔，直接找 \n\n 会漏解析
    buffer = buffer.replace(/\r\n/g, '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      if (consumeEvent(rawEvent)) {
        finished = true
        break
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
  if (!finished && buffer.trim()) consumeEvent(buffer)

  const toolCalls: ToolCall[] = [...toolCallAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, value]) => value.name)
    .map(([index, value]) => ({
      id: value.id || `call_${index}_${Date.now().toString(36)}`,
      name: value.name,
      arguments: value.args || '{}'
    }))

  return { content, toolCalls }
}

function normalizeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item) => item?.function?.name)
    .map((item, index) => ({
      id: item.id || `call_${index}_${Date.now().toString(36)}`,
      name: item.function.name,
      arguments: typeof item.function.arguments === 'string' ? item.function.arguments : JSON.stringify(item.function.arguments ?? {})
    }))
}

/** 连通性检测：拉取模型列表，同时校验 apiKey */
export async function probeModel(config: ModelConfig): Promise<{ ok: boolean; message: string; models?: string[] }> {
  try {
    const response = await fetch(resolveEndpoint(config.baseUrl, '/models'), {
      method: 'GET',
      headers: buildHeaders(config)
    })
    if (!response.ok) return { ok: false, message: await readError(response) }
    const payload = (await response.json()) as { data?: { id?: string }[] }
    const models = (payload.data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id))
    return { ok: true, message: `连接成功，可用模型 ${models.length} 个`, models }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

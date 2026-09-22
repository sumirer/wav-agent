/**
 * 主进程与渲染进程共享的类型定义。
 * 该文件是两端唯一的契约来源，任何字段变更都必须同时满足两侧编译。
 */

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

/** 标准 OpenAI 兼容协议的模型配置 */
export interface ModelConfig {
  /** 例: https://api.openai.com/v1 */
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
}

export interface AppSettings {
  model: ModelConfig
  /** 生成的 wav 默认保存目录 */
  audioOutputDir: string
  /** 最近一次保存目录，用于保存对话框的默认位置 */
  lastSaveDir: string
  /** 新建会话时的默认采样率 */
  defaultSampleRate: number
  /**
   * 自定义 skill 的固定目录。应用启动时会自动扫描该目录，
   * Agent 通过 save_skill 创建的新 skill 也写入这里。
   */
  skillsDir: string
  /** 追加到系统提示词末尾的自定义内容 */
  systemPromptExtra: string
  /** 自动执行模型在正文中输出的 spec/code 代码块（针对不支持 function calling 的模型） */
  autoRunCodeBlock: boolean
}

/* ------------------------------------------------------------------ */
/* 音频合成规格                                                        */
/* ------------------------------------------------------------------ */

export type OscWaveform = 'sine' | 'square' | 'triangle' | 'saw' | 'pulse' | 'noise' | 'pink'

/** 时间(秒) -> 值 的折线断点，线性插值 */
export type Curve = [number, number][]

export interface EnvelopeSpec {
  /** 以下四项单位均为秒；sustain 为 0~1 的保持电平 */
  attack: number
  decay: number
  sustain: number
  release: number
}

export interface LayerEffects {
  /** 0~1，0 表示关闭 */
  distortion?: number
  /** 量化位数，如 6 表示 6bit */
  bitcrush?: number
  delay?: { time: number; feedback: number; mix: number }
  reverb?: { decay: number; mix: number }
  lowpass?: number
  highpass?: number
}

export interface LayerSpec {
  waveform: OscWaveform
  /** 基频 Hz，默认 440 */
  frequency?: number
  /** 频率随时间变化，优先级高于 frequency */
  frequencyCurve?: Curve
  /** 音量包络 ADSR */
  envelope?: EnvelopeSpec
  /** 静态音量 0~1 */
  amplitude?: number
  /** 音量随时间变化，会与 envelope 相乘 */
  amplitudeCurve?: Curve
  /** 音分单位的微调 */
  detune?: number
  /** -1 左 ~ 1 右 */
  pan?: number
  /** 起始时间偏移（秒） */
  startTime?: number
  /** 相对于总时长的结束时间（秒），默认到结尾 */
  endTime?: number
  /** 脉冲波占空比 0~1 */
  pulseWidth?: number
  /** 频率调制 */
  fm?: { waveform: OscWaveform; ratio: number; index: number }
  effects?: LayerEffects
}

export interface SynthSpec {
  /** 总时长（秒） */
  duration: number
  sampleRate?: number
  /** 1 或 2，默认沿用请求值 */
  channels?: number
  /** 整体增益，默认 1 */
  gain?: number
  fadeIn?: number
  fadeOut?: number
  normalize?: boolean
  layers: LayerSpec[]
}

/** 沙箱代码模式：模型提供 sample 函数体，逐采样执行 */
export interface CodeSpec {
  code: string
  duration: number
  sampleRate?: number
  channels?: number
}

/**
 * 生成该音频所用的合成配方。
 * 持久化在素材上，使编辑界面能够还原「这段声音是怎么合成出来的」。
 * spec 模式记下完整规格；code 模式记下采样函数与渲染参数。
 */
export type SynthRecipe =
  | { mode: 'spec'; spec: SynthSpec }
  | { mode: 'code'; code: string; duration: number; sampleRate: number }

export type RenderMode = SynthRecipe['mode']

/* ------------------------------------------------------------------ */
/* 音频素材（库中的一条音频文档）                                       */
/* ------------------------------------------------------------------ */

export type ArtifactSource = 'agent' | 'edit' | 'import'

export interface AudioArtifact {
  id: string
  title: string
  description: string
  /** 触发本次生成的用户输入（编辑/导入则为空） */
  prompt: string
  createdAt: number
  sampleRate: number
  channels: number
  duration: number
  /** 用户确认保存到本地后的绝对路径；null 表示尚未保存到本地 */
  savedPath: string | null
  source: ArtifactSource
  /** 编辑来源的素材 id */
  originId: string | null
  sessionId: string | null
  /**
   * 合成配方。外部导入为 null；
   * 波形编辑另存的产物沿用来源素材的配方（界面会标注它已不再精确对应当前波形）。
   */
  recipe: SynthRecipe | null
  /** 每声道降采样包络，渲染层用于缩略图 */
  peaks: number[][]
  sizeBytes: number
}

export interface AudioPayload {
  id: string
  sampleRate: number
  channels: number
  duration: number
  length: number
  /** 每声道 PCM 浮点采样，范围 -1~1 */
  data: Float32Array[]
  peaks: number[][]
}

/* ------------------------------------------------------------------ */
/* 会话与消息                                                          */
/* ------------------------------------------------------------------ */

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ToolCallRecord {
  id: string
  name: string
  /** 原始 JSON 字符串 */
  args: string
  result?: string
  status: 'running' | 'done' | 'error'
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  createdAt: number
  /** 本条回复产出的音频素材 */
  artifactIds?: string[]
  toolCalls?: ToolCallRecord[]
  /** 本次请求显式启用的 skills */
  skillNames?: string[]
  error?: string
}

export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  /** 会话级默认启用的 skills */
  skillNames: string[]
}

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  artifactCount: number
}

/* ------------------------------------------------------------------ */
/* Skills                                                              */
/* ------------------------------------------------------------------ */

export interface SkillMeta {
  /** 目录名，作为唯一 id */
  id: string
  name: string
  description: string
  builtin: boolean
  dir: string
  /** examples 目录下的示例文件名 */
  examples: string[]
  /** 内置目录里是否已存在同名 skill，即该 skill 会随下次打包一起分发 */
  exported: boolean
}

export interface SkillDetail extends SkillMeta {
  instructions: string
}

/* ------------------------------------------------------------------ */
/* IPC 事件负载                                                        */
/* ------------------------------------------------------------------ */

export interface ChatDeltaEvent {
  sessionId: string
  messageId: string
  delta: string
}

export interface ChatMessageEvent {
  sessionId: string
  message: ChatMessage
}

export interface ChatArtifactEvent {
  sessionId: string
  artifact: AudioArtifact
}

export interface ChatStatusEvent {
  sessionId: string
  messageId: string
  /** 当前正在执行的动作，用于界面上的状态提示 */
  label: string
}

export interface ChatDoneEvent {
  sessionId: string
  message: ChatMessage
}

export interface ChatErrorEvent {
  sessionId: string
  messageId: string
  error: string
}

export interface SendChatRequest {
  sessionId: string
  text: string
  /** 本次发送临时启用的 skills */
  skillNames?: string[]
}

export interface ExportRequest {
  title: string
  description?: string
  sampleRate: number
  /** 每声道 PCM */
  channels: Float32Array[]
  originId?: string | null
  sessionId?: string | null
  /** 是否立即弹出保存对话框 */
  promptSave?: boolean
}

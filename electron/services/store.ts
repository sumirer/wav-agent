/**
 * 应用持久化存储。
 *
 * 设计意图：
 * - 元数据（设置 / 会话 / 素材索引）集中在一个 JSON 文件，便于整体备份与调试；
 * - 音频数据单独以 wav 文件存放，避免 JSON 体积膨胀；
 * - 会话消息在流式输出期间只更新内存，回合结束后才落盘，避免逐 token 写文件。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, AudioArtifact, ChatMessage, ChatSession, SessionMeta } from '../../shared/types'

interface StoreData {
  version: number
  settings: AppSettings
  sessions: ChatSession[]
  artifacts: AudioArtifact[]
}

const STORE_VERSION = 1

function defaultSettings(): AppSettings {
  return {
    model: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
      temperature: 0.7,
      maxTokens: 4096
    },
    audioOutputDir: path.join(app.getPath('music'), 'WAV Agent'),
    lastSaveDir: '',
    defaultSampleRate: 44100,
    skillsDir: path.join(app.getPath('userData'), 'skills'),
    systemPromptExtra: '',
    autoRunCodeBlock: true
  }
}

function emptyData(): StoreData {
  return { version: STORE_VERSION, settings: defaultSettings(), sessions: [], artifacts: [] }
}

function createId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${random}`
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

/** 旧版本的素材记录没有 recipe 字段，这里统一补齐，并清掉已废弃的 renderMode */
function normalizeArtifact(raw: unknown): AudioArtifact {
  const artifact = { ...(raw as AudioArtifact & { renderMode?: unknown }) }
  delete artifact.renderMode
  artifact.recipe = artifact.recipe ?? null
  return artifact
}

export class AppStore {
  private readonly baseDir: string
  private readonly dataFile: string
  private readonly artifactsDir: string
  private data: StoreData
  private writeTimer: NodeJS.Timeout | null = null

  constructor() {
    this.baseDir = app.getPath('userData')
    this.dataFile = path.join(this.baseDir, 'data.json')
    this.artifactsDir = path.join(this.baseDir, 'artifacts')
    ensureDir(this.baseDir)
    ensureDir(this.artifactsDir)
    this.data = this.read()
  }

  /* ------------------------------ 基础读写 ------------------------------ */

  private read(): StoreData {
    try {
      if (!fs.existsSync(this.dataFile)) return emptyData()
      const raw = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8')) as Partial<StoreData>
      const fallback = emptyData()
      return {
        version: STORE_VERSION,
        settings: { ...fallback.settings, ...raw.settings, model: { ...fallback.settings.model, ...raw.settings?.model } },
        sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
        artifacts: Array.isArray(raw.artifacts) ? raw.artifacts.map(normalizeArtifact) : []
      }
    } catch (error) {
      console.error('[store] 读取失败，已回退到默认配置:', error)
      return emptyData()
    }
  }

  /** 延时合并写入，避免连续操作产生大量磁盘 IO */
  flush(delay = 120): void {
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.flushNow()
    }, delay)
  }

  flushNow(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    try {
      const tmp = `${this.dataFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
      fs.renameSync(tmp, this.dataFile)
    } catch (error) {
      console.error('[store] 写入失败:', error)
    }
  }

  get artifactsDirectory(): string {
    return this.artifactsDir
  }

  get dataDirectory(): string {
    return this.baseDir
  }

  artifactFilePath(id: string): string {
    return path.join(this.artifactsDir, `${id}.wav`)
  }

  writeArtifactAudio(id: string, wav: Buffer): void {
    ensureDir(this.artifactsDir)
    fs.writeFileSync(this.artifactFilePath(id), wav)
  }

  readArtifactAudio(id: string): Buffer | null {
    const file = this.artifactFilePath(id)
    return fs.existsSync(file) ? fs.readFileSync(file) : null
  }

  /* ------------------------------- 设置 ------------------------------- */

  getSettings(): AppSettings {
    return this.data.settings
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.data.settings = {
      ...this.data.settings,
      ...patch,
      model: { ...this.data.settings.model, ...patch.model }
    }
    this.flush()
    return this.data.settings
  }

  /* ------------------------------- 会话 ------------------------------- */

  private findSession(id: string): ChatSession | undefined {
    return this.data.sessions.find((session) => session.id === id)
  }

  listSessions(): SessionMeta[] {
    return this.data.sessions
      .map((session) => ({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
        artifactCount: this.data.artifacts.filter((item) => item.sessionId === session.id).length
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getSession(id: string): ChatSession | null {
    return this.findSession(id) ?? null
  }

  createSession(title = '新的对话'): ChatSession {
    const now = Date.now()
    const session: ChatSession = {
      id: createId('s'),
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
      skillNames: []
    }
    this.data.sessions.unshift(session)
    this.flush()
    return session
  }

  renameSession(id: string, title: string): void {
    const session = this.findSession(id)
    if (!session) return
    session.title = title.trim() || session.title
    session.updatedAt = Date.now()
    this.flush()
  }

  deleteSession(id: string): void {
    this.data.sessions = this.data.sessions.filter((session) => session.id !== id)
    this.flush()
  }

  setSessionSkills(id: string, skillNames: string[]): void {
    const session = this.findSession(id)
    if (!session) return
    session.skillNames = skillNames
    this.flush()
  }

  addMessage(sessionId: string, message: ChatMessage, options: { touch?: boolean } = {}): void {
    const session = this.findSession(sessionId)
    if (!session) return
    session.messages.push(message)
    if (options.touch !== false) session.updatedAt = Date.now()
    this.flush()
  }

  updateMessage(sessionId: string, messageId: string, patch: Partial<ChatMessage>): ChatMessage | null {
    const session = this.findSession(sessionId)
    if (!session) return null
    const message = session.messages.find((item) => item.id === messageId)
    if (!message) return null
    Object.assign(message, patch)
    session.updatedAt = Date.now()
    return message
  }

  /** 让主进程与渲染层的流式状态保持一致，无需每次落盘 */
  commit(sessionId: string): void {
    const session = this.findSession(sessionId)
    if (session) session.updatedAt = Date.now()
    this.flush()
  }

  /* ------------------------------- 素材 ------------------------------- */

  listArtifacts(): AudioArtifact[] {
    return [...this.data.artifacts].sort((a, b) => b.createdAt - a.createdAt)
  }

  getArtifact(id: string): AudioArtifact | null {
    return this.data.artifacts.find((item) => item.id === id) ?? null
  }

  addArtifact(artifact: AudioArtifact): AudioArtifact {
    this.data.artifacts.unshift(artifact)
    this.flush()
    return artifact
  }

  updateArtifact(id: string, patch: Partial<AudioArtifact>): AudioArtifact | null {
    const artifact = this.getArtifact(id)
    if (!artifact) return null
    Object.assign(artifact, patch)
    this.flush()
    return artifact
  }

  deleteArtifact(id: string): void {
    this.data.artifacts = this.data.artifacts.filter((item) => item.id !== id)
    try {
      const file = this.artifactFilePath(id)
      if (fs.existsSync(file)) fs.unlinkSync(file)
    } catch (error) {
      console.error('[store] 删除音频文件失败:', error)
    }
    this.flush()
  }
}

let instance: AppStore | null = null

/** 必须在 app.whenReady() 之后调用 */
export function getStore(): AppStore {
  if (!instance) instance = new AppStore()
  return instance
}

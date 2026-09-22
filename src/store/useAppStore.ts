/**
 * 全局状态。
 *
 * 主进程是唯一的数据源：所有写操作都通过 IPC 完成，
 * 渲染层只负责乐观展示流式增量，并在收到 done / data:changed 后与主进程对齐。
 */
import { create } from 'zustand'
import type {
  AppSettings,
  AudioArtifact,
  ChatMessage,
  ChatSession,
  ExportRequest,
  SessionMeta,
  SkillMeta
} from '@shared/types'

export interface Toast {
  id: number
  text: string
  tone: 'info' | 'ok' | 'err'
}

export type View = 'chat' | 'settings'
export type SidebarTab = 'sessions' | 'artifacts'

const EMPTY_SETTINGS: AppSettings = {
  model: { baseUrl: '', apiKey: '', model: '', temperature: 0.7, maxTokens: 4096 },
  audioOutputDir: '',
  lastSaveDir: '',
  defaultSampleRate: 44100,
  skillsDir: '',
  systemPromptExtra: '',
  autoRunCodeBlock: true
}

interface AppState {
  ready: boolean
  settings: AppSettings
  sessions: SessionMeta[]
  artifacts: AudioArtifact[]
  skills: SkillMeta[]
  activeSessionId: string | null
  session: ChatSession | null
  messages: ChatMessage[]
  activeArtifactId: string | null
  view: View
  sidebarTab: SidebarTab
  running: boolean
  statusLabel: string
  toasts: Toast[]

  init(): Promise<void>
  refreshSessions(): Promise<void>
  refreshArtifacts(): Promise<void>
  refreshSkills(): Promise<void>
  selectSession(id: string): Promise<void>
  createSession(): Promise<void>
  removeSession(id: string): Promise<void>
  renameSession(id: string, title: string): Promise<void>
  setSessionSkills(skillNames: string[]): Promise<void>
  send(text: string, skillNames: string[]): Promise<void>
  abort(): Promise<void>
  saveArtifact(id: string): Promise<void>
  removeArtifact(id: string): Promise<void>
  exportArtifact(req: ExportRequest): Promise<AudioArtifact | null>
  importArtifacts(): Promise<void>
  setActiveArtifact(id: string | null): void
  setView(view: View): void
  setSidebarTab(tab: SidebarTab): void
  updateSettings(patch: Partial<AppSettings>): Promise<void>
  pushToast(text: string, tone?: Toast['tone']): void
  dismissToast(id: number): void
}

let toastSeed = 0
let initialized = false

export const useAppStore = create<AppState>()((set, get) => ({
  ready: false,
  settings: EMPTY_SETTINGS,
  sessions: [],
  artifacts: [],
  skills: [],
  activeSessionId: null,
  session: null,
  messages: [],
  activeArtifactId: null,
  view: 'chat',
  sidebarTab: 'sessions',
  running: false,
  statusLabel: '',
  toasts: [],

  async init() {
    // StrictMode 下 effect 会执行两次，这里保证事件订阅只注册一次
    if (initialized) return
    initialized = true
    const [settings, sessions, artifacts, skills] = await Promise.all([
      window.api.settings.get(),
      window.api.sessions.list(),
      window.api.artifacts.list(),
      window.api.skills.list()
    ])
    set({ settings, sessions, artifacts, skills })

    // 恢复上次的会话；没有则新建一个
    const first = sessions[0]
    if (first) {
      await get().selectSession(first.id)
    } else {
      await get().createSession()
    }

    window.api.system.on('chat:message', ({ sessionId, message }) => {
      if (sessionId !== get().activeSessionId) return
      set((state) => ({
        messages: state.messages.some((item) => item.id === message.id)
          ? state.messages.map((item) => (item.id === message.id ? message : item))
          : [...state.messages, message]
      }))
    })

    window.api.system.on('chat:delta', ({ sessionId, messageId, delta }) => {
      if (sessionId !== get().activeSessionId) return
      set((state) => ({
        messages: state.messages.map((item) =>
          item.id === messageId ? { ...item, content: item.content + delta } : item
        )
      }))
    })

    window.api.system.on('chat:status', ({ sessionId, label }) => {
      if (sessionId !== get().activeSessionId) return
      set({ statusLabel: label })
    })

    window.api.system.on('chat:artifact', ({ sessionId, artifact }) => {
      set((state) => ({
        artifacts: state.artifacts.some((item) => item.id === artifact.id)
          ? state.artifacts
          : [artifact, ...state.artifacts]
      }))
      if (sessionId === get().activeSessionId) set({ sidebarTab: 'artifacts' })
    })

    window.api.system.on('chat:done', ({ sessionId, message }) => {
      if (sessionId === get().activeSessionId) {
        set((state) => ({
          messages: state.messages.map((item) => (item.id === message.id ? message : item)),
          running: false,
          statusLabel: ''
        }))
      }
      void get().refreshSessions()
    })

    window.api.system.on('chat:error', ({ sessionId, messageId, error }) => {
      if (sessionId !== get().activeSessionId) return
      set((state) => ({
        messages: state.messages.map((item) => (item.id === messageId ? { ...item, error } : item))
      }))
    })

    window.api.system.on('data:changed', ({ scope }) => {
      if (scope === 'sessions') void get().refreshSessions()
      else if (scope === 'artifacts') void get().refreshArtifacts()
      else if (scope === 'skills') void get().refreshSkills()
      else if (scope === 'settings') void window.api.settings.get().then((next) => set({ settings: next }))
    })

    set({ ready: true })
  },

  async refreshSessions() {
    set({ sessions: await window.api.sessions.list() })
  },

  async refreshArtifacts() {
    set({ artifacts: await window.api.artifacts.list() })
  },

  async refreshSkills() {
    set({ skills: await window.api.skills.list() })
  },

  async selectSession(id) {
    const session = await window.api.sessions.get(id)
    if (!session) return
    set({ activeSessionId: id, session, messages: session.messages, view: 'chat' })
  },

  async createSession() {
    const session = await window.api.sessions.create()
    set((state) => ({
      sessions: [
        { id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, messageCount: 0, artifactCount: 0 },
        ...state.sessions
      ],
      activeSessionId: session.id,
      session,
      messages: [],
      view: 'chat'
    }))
  },

  async removeSession(id) {
    await window.api.sessions.remove(id)
    const remaining = get().sessions.filter((item) => item.id !== id)
    set({ sessions: remaining })
    if (get().activeSessionId === id) {
      if (remaining[0]) await get().selectSession(remaining[0].id)
      else await get().createSession()
    }
  },

  async renameSession(id, title) {
    await window.api.sessions.rename(id, title)
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === id ? { ...item, title } : item)),
      session: state.session && state.session.id === id ? { ...state.session, title } : state.session
    }))
  },

  async setSessionSkills(skillNames) {
    const id = get().activeSessionId
    if (!id) return
    await window.api.sessions.setSkills(id, skillNames)
    set((state) => ({ session: state.session ? { ...state.session, skillNames } : state.session }))
  },

  async send(text, skillNames) {
    const sessionId = get().activeSessionId
    if (!sessionId || !text.trim() || get().running) return
    set({ running: true, statusLabel: '正在发送…' })
    try {
      await window.api.chat.send({ sessionId, text: text.trim(), skillNames })
    } catch (error) {
      set({ running: false, statusLabel: '' })
      get().pushToast(error instanceof Error ? error.message : String(error), 'err')
    }
  },

  async abort() {
    const sessionId = get().activeSessionId
    if (!sessionId) return
    await window.api.chat.abort(sessionId)
    set({ running: false, statusLabel: '' })
  },

  async saveArtifact(id) {
    const target = await window.api.artifacts.saveToDisk(id)
    if (target) {
      await get().refreshArtifacts()
      get().pushToast(`已保存到 ${target}`, 'ok')
    }
  },

  async removeArtifact(id) {
    await window.api.artifacts.remove(id)
    if (get().activeArtifactId === id) set({ activeArtifactId: null })
    await get().refreshArtifacts()
  },

  async exportArtifact(req) {
    const artifact = await window.api.artifacts.export(req)
    await get().refreshArtifacts()
    if (artifact?.savedPath) get().pushToast(`已另存为 ${artifact.savedPath}`, 'ok')
    return artifact
  },

  async importArtifacts() {
    const created = await window.api.artifacts.importFiles()
    if (created.length === 0) return
    await get().refreshArtifacts()
    get().pushToast(`已导入 ${created.length} 个音频文件`, 'ok')
  },

  setActiveArtifact(id) {
    set({ activeArtifactId: id })
  },

  setView(view) {
    set({ view })
  },

  setSidebarTab(tab) {
    set({ sidebarTab: tab })
  },

  async updateSettings(patch) {
    const next = await window.api.settings.update(patch)
    set({ settings: next })
  },

  pushToast(text, tone = 'info') {
    toastSeed += 1
    const id = toastSeed
    set((state) => ({ toasts: [...state.toasts, { id, text, tone }] }))
    setTimeout(() => get().dismissToast(id), tone === 'err' ? 6000 : 3600)
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }))
  }
}))

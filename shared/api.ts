import type {
  AppSettings,
  AudioArtifact,
  AudioPayload,
  ChatDeltaEvent,
  ChatArtifactEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatMessageEvent,
  ChatSession,
  ChatStatusEvent,
  ExportRequest,
  SendChatRequest,
  SessionMeta,
  SkillDetail,
  SkillMeta
} from './types'

/** 渲染层可订阅的主进程事件 */
export interface WavAgentEvents {
  'chat:delta': ChatDeltaEvent
  'chat:message': ChatMessageEvent
  'chat:artifact': ChatArtifactEvent
  'chat:status': ChatStatusEvent
  'chat:done': ChatDoneEvent
  'chat:error': ChatErrorEvent
  /** 会话列表/素材列表发生变化的统一通知 */
  'data:changed': { scope: 'sessions' | 'artifacts' | 'settings' | 'skills' }
}

export interface WavAgentApi {
  settings: {
    get(): Promise<AppSettings>
    update(patch: Partial<AppSettings>): Promise<AppSettings>
    /** 打开系统目录选择框 */
    pickDirectory(title?: string, defaultPath?: string): Promise<string | null>
  }
  sessions: {
    list(): Promise<SessionMeta[]>
    get(id: string): Promise<ChatSession | null>
    create(title?: string): Promise<ChatSession>
    rename(id: string, title: string): Promise<void>
    remove(id: string): Promise<void>
    setSkills(id: string, skillNames: string[]): Promise<void>
  }
  chat: {
    send(req: SendChatRequest): Promise<void>
    abort(sessionId: string): Promise<void>
    /** 仅用于测试连通性 */
    ping(): Promise<{ ok: boolean; message: string; models?: string[] }>
  }
  artifacts: {
    list(): Promise<AudioArtifact[]>
    get(id: string): Promise<AudioArtifact | null>
    /** 读取完整 PCM 数据，用于播放与编辑 */
    read(id: string): Promise<AudioPayload | null>
    /** 弹出保存对话框把素材写到用户选择的路径 */
    saveToDisk(id: string, targetPath?: string): Promise<string | null>
    /** 导入外部 wav 文件 */
    importFiles(): Promise<AudioArtifact[]>
    remove(id: string): Promise<void>
    /** 把编辑后的波形另存为新素材 */
    export(req: ExportRequest): Promise<AudioArtifact | null>
    revealInFolder(targetPath: string): Promise<void>
  }
  skills: {
    list(): Promise<SkillMeta[]>
    get(id: string): Promise<SkillDetail | null>
    /** 从磁盘目录导入一个 skill */
    addFromFolder(): Promise<SkillMeta | null>
    /** 把自定义 skill 复制到随包分发的内置目录，下次打包即成为默认 skill */
    exportToBuiltin(id: string): Promise<SkillMeta>
    remove(id: string): Promise<void>
    openFolder(): Promise<void>
    reload(): Promise<SkillMeta[]>
  }
  system: {
    openPath(targetPath: string): Promise<void>
    copyText(text: string): Promise<void>
    on<K extends keyof WavAgentEvents>(channel: K, listener: (payload: WavAgentEvents[K]) => void): () => void
  }
}

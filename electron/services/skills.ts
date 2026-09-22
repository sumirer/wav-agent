/**
 * Skills 注册表。
 *
 * 一个 skill 就是一个目录：
 *   <skill-dir>/SKILL.md         带 YAML frontmatter（name / description）的说明文档
 *   <skill-dir>/examples/*.json  可选的合成规格示例，供模型模仿
 *
 * 目录分两级：
 * - 内置目录：随安装包分发（源码仓库的 skills/），只读，是「默认 skill」的来源；
 * - 自定义目录：设置里 skillsDir 指定的固定目录，应用启动时自动扫描，
 *   Agent 通过 save_skill 创建的新 skill 也写入这里，可通过 exportToBuiltin 固化为内置。
 *
 * 两级目录中 id 相同时，自定义覆盖内置，便于用户在局部改写内置 skill 的行为。
 */
import { app, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { SkillDetail, SkillMeta } from '../../shared/types'
import { getStore } from './store'

interface ParsedSkill {
  meta: SkillMeta
  instructions: string
}

/** Agent / 界面提交的新 skill 内容 */
export interface SkillInput {
  id: string
  name: string
  description?: string
  instructions: string
  examples?: { name: string; spec: unknown }[]
}

/** 极简 frontmatter 解析：只支持 `key: value` 的平坦结构，够用且不引依赖 */
function parseSkillFile(raw: string, fallbackName: string): { name: string; description: string; instructions: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!frontmatter) {
    return { name: fallbackName, description: '', instructions: raw.trim() }
  }
  const fields: Record<string, string> = {}
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (match) fields[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
  }
  return {
    name: fields.name || fallbackName,
    description: fields.description || '',
    instructions: raw.slice(frontmatter[0].length).trim()
  }
}

function readDirEntries(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/** 目录名即 skill id：只保留字母、数字、中文与短横线，避免写出非法或含歧义的目录名 */
export function sanitizeSkillId(raw: string): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 60)
    .replace(/[-_]+$/g, '')
}

/** 把 frontmatter 值压成单行，避免写出非法的 YAML */
function singleLine(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function renderSkillDoc(input: SkillInput): string {
  const name = singleLine(input.name) || input.id
  const description = singleLine(input.description ?? '')
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${String(input.instructions).trim()}\n`
}

export class SkillRegistry {
  private cache: Map<string, ParsedSkill> = new Map()

  /**
   * 随包分发的内置目录。
   * 开发态以仓库的 skills/ 为准；打包后 process.cwd() 可能是任意目录（例如从快捷方式启动时是 system32），
   * 因此打包态只认 asar 解包目录与 app 目录，避免误加载外部同名目录。
   */
  get builtinDir(): string {
    const candidates = app.isPackaged
      ? [
          path.join(process.resourcesPath ?? '', 'app.asar.unpacked', 'skills'),
          path.join(app.getAppPath(), 'skills'),
          path.join(process.resourcesPath ?? '', 'skills')
        ]
      : [path.join(process.cwd(), 'skills'), path.join(app.getAppPath(), 'skills')]
    return candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0]
  }

  /** 自定义 skill 的固定目录，可在设置中修改 */
  get customDir(): string {
    const configured = getStore().getSettings().skillsDir?.trim()
    const dir = configured || path.join(app.getPath('userData'), 'skills')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  private loadDir(dir: string, builtin: boolean, into: Map<string, ParsedSkill>): void {
    for (const entry of readDirEntries(dir)) {
      const skillDir = path.join(dir, entry)
      const docPath = path.join(skillDir, 'SKILL.md')
      if (!fs.existsSync(docPath)) continue
      try {
        const parsed = parseSkillFile(fs.readFileSync(docPath, 'utf-8'), entry)
        let examples: string[] = []
        try {
          examples = fs.readdirSync(path.join(skillDir, 'examples')).filter((file) => file.endsWith('.json'))
        } catch {
          examples = []
        }
        into.set(entry, {
          meta: {
            id: entry,
            name: parsed.name,
            description: parsed.description,
            builtin,
            dir: skillDir,
            examples,
            // 先占位，reload() 里统一按内置目录实际情况回填
            exported: builtin
          },
          instructions: parsed.instructions
        })
      } catch (error) {
        console.error(`[skills] 解析 ${docPath} 失败:`, error)
      }
    }
  }

  reload(): SkillMeta[] {
    const merged = new Map<string, ParsedSkill>()
    const builtinDir = this.builtinDir
    this.loadDir(builtinDir, true, merged)
    const custom = this.customDir
    // 自定义目录等于内置目录时只扫一次，避免重复
    if (path.resolve(custom) !== path.resolve(builtinDir)) {
      this.loadDir(custom, false, merged)
    }
    // 回填「是否已进入内置目录」，让用户知道哪些自定义 skill 会随打包分发
    for (const item of merged.values()) {
      item.meta.exported = fs.existsSync(path.join(builtinDir, item.meta.id))
    }
    this.cache = merged
    return this.list()
  }

  private ensure(): Map<string, ParsedSkill> {
    if (this.cache.size === 0) this.reload()
    return this.cache
  }

  list(): SkillMeta[] {
    return [...this.ensure().values()]
      .map((item) => item.meta)
      .sort((a, b) => {
        // 自定义 skill 排在前面，用户刚创建的能被立刻看到
        if (a.builtin !== b.builtin) return a.builtin ? 1 : -1
        return a.name.localeCompare(b.name, 'zh-Hans-CN')
      })
  }

  get(id: string): SkillDetail | null {
    const found = this.ensure().get(id)
    return found ? { ...found.meta, instructions: found.instructions } : null
  }

  /** 读取某个示例规格，供模型参考 */
  readExample(id: string, fileName: string): string | null {
    const found = this.cache.get(id)
    if (!found || !found.meta.examples.includes(fileName)) return null
    try {
      return fs.readFileSync(path.join(found.meta.dir, 'examples', fileName), 'utf-8')
    } catch {
      return null
    }
  }

  /**
   * 创建或覆盖一个自定义 skill。
   * 内置 skill 不允许被覆盖，避免用户无意中破坏默认能力。
   */
  saveSkill(input: SkillInput): SkillDetail {
    this.ensure()
    const id = sanitizeSkillId(input.id || input.name)
    if (!id) throw new Error('skill id 不合法，请使用中英文、数字、短横线')
    const instructions = String(input.instructions ?? '').trim()
    if (instructions.length < 20) throw new Error('instructions 内容过短，请写出完整的方法论与参数建议')

    const existing = this.cache.get(id)
    if (existing?.meta.builtin) {
      throw new Error(`「${id}」是内置 skill，不能被覆盖；请换一个 id，或改用在自定义目录里新建同 id 的版本来覆盖它`)
    }

    const targetDir = path.join(this.customDir, id)
    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(path.join(targetDir, 'SKILL.md'), renderSkillDoc({ ...input, id }), 'utf-8')

    // 清掉旧示例，避免覆盖后残留上一次的文件
    const examplesDir = path.join(targetDir, 'examples')
    if (fs.existsSync(examplesDir)) fs.rmSync(examplesDir, { recursive: true, force: true })

    const examples = (input.examples ?? []).filter((item) => item && item.spec).slice(0, 5)
    if (examples.length > 0) {
      fs.mkdirSync(examplesDir, { recursive: true })
      examples.forEach((example, index) => {
        const safeName = sanitizeSkillId(example.name) || `example-${index + 1}`
        fs.writeFileSync(path.join(examplesDir, `${safeName}.json`), JSON.stringify(example.spec, null, 2), 'utf-8')
      })
    }

    this.reload()
    const saved = this.get(id)
    if (!saved) throw new Error('skill 写入后无法读取，请检查目录权限')
    return saved
  }

  /** 把自定义 skill 复制到内置目录，使其成为随包分发的默认 skill */
  exportToBuiltin(id: string): SkillMeta {
    const found = this.ensure().get(id)
    if (!found) throw new Error(`未找到 skill「${id}」`)
    if (found.meta.builtin) return found.meta
    if (app.isPackaged) {
      throw new Error('当前是打包运行环境，内置目录只读；请在源码仓库中导出后重新打包')
    }
    const target = path.join(this.builtinDir, id)
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
    fs.cpSync(found.meta.dir, target, { recursive: true })
    this.reload()
    const exported = this.get(id)
    if (!exported) throw new Error('导出后无法读取该 skill')
    return exported
  }

  /** 弹出目录选择框，把外部目录复制成自定义 skill */
  async addFromFolder(): Promise<SkillMeta | null> {
    const result = await dialog.showOpenDialog({
      title: '选择包含 SKILL.md 的目录',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const source = result.filePaths[0]
    if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
      throw new Error('所选目录下没有 SKILL.md')
    }
    const id = sanitizeSkillId(path.basename(source))
    const target = path.join(this.customDir, id)
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
    fs.cpSync(source, target, { recursive: true })
    this.reload()
    return this.get(id)
  }

  remove(id: string): void {
    const found = this.ensure().get(id)
    if (!found) return
    if (found.meta.builtin) throw new Error('内置 skill 不能删除')
    fs.rmSync(found.meta.dir, { recursive: true, force: true })
    this.reload()
  }
}

let instance: SkillRegistry | null = null

/** 必须在 app.whenReady() 之后调用 */
export function getSkillRegistry(): SkillRegistry {
  if (!instance) instance = new SkillRegistry()
  return instance
}

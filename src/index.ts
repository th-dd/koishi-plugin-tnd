import { Context, Schema, h } from 'koishi'
import { setTimeout as sleep } from 'timers/promises'
import { TndApi, TndError } from './api'
import type { BookItem, Job, Preview, TndConfig } from './types'
import {
  formatBytes,
  imageElement,
  markdownResult,
  previewText,
  qqMarkdownMessage,
  quickReplies,
  renderPreviewImage,
  renderSearchImage,
  responseMode,
  sendLong,
  textResult,
} from './render'
import { friendlySendError, sendNovelFile } from './transfer'

export const name = 'novel-downloader'
// puppeteer 是可选依赖：装了就能出图，没装自动降级为文字。
// 这里不 declare module 覆盖 Context.puppeteer，避免和 koishi-plugin-puppeteer 的类型冲突。
export const inject = { required: [], optional: ['puppeteer'] }

export interface Config extends TndConfig {}

export const Config: Schema<Config> = Schema.object({
  apiBase: Schema.string().required().description('TND 服务地址，如 https://tnd.th-dd.top'),
  apiPassword: Schema.string().description('TND 服务密码锁密码，服务未加锁时留空'),
  maxSearchResults: Schema.number().default(20).min(1).max(50).description('搜索结果最大显示数量'),
  initialWait: Schema.number().default(8000).description('创建任务后首次轮询前的等待时间 (毫秒)'),
  pollInterval: Schema.number().default(5000).description('任务进度轮询间隔 (毫秒)'),
  jobTimeout: Schema.number().default(600000).description('单个任务最长等待时间 (毫秒)'),
  fileSendMaxRetries: Schema.number().default(3).min(1).description('文件发送失败最大重试次数'),
  transferMode: Schema.union([
    Schema.const('auto').description('有密码锁时走临时文件，否则直接传下载直链'),
    Schema.const('url').description('把 TND 下载直链交给适配器自行下载（省流量）'),
    Schema.const('file').description('先下载到临时文件再上传（兼容性最好）'),
    Schema.const('base64').description('转成 base64:// 交给适配器（大文件吃内存）'),
  ] as const).default('auto').description('文件传输方式'),
  cleanupJob: Schema.boolean().default(true).description('下载完成后删除服务端任务记录（文件保留）'),
  quickDownload: Schema.boolean().default(true).description('搜索后直接回复数字即可下载'),
  cooldown: Schema.number().default(15).description('同一用户两条下载命令的最小间隔 (秒)，0 关闭'),
  maxConcurrentJobs: Schema.number().default(3).min(1).description('全局同时进行的下载任务上限'),
  maxTextLength: Schema.number().default(1800).min(200).description('单条消息最大字符数'),
  enableImage: Schema.boolean().default(false).description('将搜索结果渲染为图片（需要 koishi-plugin-puppeteer）'),
  imageWidth: Schema.number().default(800).description('图片宽度'),
  debug: Schema.boolean().default(false).description('开启调试日志'),
})

const CACHE_TTL = 10 * 60 * 1000
const CACHE_LIMIT = 200
const PROGRESS_NOTIFY_INTERVAL = 10_000
const FILE_EXT = ['txt', 'epub', 'pdf', 'zip']

export function apply(ctx: Context, config: Config) {
  const api = new TndApi(ctx, config)
  const searchCache = new Map<string, { items: BookItem[]; at: number }>()
  const previewCache = new Map<string, { preview: Preview; at: number }>()
  const lastUsed = new Map<string, number>()
  const perUserJobs = new Map<string, number>()
  // 用户 -> 正在跑的任务，供 tnd 取消 使用
  const activeJobs = new Map<string, { id: number; cancelled: boolean }>()
  let runningJobs = 0

  // 便于在日志里确认插件只加载了一份、指向哪个服务
  ctx.logger.info('novel-downloader 已加载 → %s', api.base)

  // 容器默认只输出 INFO 及以上，调试开关必须走 info 才看得见
  const debug = (...args: any[]) => {
    if (config.debug) ctx.logger.info('[tnd]', ...args)
  }

  function cacheSet<T>(map: Map<string, { at: number } & T>, key: string, value: T) {
    map.delete(key)
    map.set(key, { ...value, at: Date.now() })
    while (map.size > CACHE_LIMIT) map.delete(map.keys().next().value!)
  }

  function cacheGet<T>(map: Map<string, { at: number } & T>, key: string): T | null {
    const hit = map.get(key)
    if (!hit) return null
    if (Date.now() - hit.at > CACHE_TTL) {
      map.delete(key)
      return null
    }
    return hit
  }

  async function searchBooks(keyword: string) {
    const items = await api.search(keyword)
    return items.filter((item) => item.book_id && item.title)
  }

  async function getPreview(bookId: string) {
    const cached = cacheGet(previewCache, bookId)
    if (cached) return cached.preview
    const preview = await api.preview(bookId)
    cacheSet(previewCache, bookId, { preview })
    return preview
  }

  /** 论证 target：纯数字且超过 15 位视为 book_id，否则当搜索序号。 */
  async function resolveTarget(session: any, target: string): Promise<BookItem | Preview> {
    if (/^\d{16,}$/.test(target)) return getPreview(target)
    const cached = cacheGet(searchCache, String(session?.userId || 'global'))
    if (!cached?.items?.length) throw new TndError('未找到搜索结果，请先使用 tnd 搜索')
    const index = parseInt(target, 10)
    if (!Number.isFinite(index) || index < 1 || index > cached.items.length) {
      throw new TndError(`序号无效，请输入 1-${cached.items.length}`)
    }
    return cached.items[index - 1]
  }

  function parseRange(text?: string, total?: number): { start: number; end: number } | null {
    if (!text) return null
    const [rawStart, rawEnd] = text.split('-').map((part) => part.trim())
    const start = rawStart === '' || rawStart === undefined ? 1 : parseInt(rawStart, 10)
    const end = rawEnd === '' || rawEnd === undefined ? (total || 0) : parseInt(rawEnd, 10)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
      throw new TndError(`章节范围无效：${text}（示例 1-50）`)
    }
    if (total && end > total) throw new TndError(`章节范围超出总数 ${total}`)
    return { start, end }
  }

  function guardCooldown(userId: string) {
    if (!config.cooldown) return
    const last = lastUsed.get(userId) || 0
    const wait = config.cooldown * 1000 - (Date.now() - last)
    if (wait > 0) throw new TndError(`操作太快，请 ${Math.ceil(wait / 1000)} 秒后再试`)
  }

  function progressLine(job: Job) {
    const saved = job.progress?.saved_chapters || 0
    const total = job.progress?.chapter_total || 0
    const pct = total ? Math.round((saved / total) * 100) : 0
    return `📥 正在下载「${job.title || job.book_id}」：${saved}/${total} 章（${pct}%）`
  }

  /** 分片睡眠，期间盯着取消标记。 */
  async function sleepInterruptible(ms: number, userId: string) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (activeJobs.get(userId)?.cancelled) return
      await sleep(Math.min(250, Math.max(end - Date.now(), 0)))
    }
  }

  /** 轮询任务直到结束；返回最终 Job。 */
  async function waitForJob(session: any, userId: string, jobId: number, options: { format?: string; name?: string }) {
    const deadline = Date.now() + config.jobTimeout
    let lastNotify = Date.now()
    let lastSaved = -1
    let lastState = ''
    let nameChosen = false
    let formatChosen = false

    await sleepInterruptible(Math.max(config.initialWait, 0), userId)

    while (Date.now() < deadline) {
      if (activeJobs.get(userId)?.cancelled) throw new TndError('下载已取消')
      let job: Job | undefined
      try {
        job = await api.findJob(jobId)
      } catch (e: any) {
        debug('轮询失败: %s', e.message)
      }
      if (!job) {
        await sleep(config.pollInterval)
        continue
      }

      // 服务端要求人工选择书名/格式时自动应答
      const nameOptions = job.book_name_options || []
      if (nameOptions.length && !nameChosen) {
        const picked = nameOptions.find((option) => option.value === options.name || option.label === options.name) || nameOptions[0]
        await api.chooseBookName(jobId, picked.value).catch((e) => debug('选择书名失败: %s', e.message))
        nameChosen = true
      }
      const formatOptions = job.format_options || []
      if (formatOptions.length && !formatChosen) {
        const wanted = options.format?.toLowerCase()
        const picked = formatOptions.find((option) => option.value === wanted || option.label === wanted) || formatOptions[0]
        await api.chooseFormat(jobId, picked.value).catch((e) => debug('选择格式失败: %s', e.message))
        formatChosen = true
      }

      const state = String(job.state || '')
      if (state !== lastState) {
        debug('任务 %d 状态: %s', jobId, state)
        lastState = state
      }
      if (state === 'done') return job
      if (state === 'failed') throw new TndError(job.message || '服务端下载失败')
      if (state === 'canceled') throw new TndError('任务已被取消')

      const saved = job.progress?.saved_chapters || 0
      if (saved !== lastSaved && Date.now() - lastNotify > PROGRESS_NOTIFY_INTERVAL) {
        lastSaved = saved
        lastNotify = Date.now()
        await session.send(progressLine(job)).catch(() => {})
      }
      await sleepInterruptible(config.pollInterval, userId)
    }

    await api.cancelJob(jobId).catch(() => {})
    throw new TndError(`等待超时（${Math.round(config.jobTimeout / 1000)} 秒），任务 ${jobId} 已取消`)
  }

  /** 在服务端目录里找刚生成的文件（文件名/扩展名/时间三重匹配）。 */
  async function locateOutput(job: Job, title: string): Promise<{ rel: string; name: string; dir?: boolean; size?: number }> {
    const titles = [title, job.title, job.book_id].filter(Boolean).map((value) => String(value))
    let rootPath = ''
    try {
      const [full, status] = await Promise.all([api.fullConfig(), api.status()])
      const savePath = (full?.save_path || '').replace(/\/+$/, '')
      const saveDir = (status?.save_dir || '').replace(/\/+$/, '')
      if (savePath && saveDir && savePath.startsWith(saveDir + '/')) rootPath = savePath.slice(saveDir.length + 1)
      else if (savePath) rootPath = savePath.replace(/^\/+/, '')
    } catch { /* 无权限时按根目录找 */ }

    const deadline = Date.now() + 90_000
    let scanned = false
    while (Date.now() < deadline) {
      let items = [] as Awaited<ReturnType<typeof api.library>>
      try {
        items = await api.library(rootPath, !scanned)
        scanned = true
      } catch (e: any) {
        debug('读取目录失败: %s', e.message)
      }
      const created = (job.created_ms || 0) - 5000
      const matched = items.find((item) => {
        if (item.kind !== 'file' && item.kind !== 'dir') return false
        const ext = (item.name.split('.').pop() || '').toLowerCase()
        if (item.kind === 'file' && !FILE_EXT.includes(ext)) return false
        if (created && (item.modified_ms || 0) < created) return false
        return titles.some((title) => item.name.startsWith(title))
      })
      if (matched) return { rel: matched.rel_path, name: matched.name, dir: matched.kind === 'dir', size: matched.size }
      await sleep(3000)
    }
    throw new TndError('任务已完成，但没在服务端目录里找到生成的文件')
  }

  const tnd = ctx.command('tnd', '番茄小说下载器')
    .usage([
      '用法：',
      '  tnd 搜索 斗破苍穹      搜索小说',
      '  tnd 预览 1             看简介再决定',
      '  tnd 下载 1             下载第 1 个结果',
      '  tnd 下载 1 --range 1-50  只下前 50 章',
      '  tnd 取消               取消当前下载',
      '',
      '搜索后直接回数字 1-20 也能下载。',
    ].join('\n'))

  // ========== 搜索 ==========
  const searchCmd = tnd.subcommand('.搜索 <keyword:text>', '搜索小说')
  searchCmd.alias('.search')
  searchCmd.usage('用法：tnd 搜索 斗破苍穹')
  searchCmd.example('tnd 搜索 斗破苍穹')
  searchCmd.action(async ({ session }, keyword) => {
    if (!keyword?.trim()) return '用法：tnd 搜索 小说名'
    const userId = String(session?.userId || 'global')
    try {
      const items = await searchBooks(keyword.trim())
      if (!items.length) return '没有找到相关小说。'
      cacheSet(searchCache, userId, { items })

      if (responseMode(session) === 'onebot' || responseMode(session) === 'unknown') {
        const image = await renderSearchImage(ctx, keyword, items, config)
        if (image) return imageElement(image)
        await sendLong(session, textResult(items, keyword, config.maxSearchResults), config.maxTextLength)
        return
      }
      if (responseMode(session) === 'qq') {
        const image = await renderSearchImage(ctx, keyword, items, config)
        if (image) return imageElement(image)
        const rows = quickReplies(items, config.maxSearchResults)
        return qqMarkdownMessage(markdownResult(items, keyword, config.maxSearchResults), rows)
      }
      const image = await renderSearchImage(ctx, keyword, items, config)
      if (image) return imageElement(image)
      if (responseMode(session) === 'telegram') {
        return h('message', { type: 'markdown' }, markdownResult(items, keyword, config.maxSearchResults))
      }
      return textResult(items, keyword, config.maxSearchResults)
    } catch (e: any) {
      ctx.logger.warn('搜索失败: %s', e.message)
      return `搜索失败: ${e.message}`
    }
  })

  // ========== 预览 ==========
  const previewCmd = tnd.subcommand('.预览 <target>', '预览小说信息')
  previewCmd.alias('.preview')
  previewCmd.usage('用法：tnd 预览 1（序号来自上一次搜索）')
  previewCmd.example('tnd 预览 1')
  previewCmd.action(async ({ session }, target) => {
    if (!target) return '用法：tnd 预览 <序号|book_id>'
    try {
      const book = await resolveTarget(session, target)
      const preview = 'book_name' in book ? book : await getPreview(book.book_id)
      const image = await renderPreviewImage(ctx, preview, config.imageWidth)
      if (image) return imageElement(image)
      const text = previewText(preview)
      await sendLong(session, text, config.maxTextLength)
    } catch (e: any) {
      return `预览失败: ${e.message}`
    }
  })

  // ========== 下载 ==========
  async function runDownload(session: any, target: string, options: any = {}) {
    if (!target) return '用法：tnd 下载 序号 [--range 1-50]'
    const userId = String(session?.userId || 'global')

    try {
      guardCooldown(userId)
      if (runningJobs >= config.maxConcurrentJobs) throw new TndError('当前下载任务已满，请稍后再试')
      if ((perUserJobs.get(userId) || 0) >= 1) throw new TndError('你已有下载任务在进行中')

      const resolved = await resolveTarget(session, target)
      const preview = 'book_name' in resolved ? resolved : null
      const book: BookItem = preview
        ? { book_id: preview.book_id, title: preview.book_name, author: preview.author }
        : (resolved as BookItem)

      const range = parseRange(options?.range, preview?.chapter_count)
      const job = await api.createJob(book.book_id, range || undefined)
      lastUsed.set(userId, Date.now())
      perUserJobs.set(userId, 1)
      activeJobs.set(userId, { id: job.id, cancelled: false })
      runningJobs++

      try {
        await session?.send(`📥 已创建任务 #${job.id}：${book.title}${range ? `（第 ${range.start}-${range.end} 章）` : ''}，开始下载...`)
        const finished = await waitForJob(session, userId, job.id, { format: options?.format, name: options?.name })
        const saved = finished.progress?.saved_chapters || 0
        const total = finished.progress?.chapter_total || 0
        if (total && saved < total) {
          await session?.send(`⚠️ 有 ${total - saved} 章失败，继续发送已下载的 ${saved} 章`).catch(() => {})
        }
        const output = await locateOutput(finished, book.title)
        const extension = output.dir ? 'zip' : (output.name.split('.').pop() || 'txt')
        let fileName = options?.name || output.name
        if (!fileName.toLowerCase().endsWith('.' + extension)) fileName += '.' + extension
        const sizeText = formatBytes(output.size)
        await session?.send(`✅ 下载完成：${output.name}（${sizeText}），正在发送${output.dir ? '压缩包' : '文件'}...`).catch(() => {})
        let message: any
        try {
          const result = await sendNovelFile(ctx, session, api, output.rel, fileName, config, { zipped: output.dir, sizeText })
          if (typeof result === 'string') message = result
          else {
            // 非 OneBot 适配器由我们自己发送，才能捕获「没权限发文件」这类错误。
            // 注意 session.send 会吞异常（只打 warn），必须直接调 bot.sendMessage。
            await session.bot.sendMessage(session.channelId, h.normalize(result), session.event?.referrer, { session })
            message = `✅ 文件「${fileName}」已发送（大小 ${sizeText}）`
          }
        } catch (e: any) {
          const hint = friendlySendError(e)
          const link = output.dir ? api.zipUrl(output.rel) : api.downloadUrl(output.rel)
          ctx.logger.warn('文件发送失败 %s: %s', fileName, e.message)
          return [
            `❌ 文件「${fileName}」发送失败${hint ? '：' + hint + '。' : '。'}`,
            `文件已生成在服务器，可点这里手动下载：${link}`,
            `（原始错误：${e.message}）`,
          ].join('\n')
        }
        if (config.cleanupJob) api.deleteJob(job.id).catch((e) => ctx.logger.warn('清理任务 %d 失败: %s', job.id, e.message))
        return message
      } finally {
        const active = activeJobs.get(userId)
        if (active?.id === job.id) activeJobs.delete(userId)
        runningJobs = Math.max(runningJobs - 1, 0)
        perUserJobs.delete(userId)
      }
    } catch (e: any) {
      if (e instanceof TndError) return e.message === '下载已取消' ? '' : e.message
      ctx.logger.warn('下载失败: %s', e.message)
      return `下载失败: ${e.message}`
    }
  }

  const downloadCmd = tnd.subcommand('.下载 <target>', '下载小说')
    .option('format', '-f <format:string> 输出格式（txt/epub/pdf），服务端要求选择时生效')
    .option('range', '-r <range:string> 章节范围，如 1-50')
    .option('name', '-n <name:string> 指定文件名')
  downloadCmd.alias('.download')
  downloadCmd.usage('用法：tnd 下载 1（序号来自上一次搜索）')
  downloadCmd.example('tnd 下载 1 --range 1-50')
  downloadCmd.action(({ session, options }, target) => runDownload(session, target, options))

  const cancelCmd = tnd.subcommand('.取消', '取消当前下载')
  cancelCmd.alias('.cancel')
  cancelCmd.usage('用法：tnd 取消（取消自己正在进行的下载）')
  cancelCmd.example('tnd 取消')
  cancelCmd.action(async ({ session }) => {
    const userId = String(session?.userId || 'global')
    const active = activeJobs.get(userId)
    if (!active) return '你当前没有正在进行的下载。'
    if (active.cancelled) return `任务 #${active.id} 正在取消中。`
    active.cancelled = true
    try {
      await api.cancelJob(active.id)
    } catch (e: any) {
      active.cancelled = false
      return `取消失败: ${e.message}`
    }
    return `🛑 已取消任务 #${active.id}，不再等待下载`
  })

  // 搜索后直接回数字即可下载
  if (config.quickDownload) {
    ctx.middleware(async (session, next) => {
      const text = session.content?.trim()
      if (!text || !/^\d{1,2}$/.test(text)) return next()
      const cached = cacheGet(searchCache, String(session.userId || 'global'))
      if (!cached?.items?.length) return next()
      const index = parseInt(text, 10)
      if (index < 1 || index > cached.items.length) return `序号无效，请输入 1-${cached.items.length}`
      return runDownload(session, text)
    }, true)
  }
}

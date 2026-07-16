import { Context, Schema, h } from 'koishi'
import { setTimeout } from 'timers/promises'

export const name = 'tomato-downloader'
export const inject = ['puppeteer']

export interface Config {
  apiBase: string
  apiPassword: string
  maxSearchResults?: number
  initialWait?: number
  retryInterval?: number
  maxFileCheckRetries?: number
  fileSendMaxRetries?: number
  maxTextLength?: number
  enableImage?: boolean
  imageWidth?: number
  debug?: boolean
}

export const Config: Schema<Config> = Schema.object({
  apiBase: Schema.string().required().description('TND 服务地址，如 http://tnd.th-dd.top'),
  apiPassword: Schema.string().required().description('TND 服务的密码锁密码'),
  maxSearchResults: Schema.number().default(20).description('搜索结果最大显示数量'),
  initialWait: Schema.number().default(30000).description('创建任务后初始等待时间 (毫秒)'),
  retryInterval: Schema.number().default(10000).description('文件检查重试间隔 (毫秒)'),
  maxFileCheckRetries: Schema.number().default(33).description('文件检查最大重试次数'),
  fileSendMaxRetries: Schema.number().default(3).description('文件发送失败最大重试次数'),
  maxTextLength: Schema.number().default(4000).description('单条消息最大字符数'),
  enableImage: Schema.boolean().default(false).description('将搜索结果渲染为图片（需要 koishi-plugin-puppeteer）'),
  imageWidth: Schema.number().default(800).description('图片宽度'),
  debug: Schema.boolean().default(false).description('开启调试日志')
})

const searchCache = new Map<string, { items: any[], timestamp: number }>()
const CACHE_TTL = 5 * 60 * 1000

export function apply(ctx: Context, config: Config) {
  const base = config.apiBase.replace(/\/$/, '')
  let cookieString: string | null = null

  function logDebug(...args: any[]) {
    if (config.debug) ctx.logger.debug('[DEBUG]', ...args)
  }

  // ========== 检测适配器类型 ==========
  function getAdapterType(session: any): string {
    const platform = session?.platform || 'unknown'
    const adapter = session?.adapter || ''
    const platformLower = platform.toLowerCase()
    const adapterLower = adapter.toLowerCase()
    
    if (platformLower.includes('crack') || adapterLower.includes('crack')) {
      return 'qq_crack'
    }
    
    if (platformLower.includes('onebot') || adapterLower.includes('onebot') || 
        platformLower.includes('llonebot') || platformLower.includes('napcat') ||
        platformLower.includes('llob')) {
      return 'onebot'
    }
    
    if (platformLower.includes('qq') || adapterLower.includes('qq')) {
      return 'qq'
    }
    
    if (platformLower.includes('telegram') || adapterLower.includes('telegram')) {
      return 'telegram'
    }
    
    if (platformLower.includes('discord') || adapterLower.includes('discord')) {
      return 'discord'
    }
    
    return 'unknown'
  }

  async function login(): Promise<boolean> {
    if (cookieString) return true
    logDebug('登录 TND:', `${base}/api/login`)
    try {
      const res = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: config.apiPassword })
      })
      if (res.status === 200) {
        const setCookies = res.headers.getSetCookie?.() || []
        if (setCookies.length) {
          cookieString = setCookies.map(c => c.split(';')[0]).join('; ')
        } else {
          const single = res.headers.get('set-cookie')
          if (single) cookieString = single
        }
        ctx.logger.info('TND 登录成功')
        return true
      }
      ctx.logger.error(`登录失败: ${res.status}`)
      return false
    } catch (e: any) {
      ctx.logger.error(`登录异常: ${e.message}`)
      return false
    }
  }

  function getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (cookieString) headers['Cookie'] = cookieString
    return headers
  }

  async function authedFetch(path: string, options?: RequestInit, retry = 3): Promise<Response> {
    if (!cookieString) await login()
    let res = await fetch(`${base}${path}`, {
      ...options,
      headers: { ...getHeaders(), ...(options?.headers || {}) }
    })
    if (res.status === 429 && retry > 0) {
      const wait = parseInt(res.headers.get('Retry-After') || '15') * 1000
      ctx.logger.warn(`限流，等待 ${wait/1000}s`)
      await setTimeout(wait)
      return authedFetch(path, options, retry - 1)
    }
    if (res.status === 401 && cookieString) {
      ctx.logger.warn('Cookie 失效，重新登录')
      cookieString = null
      await login()
      return fetch(`${base}${path}`, {
        ...options,
        headers: { ...getHeaders(), ...(options?.headers || {}) }
      })
    }
    return res
  }

  async function renderResultsAsImage(items: any[], keyword: string): Promise<Buffer | null> {
    if (!config.enableImage) return null
    try {
      const browser = await (ctx as any).puppeteer.browser()
      const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; padding: 20px; background: #f5f5f5; }
          .container { max-width: ${config.imageWidth}px; margin: 0 auto; background: white; border-radius: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); overflow: hidden; }
          .header { background: #2c3e50; color: white; padding: 16px 24px; }
          .header h2 { margin: 0; font-size: 1.5rem; }
          .header p { margin: 8px 0 0; opacity: 0.8; font-size: 0.9rem; }
          table { width: 100%; border-collapse: collapse; }
          th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #eee; }
          th { background: #f8f9fa; font-weight: 600; color: #2c3e50; }
          tr:hover { background: #f8f9fa; }
          .book-id { font-family: monospace; font-size: 0.8rem; color: #7f8c8d; }
          .footer { padding: 12px 24px; background: #f8f9fa; color: #7f8c8d; font-size: 0.8rem; text-align: center; border-top: 1px solid #eee; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>🔍 搜索「${escapeHtml(keyword)}」</h2>
            <p>共找到 ${items.length} 本小说，请回复序号下载</p>
          </div>
          <table>
            <thead><tr><th>序号</th><th>书名</th><th>作者</th><th>小说ID</th></tr></thead>
            <tbody>
              ${items.map((item, idx) => `
                <tr>
                  <td style="font-weight: bold;">${idx+1}</td>
                  <td>${escapeHtml(item.title)}</td>
                  <td>${escapeHtml(item.author || '未知')}</td>
                  <td class="book-id">${item.book_id}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <div class="footer">💡 使用 tnd 下载 &lt;序号&gt; 下载（例如 tnd 下载 1）</div>
        </div>
      </body>
      </html>`
      const page = await browser.newPage()
      await page.setViewport({ width: config.imageWidth!, height: 800 })
      await page.setContent(html, { waitUntil: 'networkidle0' })
      const element = await page.$('.container')
      const screenshot = await element!.screenshot({ type: 'png' })
      await page.close()
      return screenshot
    } catch (e: any) {
      ctx.logger.error(`图片生成失败: ${e.message}`)
      return null
    }
  }

  function escapeHtml(str: string): string {
    return str.replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m] || m))
  }

  function generateTextResult(items: any[], keyword: string): string {
    const maxResults = config.maxSearchResults || 20
    const showItems = items.slice(0, maxResults)
    let msg = `🔍 搜索「${keyword}」找到 ${items.length} 本：\n\n`
    showItems.forEach((b: any, i: number) => {
      msg += `${i+1}. ${b.title}\n`
      if (b.author) msg += `   作者：${b.author}\n`
      msg += `   ID: ${b.book_id}\n\n`
    })
    if (items.length > maxResults) {
      msg += `... 仅展示前 ${maxResults} 本。\n`
    }
    msg += `💡 使用 tnd 下载 <序号> 下载（例如 tnd 下载 1）`
    return msg
  }

  function generateMarkdownResult(items: any[], keyword: string): any {
    const maxResults = config.maxSearchResults || 20
    const showItems = items.slice(0, maxResults)
    
    let md = `## 🔍 搜索「${keyword}」\n`
    md += `> 共找到 ${items.length} 本小说\n\n`
    md += `| 序号 | 书名 | 作者 |\n`
    md += `|:---:|:---|:---|\n`
    showItems.forEach((item, idx) => {
      const title = item.title.length > 15 ? item.title.slice(0, 15) + '…' : item.title
      const author = item.author || '未知'
      md += `| ${idx+1} | ${title} | ${author} |\n`
    })
    if (items.length > maxResults) {
      md += `\n> ⚠️ 仅展示前 ${maxResults} 本`
    }
    md += `\n\n💡 回复 \`tnd 下载 <序号>\` 下载`
    return md
  }

  function generateQuickReplyButtons(items: any[]): any[] {
    const maxResults = Math.min(config.maxSearchResults || 10, 10)
    const showItems = items.slice(0, maxResults)
    
    const rows: any[] = []
    let currentRow: any[] = []
    
    showItems.forEach((item, idx) => {
      const label = `${idx+1}.${item.title.length > 6 ? item.title.slice(0, 6) + '…' : item.title}`
      currentRow.push({
        label: label,
        text: `tnd 下载 ${idx+1}`,
        type: 'plain'
      })
      if (currentRow.length >= 5) {
        rows.push(currentRow)
        currentRow = []
      }
    })
    if (currentRow.length > 0) {
      rows.push(currentRow)
    }
    
    return rows
  }

  // ========== 获取 OneBot 适配器实例 ==========
  function getOneBotAdapter(session: any): any {
    try {
      const bot = session.bot as any
      if (bot?.onebot) {
        return bot.onebot
      }
    } catch (e) { /* ignore */ }
    
    try {
      const bots = ctx.bots as any
      if (bots && typeof bots.forEach === 'function') {
        let found: any = null
        bots.forEach((bot: any) => {
          const platform = bot.platform || ''
          if (platform.toLowerCase().includes('onebot') || 
              platform.toLowerCase().includes('llonebot') ||
              platform.toLowerCase().includes('napcat')) {
            if (bot.onebot) found = bot.onebot
          }
        })
        if (found) return found
      }
    } catch (e) { /* ignore */ }
    
    try {
      const bots = ctx.bots as any
      if (bots && typeof bots.get === 'function') {
        const bot = bots.get(session.platform)
        if (bot?.onebot) return bot.onebot
      }
    } catch (e) { /* ignore */ }
    
    return null
  }

  // ========== 清理文件名（移除非法字符） ==========
  function sanitizeFileName(name: string): string {
    // 移除 Windows/Linux 文件名非法字符
    return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_')
  }

  // ========== 多平台文件发送核心函数 ==========
  async function sendFile(session: any, buffer: Buffer, fileName: string): Promise<any> {
    const adapterType = getAdapterType(session)
    const maxRetries = config.fileSendMaxRetries || 3
    let lastError: any = null

    // 清理文件名
    const cleanFileName = sanitizeFileName(fileName)
    logDebug(`原始文件名: ${fileName}, 清理后: ${cleanFileName}`)

    // 检查文件大小 (QQ 官方限制 100MB，但建议更小)
    const fileSizeMB = buffer.length / (1024 * 1024)
    if (fileSizeMB > 50) {
      logDebug(`文件较大 (${fileSizeMB.toFixed(1)}MB)，可能会上传失败`)
    }

    for (let retry = 0; retry < maxRetries; retry++) {
      try {
        if (retry > 0) {
          logDebug(`文件发送重试第 ${retry} 次...`)
          await setTimeout(3000)
        }

        // ===== OneBot 适配器：直接调用 API =====
        if (adapterType === 'onebot') {
          const base64Data = buffer.toString('base64')
          logDebug(`OneBot 发送文件，大小: ${(buffer.length / 1024).toFixed(1)}KB`)
          
          const onebot = getOneBotAdapter(session)
          if (!onebot) {
            logDebug('未找到 OneBot 适配器，使用 h.file 备用方案')
            return h.file(buffer, 'text/plain', { name: cleanFileName })
          }

          const channelId = session.channelId || ''
          const isPrivate = channelId.startsWith('private:') || channelId.startsWith('private_') || channelId.includes('private')
          
          let result: any
          if (isPrivate) {
            const userId = channelId.replace(/^private[:_]/, '').replace(/[^0-9]/g, '')
            const targetId = parseInt(userId) || session.userId
            logDebug(`私聊发送，用户: ${targetId}`)
            // OneBot v11 send_private_file 参数
            result = await onebot._request('send_private_file', {
              user_id: typeof targetId === 'string' ? parseInt(targetId) : targetId,
              file: base64Data,
              name: cleanFileName
            })
          } else {
            const groupId = parseInt(channelId)
            if (isNaN(groupId)) {
              throw new Error(`无效的群号: ${channelId}`)
            }
            logDebug(`群聊发送，群号: ${groupId}`)
            // OneBot v11 upload_group_file 参数
            result = await onebot._request('upload_group_file', {
              group_id: groupId,
              file: base64Data,
              name: cleanFileName
            })
          }
          
          logDebug(`OneBot API 调用成功`)
          return `✅ 文件「${cleanFileName}」已发送。`
        }

        // ===== QQ 官方适配器 =====
        if (adapterType === 'qq') {
          logDebug(`QQ 官方适配器发送文件，大小: ${(buffer.length / 1024).toFixed(1)}KB`)
          
          // QQ 官方适配器对文件大小有限制，如果太大则分片或使用其他方式
          // 注意：QQ 官方适配器使用 h.file 时，文件名需要正确传递
          return h.file(buffer, 'text/plain', { 
            name: cleanFileName,
            // QQ 适配器可能需要指定 type
            type: 'file'
          })
        }

        // ===== QQ Crack =====
        if (adapterType === 'qq_crack') {
          logDebug(`QQ Crack 适配器发送文件`)
          return h.file(buffer, 'text/plain', { name: cleanFileName })
        }

        // ===== Telegram =====
        if (adapterType === 'telegram') {
          logDebug(`Telegram 发送文件`)
          return h.file(buffer, 'text/plain', { name: cleanFileName })
        }

        // ===== Discord =====
        if (adapterType === 'discord') {
          logDebug(`Discord 发送文件`)
          return h.file(buffer, 'text/plain', { name: cleanFileName })
        }

        // ===== 未知适配器 =====
        logDebug(`未知适配器，使用 Buffer 方式发送`)
        return h.file(buffer, 'text/plain', { name: cleanFileName })

      } catch (e: any) {
        lastError = e
        logDebug(`文件发送失败 (尝试 ${retry + 1}/${maxRetries}): ${e.message}`)
        if (retry < maxRetries - 1) {
          await setTimeout(5000)
        }
      }
    }

    throw lastError || new Error('文件发送失败')
  }

  const tnd = ctx.command('tnd', '番茄小说下载器')

  // ========== 搜索命令 ==========
  const searchCmd = tnd.subcommand('.search <keyword:text>', '搜索小说')
  searchCmd.alias('.搜索')
  searchCmd.action(async ({ session }, keyword) => {
    if (!keyword) return '用法：tnd 搜索 小说名'
    logDebug(`搜索: ${keyword}`)
    logDebug(`适配器类型: ${getAdapterType(session)}`)
    
    try {
      const res = await authedFetch(`/api/search?q=${encodeURIComponent(keyword)}`)
      if (!res.ok) return `搜索失败 (${res.status})`
      const data = await res.json()
      const items = data.items || []
      if (!items.length) return '没有找到相关小说。'
      const userId = session?.userId || 'global'
      searchCache.set(userId, { items, timestamp: Date.now() })

      const adapterType = getAdapterType(session)

      if (adapterType === 'onebot') {
        logDebug('使用 OneBot 响应策略')
        if (config.enableImage) {
          const img = await renderResultsAsImage(items.slice(0, config.maxSearchResults || 20), keyword)
          if (img) {
            return h.image(img, 'image/png')
          }
        }
        return generateTextResult(items, keyword)
      }

      if (adapterType === 'qq' || adapterType === 'qq_crack') {
        logDebug('使用 QQ 响应策略')
        if (config.enableImage) {
          const img = await renderResultsAsImage(items.slice(0, config.maxSearchResults || 20), keyword)
          if (img) {
            return h.image(img, 'image/png')
          }
        }
        try {
          const md = generateMarkdownResult(items, keyword)
          const buttons = generateQuickReplyButtons(items)
          if (buttons.length > 0) {
            return h('message', { type: 'markdown' }, md, h('keyboard', { rows: buttons }))
          }
          return h('message', { type: 'markdown' }, md)
        } catch (e) {
          logDebug(`Markdown 失败，降级: ${(e as any).message}`)
        }
        try {
          const text = generateTextResult(items, keyword)
          const buttons = generateQuickReplyButtons(items)
          if (buttons.length > 0) {
            return h('message', text, h('keyboard', { rows: buttons }))
          }
          return text
        } catch (e) {
          return generateTextResult(items, keyword)
        }
      }

      if (adapterType === 'telegram') {
        logDebug('使用 Telegram 响应策略')
        if (config.enableImage) {
          const img = await renderResultsAsImage(items.slice(0, config.maxSearchResults || 20), keyword)
          if (img) return h.image(img, 'image/png')
        }
        try {
          const md = generateMarkdownResult(items, keyword)
          return h('message', { type: 'markdown' }, md)
        } catch {
          return generateTextResult(items, keyword)
        }
      }

      if (adapterType === 'discord') {
        logDebug('使用 Discord 响应策略')
        if (config.enableImage) {
          const img = await renderResultsAsImage(items.slice(0, config.maxSearchResults || 20), keyword)
          if (img) return h.image(img, 'image/png')
        }
        return generateTextResult(items, keyword)
      }

      logDebug('使用未知适配器响应策略')
      if (config.enableImage) {
        const img = await renderResultsAsImage(items.slice(0, config.maxSearchResults || 20), keyword)
        if (img) return h.image(img, 'image/png')
      }
      return generateTextResult(items, keyword)

    } catch (e: any) {
      return `搜索失败: ${e.message}`
    }
  })

  // ========== 下载命令 ==========
  const downloadCmd = tnd.subcommand('.download <target>', '下载小说')
  downloadCmd.alias('.下载')
  downloadCmd.action(async ({ session }, target) => {
    if (!target) return '用法：tnd 下载 <序号> 或 tnd 下载 <book_id>'
    logDebug(`下载目标: ${target}`)

    let book_id: string | null = null
    let book_title: string | null = null

    if (/^\d+$/.test(target) && target.length > 15) {
      book_id = target
    } else {
      const userId = session?.userId || 'global'
      const cached = searchCache.get(userId)
      if (!cached || Date.now() - cached.timestamp > CACHE_TTL) {
        return '未找到搜索结果，请先使用 tnd 搜索'
      }
      const idx = parseInt(target, 10)
      if (isNaN(idx) || idx < 1 || idx > cached.items.length) {
        return `序号无效，请输入 1-${cached.items.length}`
      }
      book_id = cached.items[idx-1].book_id
      book_title = cached.items[idx-1].title
    }
    if (!book_id) return '无法获取小说 ID'
    if (!book_title) return '无法获取书名，请重新搜索'

    try {
      const createRes = await authedFetch('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({ book_id })
      })
      if (!createRes.ok) return `创建任务失败 (${createRes.status})`
      const job = await createRes.json()
      const taskId = job.id || job.data?.id
      if (!taskId) return `创建失败: ${JSON.stringify(job)}`

      await session?.send(`📥 任务已创建 (ID: ${taskId})，正在下载...`)

      const INITIAL_WAIT = config.initialWait || 30000
      const RETRY_INTERVAL = config.retryInterval || 10000
      const MAX_RETRIES = config.maxFileCheckRetries || 33

      await setTimeout(INITIAL_WAIT)

      const fileName = `${book_title}.txt`
      const fileUrl = `${base}/download/${encodeURIComponent(fileName)}`

      for (let i = 0; i < MAX_RETRIES; i++) {
        try {
          const checkRes = await fetch(fileUrl, {
            method: 'HEAD',
            headers: { Cookie: cookieString || '' }
          })
          
          if (checkRes.ok) {
            logDebug(`文件已就绪 (尝试 ${i+1} 次)`)
            
            const fileRes = await fetch(fileUrl, {
              headers: { Cookie: cookieString || '' }
            })
            
            if (!fileRes.ok) {
              return `下载文件失败 (HTTP ${fileRes.status})`
            }
            
            const arrayBuffer = await fileRes.arrayBuffer()
            const buffer = Buffer.from(arrayBuffer)

            await session?.send(`✅ 小说「${book_title}」下载完成！正在发送文件...`)

            // 文件名格式: 书名_小说ID.txt
            const fileNameWithId = `${book_title}_${book_id}.txt`
            
            try {
              return await sendFile(session, buffer, fileNameWithId)
            } catch (e: any) {
              return `❌ 文件发送失败，请稍后重试。错误: ${e.message}`
            }
          }
          
          logDebug(`文件未就绪 (尝试 ${i+1}/${MAX_RETRIES})，状态码: ${checkRes.status}`)
        } catch (e: any) {
          logDebug(`检查文件异常: ${e.message}`)
        }
        
        await setTimeout(RETRY_INTERVAL)
      }

      return `下载超时（已等待 ${(INITIAL_WAIT + MAX_RETRIES * RETRY_INTERVAL) / 1000} 秒），请稍后手动访问 TND 获取。任务 ID: ${taskId}`
    } catch (e: any) {
      ctx.logger.error(`下载异常: ${e.message}`)
      return `下载失败: ${e.message}`
    }
  })
}
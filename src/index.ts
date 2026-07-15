import { Context, Schema, h } from 'koishi'
import { setTimeout } from 'timers/promises'

export const name = 'tomato-downloader'
export const inject = ['puppeteer']

export interface Config {
  apiBase: string
  apiPassword: string
  // 搜索结果配置
  maxSearchResults?: number
  // 下载等待配置
  initialWait?: number
  retryInterval?: number
  maxFileCheckRetries?: number
  // 文件发送配置
  fileSendMaxRetries?: number
  // 文本截断配置
  maxTextLength?: number
  // 功能开关
  enableImage?: boolean
  imageWidth?: number
  // 调试
  debug?: boolean
}

export const Config: Schema<Config> = Schema.object({
  apiBase: Schema.string().required().description('TND 服务地址，如 http://tnd.th-dd.top'),
  apiPassword: Schema.string().required().description('TND 服务的密码锁密码'),
  
  // 搜索结果配置
  maxSearchResults: Schema.number().default(20).description('搜索结果最大显示数量'),
  
  // 下载等待配置（单位：毫秒）
  initialWait: Schema.number().default(30000).description('创建任务后初始等待时间 (毫秒)'),
  retryInterval: Schema.number().default(10000).description('文件检查重试间隔 (毫秒)'),
  maxFileCheckRetries: Schema.number().default(33).description('文件检查最大重试次数'),
  
  // 文件发送配置
  fileSendMaxRetries: Schema.number().default(3).description('文件发送失败最大重试次数'),
  
  // 文本截断配置（QQ 适配器可能有消息长度限制）
  maxTextLength: Schema.number().default(4000).description('单条消息最大字符数'),
  
  // 图片功能
  enableImage: Schema.boolean().default(false).description('将搜索结果渲染为图片（需要 koishi-plugin-puppeteer）'),
  imageWidth: Schema.number().default(800).description('图片宽度'),
  
  // 调试
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

  // 生成 Markdown 表格（适配 QQ 适配器）
  function generateMarkdownTable(items: any[], keyword: string): string {
    const maxResults = config.maxSearchResults || 20
    const showItems = items.slice(0, maxResults)
    
    let md = `## 🔍 搜索「${keyword}」\n`
    md += `> 共找到 ${items.length} 本小说，请回复序号下载\n\n`
    md += `| 序号 | 书名 | 作者 |\n`
    md += `|:---:|:---|:---|\n`
    showItems.forEach((item, idx) => {
      const title = item.title.length > 15 ? item.title.slice(0, 15) + '…' : item.title
      const author = item.author || '未知'
      md += `| ${idx+1} | ${title} | ${author} |\n`
    })
    if (items.length > maxResults) {
      md += `\n> ⚠️ 仅展示前 ${maxResults} 本，更多结果请缩小关键词范围`
    }
    md += `\n\n💡 使用 \`tnd 下载 <序号>\` 下载`
    return md
  }

  const tnd = ctx.command('tnd', '番茄小说下载器')

  const searchCmd = tnd.subcommand('.search <keyword:text>', '搜索小说')
  searchCmd.alias('.搜索')
  searchCmd.action(async ({ session }, keyword) => {
    if (!keyword) return '用法：tnd 搜索 小说名'
    logDebug(`搜索: ${keyword}`)
    try {
      const res = await authedFetch(`/api/search?q=${encodeURIComponent(keyword)}`)
      if (!res.ok) return `搜索失败 (${res.status})`
      const data = await res.json()
      const items = data.items || []
      if (!items.length) return '没有找到相关小说。'
      const userId = session?.userId || 'global'
      searchCache.set(userId, { items, timestamp: Date.now() })

      // 优先使用图片输出
      if (config.enableImage) {
        const img = await renderResultsAsImage(items.slice(0, config.maxSearchResults || 20), keyword)
        if (img) return h.image(img, 'image/png')
      }

      // 尝试 Markdown 输出（QQ 适配器支持）
      try {
        const md = generateMarkdownTable(items, keyword)
        return h('message', { type: 'markdown' }, md)
      } catch {
        // Markdown 不支持，降级为纯文本
        let msg = `🔍 找到 ${items.length} 本：\n`
        items.slice(0, config.maxSearchResults || 20).forEach((b: any, i: number) => {
          msg += `${i+1}. ${b.title} (${b.author || '未知'})\n`
        })
        msg += `\n💡 使用 tnd 下载 <序号>`
        return msg
      }
    } catch (e: any) {
      return `搜索失败: ${e.message}`
    }
  })

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

            // ========== 先发文字说下载完成 ==========
            await session?.send(`✅ 小说「${book_title}」下载完成！正在发送文件...`)

            // ========== 发送文件（带重试机制，使用 Buffer 方式，兼容 OneBot 和 QQ 适配器） ==========
            const maxRetries = config.fileSendMaxRetries || 3
            let lastError: any = null
            for (let retry = 0; retry < maxRetries; retry++) {
              try {
                if (retry > 0) {
                  logDebug(`文件发送重试第 ${retry} 次...`)
                  await setTimeout(3000)
                }
                // 使用 Buffer 方式发送，兼容性最好
                return h.file(buffer, 'text/plain', {
                  name: `tnd-${book_title}-${book_id}.txt`
                })
              } catch (e: any) {
                lastError = e
                logDebug(`文件发送失败 (尝试 ${retry + 1}/${maxRetries}): ${e.message}`)
                if (retry < maxRetries - 1) {
                  await setTimeout(5000)
                }
              }
            }
            
            return `❌ 文件发送失败（已重试 ${maxRetries} 次），请稍后重试。错误: ${lastError?.message || '未知错误'}`
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
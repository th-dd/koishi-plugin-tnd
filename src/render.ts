import type { Context } from 'koishi'
import { h } from 'koishi'
import type { BookItem, Preview, TndConfig } from './types'

export type ResponseMode = 'onebot' | 'qq' | 'telegram' | 'discord' | 'unknown'

export function responseMode(session: any): ResponseMode {
  const platform = String(session?.platform || session?.bot?.platform || '').toLowerCase()
  if (platform.includes('llonebot') || platform.includes('napcat') || platform.includes('llob') || platform.includes('onebot')) return 'onebot'
  if (platform.includes('qq')) return 'qq'
  if (platform.includes('telegram')) return 'telegram'
  if (platform.includes('discord')) return 'discord'
  return 'unknown'
}

export function escapeHtml(input: string) {
  return input.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

/** 按字符上限切分文本，尽量在换行处断开。 */
export function splitText(input: string, limit: number): string[] {
  const max = Math.max(limit, 200)
  const chunks: string[] = []
  let rest = input
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.5) cut = max
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

/** 通过 session.sendQueued 顺序发出（自动保持间隔，避免刷屏/被风控）。 */
export async function sendLong(session: any, text: string, limit: number) {
  const chunks = splitText(text, limit)
  for (const chunk of chunks) await session.sendQueued(chunk)
}

export function textResult(items: BookItem[], keyword: string, maxResults: number) {
  const shown = items.slice(0, maxResults)
  let msg = `🔍 搜索「${keyword}」找到 ${items.length} 本：\n\n`
  shown.forEach((item, index) => {
    msg += `${index + 1}. ${item.title}\n`
    if (item.author) msg += `   作者：${item.author}\n`
    msg += `   ID: ${item.book_id}\n\n`
  })
  if (items.length > maxResults) msg += `... 仅展示前 ${maxResults} 本。\n`
  msg += '💡 使用 tnd 下载 <序号> 下载（例如 tnd 下载 1）'
  return msg
}

export function markdownResult(items: BookItem[], keyword: string, maxResults: number) {
  const shown = items.slice(0, maxResults)
  let md = `## 🔍 搜索「${keyword}」\n> 共找到 ${items.length} 本\n\n| 序号 | 书名 | 作者 |\n|:---:|:---|:---|\n`
  shown.forEach((item, index) => {
    const title = item.title.length > 15 ? item.title.slice(0, 15) + '…' : item.title
    md += `| ${index + 1} | ${title} | ${item.author || '未知'} |\n`
  })
  if (items.length > maxResults) md += `\n> ⚠️ 仅展示前 ${maxResults} 本`
  md += '\n\n💡 回复 `tnd 下载 <序号>` 下载'
  return md
}

export function quickReplies(items: BookItem[], maxResults: number) {
  const shown = items.slice(0, Math.min(maxResults, 10))
  const rows: any[] = []
  let row: any[] = []
  shown.forEach((item, index) => {
    // 官机按钮只放序号，放书名会被截断且挤成一团
    row.push({ label: `${index + 1}`, text: `tnd 下载 ${index + 1}`, type: 'plain' })
    if (row.length >= 5) {
      rows.push(row)
      row = []
    }
  })
  if (row.length) rows.push(row)
  return rows
}

/** QQ 官方适配器只认 <qq:markdown> 和 <button-group>/<button>，不认 <message type="markdown">。 */
export function qqMarkdownMessage(content: string, rows: any[][]) {
  const children: any[] = [h('qq:markdown', {}, content)]
  if (rows.length) {
    // 适配器每 5 个按钮自动换行，这里摊平即可
    const buttons = rows.flat().map((button: any) => h('button', { id: button.text, type: 'plain' }, button.label))
    children.push(h('button-group', {}, ...buttons))
  }
  return h('message', {}, ...children)
}

export function formatBytes(bytes?: number) {
  if (!bytes || bytes <= 0) return '未知大小'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function previewText(preview: Preview) {
  const lines = [
    `📖 《${preview.book_name}》`,
    preview.author ? `作者：${preview.author}` : '',
    preview.category ? `分类：${preview.category}` : '',
    preview.chapter_count ? `章节：${preview.chapter_count}` : '',
    preview.word_count ? `字数：${preview.word_count}（约 ${formatBytes(preview.word_count * 3)}）` : '',
    preview.finished ? '状态：完结' : '状态：连载中',
    typeof preview.score === 'number' ? `评分：${preview.score.toFixed(1)}` : '',
    preview.description ? `\n${preview.description.slice(0, 300)}` : '',
    `\n💡 tnd 下载 ${preview.book_id} 开始下载`,
  ]
  return lines.filter(Boolean).join('\n')
}

const IMAGE_TEMPLATE = (keyword: string, items: BookItem[], width: number) => `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;padding:20px;background:#f5f5f5}
.container{max-width:${width}px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 2px 8px rgba(0,0,0,.1);overflow:hidden}
.header{background:#2c3e50;color:#fff;padding:16px 24px}
.header p{margin:8px 0 0;opacity:.8;font-size:.9rem}
table{width:100%;border-collapse:collapse}
th,td{padding:12px 16px;text-align:left;border-bottom:1px solid #eee}
th{background:#f8f9fa;color:#2c3e50}
.book-id{font-family:monospace;font-size:.8rem;color:#7f8c8d}
.footer{padding:12px 24px;background:#f8f9fa;color:#7f8c8d;font-size:.8rem;text-align:center;border-top:1px solid #eee}
</style></head><body><div class="container">
<div class="header"><h2>🔍 搜索「${escapeHtml(keyword)}」</h2><p>共找到 ${items.length} 本小说，请回复序号下载</p></div>
<table><thead><tr><th>序号</th><th>书名</th><th>作者</th><th>小说ID</th></tr></thead><tbody>
${items.map((item, index) => `<tr><td><b>${index + 1}</b></td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.author || '未知')}</td><td class="book-id">${escapeHtml(item.book_id)}</td></tr>`).join('')}
</tbody></table><div class="footer">💡 使用 tnd 下载 &lt;序号&gt; 下载</div>
</div></body></html>`

/** 兼容 puppeteer 服务的两种 API：3.x 的 ctx.puppeteer.page() 与旧版 browser()。 */
async function withPage<T>(ctx: Context, run: (page: any) => Promise<T>): Promise<T | null> {
  const service: any = (ctx as any).puppeteer
  if (!service) return null
  let page: any
  try {
    if (typeof service.page === 'function') page = await service.page()
    else {
      const browser = typeof service.browser === 'function' ? await service.browser() : service.browser
      page = await browser.newPage()
    }
    page?.setDefaultTimeout?.(15000)
    page?.setDefaultNavigationTimeout?.(15000)
    return await run(page)
  } catch (e: any) {
    ctx.logger.warn('截图失败: %s', e.message)
    return null
  } finally {
    try { await page?.close?.() } catch { /* 忽略关闭失败 */ }
  }
}

/** setContent 在容器里对 networkidle0 很敏感，load 失败再退 domcontentloaded。 */
async function setHtml(page: any, html: string) {
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 15000 })
  } catch {
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 })
  }
}

export async function renderSearchImage(ctx: Context, keyword: string, items: BookItem[], config: TndConfig) {
  if (!config.enableImage) return null
  return withPage(ctx, async (page) => {
    await page.setViewport({ width: config.imageWidth, height: 800 })
    await setHtml(page, IMAGE_TEMPLATE(keyword, items, config.imageWidth))
    const element = await page.$('.container')
    if (!element) return null
    return (await element.screenshot({ type: 'png', timeout: 15000 })) as Buffer
  })
}

export async function renderPreviewImage(ctx: Context, preview: Preview, width: number) {
  return withPage(ctx, async (page) => {
    await page.setViewport({ width, height: 800 })
    await setHtml(page, `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{font-family:system-ui,'Segoe UI',sans-serif;padding:16px;background:#f5f5f5;max-width:${width}px}
h2{margin:0 0 8px} .meta{color:#666;font-size:.85rem;margin-bottom:12px}
.desc{background:#fff;border-radius:12px;padding:16px;line-height:1.7;white-space:pre-wrap}
</style></head><body><h2>${escapeHtml(preview.book_name)}</h2>
<div class="meta">${escapeHtml(preview.author || '')} · ${preview.chapter_count || 0} 章 · ${preview.finished ? '完结' : '连载中'}</div>
<div class="desc">${escapeHtml(preview.description || '（无简介）')}</div></body></html>`)
    return (await page.screenshot({ type: 'png', timeout: 15000 })) as Buffer
  })
}

export function imageElement(buffer: Buffer) {
  return h.image(buffer, 'image/png')
}

/**
 * 小说下载服务
 * 提供小说下载、格式转换等功能
 */

import { Context, Logger } from 'koishi'
import * as fs from 'fs'
import * as path from 'path'
import {
  DownloadTask,
  DownloadOptions,
  NovelInfo,
  ChapterInfo,
  ChapterContent,
  NovelPlatform,
  defaultConfig
} from '../api/types'
import { FanqieApi } from '../api/fanqie'

const logger = new Logger('novel-downloader/service')

export class NovelDownloadService {
  private ctx: Context
  private config: typeof defaultConfig
  private tasks: Map<string, DownloadTask> = new Map()
  private platformApis: Map<NovelPlatform, FanqieApi> = new Map()
  private taskCounter: number = 0

  constructor(ctx: Context, config: typeof defaultConfig) {
    this.ctx = ctx
    this.config = config
    this.initPlatformApis()
    this.ensureDownloadDir()
  }

  /**
   * 初始化平台API
   */
  private initPlatformApis() {
    const fanqieApi = new FanqieApi(this.ctx, this.config.timeout)
    this.platformApis.set('fanqie', fanqieApi)
  }

  /**
   * 确保下载目录存在
   */
  private async ensureDownloadDir() {
    const downloadPath = path.resolve(this.config.downloadPath)
    if (!fs.existsSync(downloadPath)) {
      fs.mkdirSync(downloadPath, { recursive: true })
      logger.info(`创建下载目录: ${downloadPath}`)
    }
  }

  /**
   * 获取平台API
   */
  private getApi(platform: NovelPlatform): FanqieApi {
    const api = this.platformApis.get(platform)
    if (!api) {
      throw new Error(`不支持的平台: ${platform}`)
    }
    return api
  }

  /**
   * 搜索小说
   */
  async search(keyword: string, platform: NovelPlatform = 'fanqie', page: number = 1): Promise<{
    novels: NovelInfo[]
    total: number
  }> {
    const api = this.getApi(platform)
    const result = await api.search(keyword, page, 20)
    return {
      novels: result.novels,
      total: result.total
    }
  }

  /**
   * 获取小说详情
   */
  async getNovelInfo(novelId: string, platform: NovelPlatform = 'fanqie'): Promise<NovelInfo> {
    const api = this.getApi(platform)
    return await api.getNovelInfo(novelId)
  }

  /**
   * 获取章节列表
   */
  async getChapterList(novelId: string, platform: NovelPlatform = 'fanqie'): Promise<ChapterInfo[]> {
    const api = this.getApi(platform)
    return await api.getChapterList(novelId)
  }

  /**
   * 创建下载任务
   */
  async createTask(
    novelId: string,
    platform: NovelPlatform = 'fanqie',
    options: Partial<DownloadOptions> = {}
  ): Promise<DownloadTask> {
    const taskId = `task_${++this.taskCounter}_${Date.now()}`
    
    // 获取小说信息
    const api = this.getApi(platform)
    const novelInfo = await api.getNovelInfo(novelId)
    
    const task: DownloadTask = {
      id: taskId,
      novelId,
      title: novelInfo.title,
      platform,
      status: 'pending',
      progress: 0,
      totalChapters: novelInfo.chapterCount || 0,
      downloadedChapters: 0,
      startTime: new Date()
    }
    
    this.tasks.set(taskId, task)
    
    // 异步执行下载
    this.executeDownload(taskId, novelInfo, options).catch(err => {
      logger.error(`下载任务 ${taskId} 失败:`, err)
      const t = this.tasks.get(taskId)
      if (t) {
        t.status = 'failed'
        t.error = err.message
        t.endTime = new Date()
      }
    })
    
    return task
  }

  /**
   * 执行下载
   */
  private async executeDownload(
    taskId: string,
    novelInfo: NovelInfo,
    options: Partial<DownloadOptions>
  ): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return
    
    task.status = 'downloading'
    const api = this.getApi(task.platform)
    
    try {
      // 获取章节列表
      const chapters = await api.getChapterList(task.novelId)
      task.totalChapters = chapters.length
      
      // 确定下载范围
      const { chapterRange } = options
      let downloadChapters = chapters
      if (chapterRange) {
        downloadChapters = chapters.slice(
          chapterRange.start - 1,
          chapterRange.end
        )
      }
      
      // 下载章节内容
      const contents: ChapterContent[] = []
      const batchSize = this.config.concurrency
      
      for (let i = 0; i < downloadChapters.length; i += batchSize) {
        const batch = downloadChapters.slice(i, i + batchSize)
        const batchContents = await Promise.all(
          batch.map(ch => api.getChapterContent(task.novelId, ch.id))
        )
        contents.push(...batchContents)
        
        task.downloadedChapters = Math.min(i + batchSize, downloadChapters.length)
        task.progress = Math.round((task.downloadedChapters / task.totalChapters) * 100)
        
        // 添加延迟避免请求过快
        if (i + batchSize < downloadChapters.length) {
          await this.delay(500)
        }
      }
      
      // 生成文件
      const format = options.format || this.config.defaultFormat
      const encoding = options.encoding || this.config.defaultEncoding
      
      const filePath = await this.generateFile(
        novelInfo,
        contents,
        format,
        encoding,
        options
      )
      
      task.status = 'completed'
      task.progress = 100
      task.filePath = filePath
      task.endTime = new Date()
      
      logger.info(`下载完成: ${novelInfo.title} -> ${filePath}`)
    } catch (error) {
      task.status = 'failed'
      task.error = error.message
      task.endTime = new Date()
      throw error
    }
  }

  /**
   * 生成文件
   */
  private async generateFile(
    novelInfo: NovelInfo,
    contents: ChapterContent[],
    format: 'txt' | 'epub',
    encoding: 'utf-8' | 'gbk',
    options: Partial<DownloadOptions>
  ): Promise<string> {
    const downloadPath = path.resolve(this.config.downloadPath)
    const safeTitle = this.sanitizeFilename(novelInfo.title)
    
    if (format === 'txt') {
      return await this.generateTxt(novelInfo, contents, downloadPath, encoding, options)
    } else {
      return await this.generateEpub(novelInfo, contents, downloadPath, options)
    }
  }

  /**
   * 生成TXT文件
   */
  private async generateTxt(
    novelInfo: NovelInfo,
    contents: ChapterContent[],
    downloadPath: string,
    encoding: 'utf-8' | 'gbk',
    options: Partial<DownloadOptions>
  ): Promise<string> {
    const safeTitle = this.sanitizeFilename(novelInfo.title)
    const filePath = path.join(downloadPath, `${safeTitle}.txt`)
    
    let text = ''
    
    // 添加书名
    text += `${novelInfo.title}\n`
    text += `作者: ${novelInfo.author}\n`
    text += `${'='.repeat(40)}\n\n`
    
    // 添加简介
    if (options.includeDescription !== false && novelInfo.description) {
      text += `【简介】\n${novelInfo.description}\n\n`
      text += `${'='.repeat(40)}\n\n`
    }
    
    // 添加章节内容
    for (const chapter of contents) {
      text += `${chapter.title}\n\n`
      text += `${chapter.content}\n\n`
      text += `${'─'.repeat(40)}\n\n`
    }
    
    // 写入文件
    const buffer = Buffer.from(text, encoding as BufferEncoding)
    fs.writeFileSync(filePath, buffer)
    
    return filePath
  }

  /**
   * 生成EPUB文件（简化版）
   */
  private async generateEpub(
    novelInfo: NovelInfo,
    contents: ChapterContent[],
    downloadPath: string,
    options: Partial<DownloadOptions>
  ): Promise<string> {
    // EPUB格式较复杂，这里简化为生成HTML格式
    const safeTitle = this.sanitizeFilename(novelInfo.title)
    const filePath = path.join(downloadPath, `${safeTitle}.html`)
    
    let html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${this.escapeHtml(novelInfo.title)}</title>
  <style>
    body { font-family: "Microsoft YaHei", sans-serif; line-height: 1.8; max-width: 800px; margin: 0 auto; padding: 20px; }
    h1 { text-align: center; }
    h2 { border-bottom: 1px solid #ccc; padding-bottom: 10px; }
    .author { text-align: center; color: #666; }
    .description { background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0; }
    .chapter { margin: 30px 0; }
    .chapter-title { font-size: 1.3em; font-weight: bold; margin-bottom: 15px; }
    .chapter-content { text-indent: 2em; }
  </style>
</head>
<body>
  <h1>${this.escapeHtml(novelInfo.title)}</h1>
  <p class="author">作者: ${this.escapeHtml(novelInfo.author)}</p>
`
    
    if (options.includeDescription !== false && novelInfo.description) {
      html += `  <div class="description">
    <strong>简介:</strong><br>
    ${this.escapeHtml(novelInfo.description)}
  </div>
`
    }
    
    for (const chapter of contents) {
      html += `  <div class="chapter">
    <div class="chapter-title">${this.escapeHtml(chapter.title)}</div>
    <div class="chapter-content">${this.escapeHtml(chapter.content).split('\n').join('<br>')}</div>
  </div>
`
    }
    
    html += `</body>
</html>`
    
    fs.writeFileSync(filePath, html, 'utf-8')
    
    return filePath
  }

  /**
   * 获取任务状态
   */
  async getTaskStatus(taskId: string): Promise<DownloadTask | undefined> {
    return this.tasks.get(taskId)
  }

  /**
   * 获取所有任务
   */
  async getAllTasks(): Promise<DownloadTask[]> {
    return Array.from(this.tasks.values())
  }

  /**
   * 取消任务
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId)
    if (!task) return false
    
    if (task.status === 'downloading') {
      task.status = 'failed'
      task.error = '用户取消'
      task.endTime = new Date()
      return true
    }
    
    return false
  }

  /**
   * 清理已完成任务
   */
  async clearCompletedTasks(): Promise<number> {
    let count = 0
    for (const [id, task] of this.tasks) {
      if (task.status === 'completed' || task.status === 'failed') {
        this.tasks.delete(id)
        count++
      }
    }
    return count
  }

  /**
   * 清理文件名
   */
  private sanitizeFilename(name: string): string {
    return name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100)
  }

  /**
   * HTML转义
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  /**
   * 延迟
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * 从URL解析小说ID
   */
  parseNovelId(url: string, platform: NovelPlatform = 'fanqie'): string | null {
    if (platform === 'fanqie') {
      return FanqieApi.parseNovelId(url)
    }
    return null
  }
}

/**
 * 小说下载插件类型定义
 * 支持番茄小说等平台的电子书下载
 */

import { Context, Schema } from 'koishi'

// 小说平台类型
export type NovelPlatform = 'fanqie' | 'qidian' | 'other'

// 小说信息
export interface NovelInfo {
  id: string
  title: string
  author: string
  cover?: string
  description?: string
  wordCount?: number
  chapterCount?: number
  status?: '连载中' | '已完结'
  platform: NovelPlatform
  url?: string
}

// 章节信息
export interface ChapterInfo {
  id: string
  title: string
  index: number
  wordCount?: number
  isVip?: boolean
}

// 章节内容
export interface ChapterContent {
  id: string
  title: string
  content: string
  index: number
}

// 下载任务
export interface DownloadTask {
  id: string
  novelId: string
  title: string
  platform: NovelPlatform
  status: 'pending' | 'downloading' | 'completed' | 'failed'
  progress: number
  totalChapters: number
  downloadedChapters: number
  startTime?: Date
  endTime?: Date
  error?: string
  filePath?: string
}

// 下载选项
export interface DownloadOptions {
  format: 'txt' | 'epub'
  encoding: 'utf-8' | 'gbk'
  includeCover?: boolean
  includeDescription?: boolean
  chapterRange?: {
    start: number
    end: number
  }
}

// 搜索结果
export interface SearchResult {
  novels: NovelInfo[]
  total: number
  page: number
  pageSize: number
}

// API响应
export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
  code?: number
}

// 插件配置
export interface NovelDownloaderConfig {
  // 默认下载格式
  defaultFormat: 'txt' | 'epub'
  // 默认编码
  defaultEncoding: 'utf-8' | 'gbk'
  // 下载保存路径
  downloadPath: string
  // 并发下载数
  concurrency: number
  // 请求超时时间（毫秒）
  timeout: number
  // 是否启用缓存
  enableCache: boolean
  // 缓存过期时间（秒）
  cacheExpire: number
}

// 默认配置
export const defaultConfig: NovelDownloaderConfig = {
  defaultFormat: 'txt',
  defaultEncoding: 'utf-8',
  downloadPath: './downloads/novels',
  concurrency: 5,
  timeout: 30000,
  enableCache: true,
  cacheExpire: 3600
}

// 配置Schema
export const Config: Schema<NovelDownloaderConfig> = Schema.object({
  defaultFormat: Schema.union(['txt', 'epub'] as const)
    .default('txt')
    .description('默认下载格式'),
  defaultEncoding: Schema.union(['utf-8', 'gbk'] as const)
    .default('utf-8')
    .description('默认文件编码'),
  downloadPath: Schema.string()
    .default('./downloads/novels')
    .description('下载文件保存路径'),
  concurrency: Schema.number()
    .min(1)
    .max(20)
    .default(5)
    .description('并发下载数量'),
  timeout: Schema.number()
    .min(5000)
    .max(120000)
    .default(30000)
    .description('请求超时时间（毫秒）'),
  enableCache: Schema.boolean()
    .default(true)
    .description('是否启用缓存'),
  cacheExpire: Schema.number()
    .min(300)
    .max(86400)
    .default(3600)
    .description('缓存过期时间（秒）')
})

// 平台API接口
export interface PlatformApi {
  // 平台名称
  name: string
  // 平台标识
  platform: NovelPlatform
  // 搜索小说
  search(keyword: string, page?: number, pageSize?: number): Promise<SearchResult>
  // 获取小说详情
  getNovelInfo(novelId: string): Promise<NovelInfo>
  // 获取章节列表
  getChapterList(novelId: string): Promise<ChapterInfo[]>
  // 获取章节内容
  getChapterContent(novelId: string, chapterId: string): Promise<ChapterContent>
  // 批量获取章节内容
  getChapterContents(novelId: string, chapterIds: string[]): Promise<ChapterContent[]>
}

// 下载服务接口
export interface DownloaderService {
  // 创建下载任务
  createTask(novelId: string, platform: NovelPlatform, options?: Partial<DownloadOptions>): Promise<DownloadTask>
  // 获取任务状态
  getTaskStatus(taskId: string): Promise<DownloadTask>
  // 取消任务
  cancelTask(taskId: string): Promise<boolean>
  // 获取所有任务
  getAllTasks(): Promise<DownloadTask[]>
  // 清理已完成任务
  clearCompletedTasks(): Promise<number>
}

// 声明模块扩展
declare module 'koishi' {
  interface Context {
    novelDownloader: DownloaderService
  }
}

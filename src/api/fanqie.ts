/**
 * 番茄小说API实现
 * 基于Tomato Gateway接口
 */

import { Context, Logger } from 'koishi'
import {
  NovelInfo,
  ChapterInfo,
  ChapterContent,
  SearchResult,
  PlatformApi,
  NovelPlatform
} from './types'

const logger = new Logger('novel-downloader/fanqie')

// 番茄小说API配置
const FANQIE_API = {
  // 搜索接口
  search: 'https://api5-normal-hl.fqnovel.com/reading/bookapi/search/',
  // 书籍详情
  bookInfo: 'https://api5-normal-hl.fqnovel.com/reading/bookapi/detail/',
  // 章节目录
  chapterList: 'https://api5-normal-hl.fqnovel.com/reading/bookapi/chapter/list/',
  // 章节内容
  chapterContent: 'https://api5-normal-hl.fqnovel.com/reading/bookapi/chapter/content/',
  // 备用网关
  gateway: 'https://tomato.7mudan.top/api'
}

// 请求头
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive'
}

export class FanqieApi implements PlatformApi {
  name = '番茄小说'
  platform: NovelPlatform = 'fanqie'
  
  private ctx: Context
  private timeout: number
  private useGateway: boolean = true

  constructor(ctx: Context, timeout: number = 30000) {
    this.ctx = ctx
    this.timeout = timeout
  }

  /**
   * 发送HTTP请求
   */
  private async request<T>(url: string, params: Record<string, any> = {}): Promise<T> {
    const queryString = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    ).toString()
    
    const fullUrl = queryString ? `${url}?${queryString}` : url
    
    try {
      const response = await this.ctx.http.get(fullUrl, {
        headers: DEFAULT_HEADERS,
        timeout: this.timeout
      })
      
      return response as T
    } catch (error) {
      logger.error(`请求失败: ${fullUrl}`, error)
      throw error
    }
  }

  /**
   * 搜索小说
   */
  async search(keyword: string, page: number = 1, pageSize: number = 20): Promise<SearchResult> {
    try {
      // 尝试使用备用网关
      if (this.useGateway) {
        return await this.searchViaGateway(keyword, page, pageSize)
      }

      const response = await this.request<any>(FANQIE_API.search, {
        query: keyword,
        page: page,
        size: pageSize
      })

      if (!response || !response.data) {
        return { novels: [], total: 0, page, pageSize }
      }

      const novels: NovelInfo[] = (response.data || []).map((item: any) => ({
        id: String(item.book_id || item.id),
        title: item.book_name || item.title || '',
        author: item.author || '未知',
        cover: item.thumb_url || item.cover,
        description: item.abstract || item.description,
        wordCount: item.word_count || item.wordCount,
        chapterCount: item.chapter_count || item.chapterCount,
        status: item.creation_status === 1 ? '连载中' : '已完结',
        platform: 'fanqie' as const,
        url: `https://fanqienovel.com/page/${item.book_id || item.id}`
      }))

      return {
        novels,
        total: response.total || novels.length,
        page,
        pageSize
      }
    } catch (error) {
      logger.error('搜索失败:', error)
      // 如果主API失败，尝试备用网关
      try {
        return await this.searchViaGateway(keyword, page, pageSize)
      } catch (gatewayError) {
        logger.error('备用网关也失败:', gatewayError)
        return { novels: [], total: 0, page, pageSize }
      }
    }
  }

  /**
   * 通过备用网关搜索
   */
  private async searchViaGateway(keyword: string, page: number, pageSize: number): Promise<SearchResult> {
    try {
      const response = await this.request<any>(`${FANQIE_API.gateway}/search`, {
        keyword,
        page,
        size: pageSize
      })

      if (!response || !response.data) {
        return { novels: [], total: 0, page, pageSize }
      }

      const novels: NovelInfo[] = (response.data || []).map((item: any) => ({
        id: String(item.book_id || item.id),
        title: item.book_name || item.title || '',
        author: item.author || '未知',
        cover: item.thumb_url || item.cover,
        description: item.abstract || item.description,
        wordCount: item.word_count || item.wordCount,
        chapterCount: item.chapter_count || item.chapterCount,
        status: item.creation_status === 1 ? '连载中' : '已完结',
        platform: 'fanqie' as const,
        url: `https://fanqienovel.com/page/${item.book_id || item.id}`
      }))

      return {
        novels,
        total: response.total || novels.length,
        page,
        pageSize
      }
    } catch (error) {
      logger.error('网关搜索失败:', error)
      throw error
    }
  }

  /**
   * 获取小说详情
   */
  async getNovelInfo(novelId: string): Promise<NovelInfo> {
    try {
      // 尝试备用网关
      if (this.useGateway) {
        return await this.getNovelInfoViaGateway(novelId)
      }

      const response = await this.request<any>(FANQIE_API.bookInfo, {
        book_id: novelId
      })

      if (!response || !response.data) {
        throw new Error('获取小说信息失败')
      }

      const item = response.data
      return {
        id: String(item.book_id),
        title: item.book_name || '',
        author: item.author || '未知',
        cover: item.thumb_url,
        description: item.abstract,
        wordCount: item.word_count,
        chapterCount: item.chapter_count,
        status: item.creation_status === 1 ? '连载中' : '已完结',
        platform: 'fanqie' as const,
        url: `https://fanqienovel.com/page/${item.book_id}`
      }
    } catch (error) {
      logger.error('获取小说详情失败:', error)
      try {
        return await this.getNovelInfoViaGateway(novelId)
      } catch (gatewayError) {
        throw new Error('获取小说信息失败')
      }
    }
  }

  /**
   * 通过备用网关获取小说详情
   */
  private async getNovelInfoViaGateway(novelId: string): Promise<NovelInfo> {
    const response = await this.request<any>(`${FANQIE_API.gateway}/book/${novelId}`)

    if (!response || !response.data) {
      throw new Error('获取小说信息失败')
    }

    const item = response.data
    return {
      id: String(item.book_id || item.id),
      title: item.book_name || item.title || '',
      author: item.author || '未知',
      cover: item.thumb_url || item.cover,
      description: item.abstract || item.description,
      wordCount: item.word_count || item.wordCount,
      chapterCount: item.chapter_count || item.chapterCount,
      status: item.creation_status === 1 ? '连载中' : '已完结',
      platform: 'fanqie' as const,
      url: `https://fanqienovel.com/page/${item.book_id || item.id}`
    }
  }

  /**
   * 获取章节列表
   */
  async getChapterList(novelId: string): Promise<ChapterInfo[]> {
    try {
      // 尝试备用网关
      if (this.useGateway) {
        return await this.getChapterListViaGateway(novelId)
      }

      const response = await this.request<any>(FANQIE_API.chapterList, {
        book_id: novelId,
        need_volume: 0
      })

      if (!response || !response.data) {
        return []
      }

      return (response.data || []).map((item: any, index: number) => ({
        id: String(item.chapter_id || item.id),
        title: item.title || item.chapter_name || `第${index + 1}章`,
        index: item.chapter_index || index,
        wordCount: item.word_count,
        isVip: item.is_vip === 1
      }))
    } catch (error) {
      logger.error('获取章节列表失败:', error)
      try {
        return await this.getChapterListViaGateway(novelId)
      } catch (gatewayError) {
        return []
      }
    }
  }

  /**
   * 通过备用网关获取章节列表
   */
  private async getChapterListViaGateway(novelId: string): Promise<ChapterInfo[]> {
    const response = await this.request<any>(`${FANQIE_API.gateway}/chapters/${novelId}`)

    if (!response || !response.data) {
      return []
    }

    return (response.data || []).map((item: any, index: number) => ({
      id: String(item.chapter_id || item.id),
      title: item.title || item.chapter_name || `第${index + 1}章`,
      index: item.chapter_index || index,
      wordCount: item.word_count,
      isVip: item.is_vip === 1
    }))
  }

  /**
   * 获取章节内容
   */
  async getChapterContent(novelId: string, chapterId: string): Promise<ChapterContent> {
    try {
      // 尝试备用网关
      if (this.useGateway) {
        return await this.getChapterContentViaGateway(novelId, chapterId)
      }

      const response = await this.request<any>(FANQIE_API.chapterContent, {
        book_id: novelId,
        chapter_id: chapterId,
        need_book_info: 0
      })

      if (!response || !response.data) {
        throw new Error('获取章节内容失败')
      }

      const item = response.data
      return {
        id: String(item.chapter_id),
        title: item.title || item.chapter_name || '',
        content: this.cleanContent(item.content || ''),
        index: item.chapter_index || 0
      }
    } catch (error) {
      logger.error('获取章节内容失败:', error)
      try {
        return await this.getChapterContentViaGateway(novelId, chapterId)
      } catch (gatewayError) {
        throw new Error('获取章节内容失败')
      }
    }
  }

  /**
   * 通过备用网关获取章节内容
   */
  private async getChapterContentViaGateway(novelId: string, chapterId: string): Promise<ChapterContent> {
    const response = await this.request<any>(`${FANQIE_API.gateway}/chapter/${novelId}/${chapterId}`)

    if (!response || !response.data) {
      throw new Error('获取章节内容失败')
    }

    const item = response.data
    return {
      id: String(item.chapter_id || item.id),
      title: item.title || item.chapter_name || '',
      content: this.cleanContent(item.content || ''),
      index: item.chapter_index || 0
    }
  }

  /**
   * 批量获取章节内容
   */
  async getChapterContents(novelId: string, chapterIds: string[]): Promise<ChapterContent[]> {
    const results: ChapterContent[] = []
    
    // 分批获取，避免请求过多
    const batchSize = 10
    for (let i = 0; i < chapterIds.length; i += batchSize) {
      const batch = chapterIds.slice(i, i + batchSize)
      const batchResults = await Promise.all(
        batch.map(id => this.getChapterContent(novelId, id).catch(err => {
          logger.warn(`获取章节 ${id} 失败:`, err)
          return null
        }))
      )
      results.push(...batchResults.filter(Boolean) as ChapterContent[])
    }
    
    return results
  }

  /**
   * 清理章节内容
   */
  private cleanContent(content: string): string {
    // 移除HTML标签
    content = content.replace(/<[^>]+>/g, '')
    // 移除特殊字符
    content = content.replace(/&nbsp;/g, ' ')
    content = content.replace(/&lt;/g, '<')
    content = content.replace(/&gt;/g, '>')
    content = content.replace(/&amp;/g, '&')
    content = content.replace(/&quot;/g, '"')
    // 移除多余空白
    content = content.replace(/\s+/g, ' ').trim()
    return content
  }

  /**
   * 从URL解析小说ID
   */
  static parseNovelId(url: string): string | null {
    // 支持多种URL格式
    // https://fanqienovel.com/page/123456
    // https://www.fanqienovel.com/page/123456
    // 123456 (直接ID)
    
    if (/^\d+$/.test(url)) {
      return url
    }
    
    const match = url.match(/fanqienovel\.com\/page\/(\d+)/)
    if (match) {
      return match[1]
    }
    
    return null
  }
}

import type { Context } from 'koishi'
import { setTimeout as sleep } from 'timers/promises'
import type { BookItem, FullConfig, Job, LibraryItem, Preview, ServiceStatus, TndConfig } from './types'

export class TndError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'TndError'
  }
}

/** 极简 TND 客户端：负责登录、鉴权、限流重试与全部接口调用。 */
export class TndApi {
  readonly base: string
  private cookie: string | null = null
  private loginPromise: Promise<boolean> | null = null
  private locked: boolean | null = null

  constructor(private ctx: Context, private config: TndConfig) {
    this.base = config.apiBase.replace(/\/+$/, '')
  }

  private logDebug(...args: any[]) {
    if (this.config.debug) this.ctx.logger.debug('[tnd]', ...args)
  }

  get authed() {
    return !!this.cookie
  }

  /** 登录；并发调用共享同一个 Promise，避免重复打登录接口。 */
  async login(): Promise<boolean> {
    if (this.cookie) return true
    if (!this.config.apiPassword) {
      // 服务端未加锁时不需要 Cookie
      this.cookie = ''
      return true
    }
    if (this.loginPromise) return this.loginPromise
    this.loginPromise = (async () => {
      try {
        const res = await fetch(`${this.base}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: this.config.apiPassword }),
          signal: AbortSignal.timeout(15000),
        })
        if (res.status !== 200) {
          this.ctx.logger.error('TND 登录失败: %d', res.status)
          return false
        }
        const setCookies = res.headers.getSetCookie?.() || []
        const single = res.headers.get('set-cookie')
        this.cookie = setCookies.length
          ? setCookies.map((c) => c.split(';')[0]).join('; ')
          : single
            ? single.split(';')[0]
            : ''
        this.ctx.logger.debug('TND 登录成功，cookie=%s', this.cookie ? '有' : '无')
        return true
      } catch (e: any) {
        this.ctx.logger.error('TND 登录异常: %s', e.message)
        return false
      } finally {
        this.loginPromise = null
      }
    })()
    return this.loginPromise
  }

  private headers(extra?: HeadersInit): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.cookie) headers.Cookie = this.cookie
    return { ...headers, ...(extra as Record<string, string> || {}) }
  }

  /** 带重试的请求：401 重新登录一次，429 按 Retry-After 等待。 */
  async request(path: string, init: RequestInit = {}, retry = 2): Promise<Response> {
    if (this.cookie === null) await this.login()
    if (process.env.TRACE_API) console.log('[api]', init.method || 'GET', path, 'cookie=' + JSON.stringify(this.cookie))
    const res = await fetch(this.base + path, {
      ...init,
      headers: this.headers(init.headers),
      signal: init.signal ?? AbortSignal.timeout(30000),
    })
    if (res.status === 401 && retry > 0) {
      if (!this.config.apiPassword) {
        this.ctx.logger.warn('TND 返回 401：服务端可能已加锁，请在配置里填写 apiPassword')
        this.cookie = null
        if (!(await this.login())) throw new TndError('TND 未授权：服务端已加锁，请配置 apiPassword', 401)
        return this.request(path, init, retry - 1)
      }
      this.ctx.logger.warn('TND Cookie 失效，重新登录')
      this.cookie = null
      if (!(await this.login())) throw new TndError('TND 登录失败（401）', 401)
      return this.request(path, init, retry - 1)
    }
    if (res.status === 429 && (retry > 0 || retry === 0)) {
      const wait = Math.min(parseInt(res.headers.get('Retry-After') || '15', 10) || 15, 60)
      this.ctx.logger.warn('TND 限流，等待 %ds', wait)
      await sleep(wait * 1000)
      return this.request(path, init, Math.max(retry - 1, 0))
    }
    return res
  }

  private async json<T>(path: string, init?: RequestInit, retry = 2): Promise<T> {
    const res = await this.request(path, init, retry)
    if (!res.ok) throw new TndError(`TND 接口 ${path} 返回 ${res.status}`, res.status)
    return (await res.json()) as T
  }

  async status(): Promise<ServiceStatus> {
    return this.json<ServiceStatus>('/api/status')
  }

  async fullConfig(): Promise<FullConfig> {
    return this.json<FullConfig>('/api/config/full')
  }

  async search(keyword: string): Promise<BookItem[]> {
    const data = await this.json<{ items?: any[] }>(`/api/search?q=${encodeURIComponent(keyword)}`)
    return (data.items || []).map((item) => ({
      book_id: String(item.book_id),
      title: String(item.book_name || item.title || ''),
      author: item.author ? String(item.author) : undefined,
    }))
  }

  async preview(bookId: string): Promise<Preview> {
    return this.json<Preview>(`/api/preview/${encodeURIComponent(bookId)}`)
  }

  async createJob(bookId: string, range?: { start: number; end: number }): Promise<Job> {
    const payload: Record<string, unknown> = { book_id: bookId }
    if (range) {
      payload.range_start = range.start
      payload.range_end = range.end
    }
    const job = await this.json<Job>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    if (!job?.id) throw new TndError('创建任务失败：服务端未返回任务 ID')
    return job
  }

  async listJobs(): Promise<Job[]> {
    const data = await this.json<{ items?: Job[] }>('/api/jobs')
    return data.items || []
  }

  async findJob(id: number): Promise<Job | undefined> {
    return (await this.listJobs()).find((job) => job.id === id)
  }

  async chooseBookName(id: number, value: string) {
    await this._post(`/api/jobs/${id}/book_name`, { value })
  }

  async chooseFormat(id: number, value: string) {
    await this._post(`/api/jobs/${id}/format`, { value })
  }

  async cancelJob(id: number) {
    await this._post(`/api/jobs/${id}/cancel`, {})
  }

  async deleteJob(id: number) {
    await this.request(`/api/jobs/${id}`, { method: 'DELETE' })
  }

  private async _post(path: string, body: unknown) {
    const res = await this.request(path, { method: 'POST', body: JSON.stringify(body) })
    if (!res.ok) throw new TndError(`TND 接口 ${path} 返回 ${res.status}`, res.status)
  }

  async library(path = '', start = false): Promise<LibraryItem[]> {
    const qs = new URLSearchParams()
    if (path) qs.set('path', path)
    qs.set('start', start ? 'true' : 'false')
    const data = await this.json<{ items?: LibraryItem[]; running?: boolean }>(`/api/library?${qs}`)
    return data.items || []
  }

  downloadUrl(rel: string) {
    return `${this.base}/download/${encodePathSegments(rel)}`
  }

  zipUrl(rel: string) {
    return `${this.base}/download-zip/${encodePathSegments(rel)}`
  }

  /** 服务端是否允许匿名下载（未加锁）；结果缓存 5 分钟。 */
  async canAnonymous(): Promise<boolean> {
    if (this.locked === false) return true
    try {
      const status = await this.status()
      this.locked = !!status.locked
      return !this.locked
    } catch {
      return !this.config.apiPassword
    }
  }

  /** 原始下载请求（保留鉴权信息）。 */
  async download(rel: string, zipped = false): Promise<Response> {
    const path = `${zipped ? '/download-zip' : '/download'}/${encodePathSegments(rel)}`
    const res = await this.request(path, {
      headers: { 'Content-Type': undefined as any },
      signal: AbortSignal.timeout(180000),
    })
    if (!res.ok) throw new TndError(`下载文件失败 ${res.status}`, res.status)
    return res
  }
}

export function encodePathSegments(rel: string) {
  return rel.split('/').map((seg) => encodeURIComponent(seg)).join('/')
}

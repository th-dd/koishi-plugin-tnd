import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { Context } from 'koishi'
import { h } from 'koishi'
import { setTimeout as sleep } from 'timers/promises'
import type { TndApi } from './api'
import type { TndConfig } from './types'
import { responseMode } from './render'

export function sanitizeFileName(name: string) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'novel'
}

type Mode = 'url' | 'file' | 'base64'

async function downloadToTemp(api: TndApi, rel: string, fileName: string, zipped: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'tnd-'))
  try {
    const file = join(dir, `${randomUUID()}-${fileName}`)
    const res = await api.download(rel, zipped)
    if (!res.body) throw new Error('下载响应为空')
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(file))
    return { file, cleanup: () => rm(dir, { recursive: true, force: true }) }
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw e
  }
}

/** 文件发送：按传输模式依次尝试，OneBot 优先走 internal 上传接口（不经 base64）。 */
export async function sendNovelFile(
  ctx: Context,
  session: any,
  api: TndApi,
  rel: string,
  fileName: string,
  config: TndConfig,
  options: { zipped?: boolean; sizeText?: string } = {},
): Promise<any> {
  const name = sanitizeFileName(fileName)
  const zipped = !!options.zipped
  const bot: any = session.bot
  const internal = bot?.internal
  const canUploadDirectly = responseMode(session) === 'onebot'
    && typeof internal?.uploadGroupFile === 'function'
    && typeof internal?.uploadPrivateFile === 'function'

  // auto：能匿名取直链就优先直链（省流量），再退临时文件，最后退 base64（宿主读不到本地路径时可用）
  let modes: Mode[]
  if (config.transferMode === 'auto') {
    const anonymous = await api.canAnonymous()
    if (anonymous) modes = canUploadDirectly ? ['url', 'file', 'base64'] : ['url', 'file']
    else modes = ['file', 'base64']
  } else {
    modes = [config.transferMode]
  }

  const log = config.debug ? ctx.logger.info.bind(ctx.logger) : ctx.logger.debug.bind(ctx.logger)
  let lastError: any
  for (const mode of modes) {
    for (let attempt = 0; attempt < Math.max(config.fileSendMaxRetries, 1); attempt++) {
      if (attempt > 0) await sleep(2000 * attempt)
      let cleanup: (() => Promise<void>) | undefined
      try {
        const url = zipped ? api.zipUrl(rel) : api.downloadUrl(rel)
        if (!canUploadDirectly) {
          // 其他适配器交给 h.file 处理，文件名走 title 属性。
          // 必须返回 Element 本身：串成字符串会被当纯文本发送，base64 直接超长。
          if (mode === 'url') return h.file(url, { title: name })
          const res = await api.download(rel, zipped)
          const buffer = Buffer.from(await res.arrayBuffer())
          return h.file(buffer, 'text/plain', { title: name })
        }

        const target = session.isDirect ? String(session.userId) : String(session.channelId)
        const upload = (file: string) =>
          session.isDirect
            ? internal.uploadPrivateFile(target, file, name)
            : internal.uploadGroupFile(target, file, name)

        if (mode === 'url') {
          await upload(url)
        } else if (mode === 'base64') {
          const res = await api.download(rel, zipped)
          await upload('base64://' + Buffer.from(await res.arrayBuffer()).toString('base64'))
        } else {
          const temp = await downloadToTemp(api, rel, name, zipped)
          cleanup = temp.cleanup
          await upload(temp.file)
        }
        log('[tnd] 文件已发送 %s (mode=%s)', name, mode)
        return `✅ 文件「${name}」已发送${zipped ? '（压缩包，' : '（'}大小 ${options.sizeText || '未知'}）`
      } catch (e: any) {
        lastError = e
        log('[tnd] 发送失败 (%s, %d/%d): %s', mode, attempt + 1, config.fileSendMaxRetries, e.message)
      } finally {
        await cleanup?.().catch(() => {})
      }
    }
  }
  throw new Error(lastError?.message || '文件发送失败')
}

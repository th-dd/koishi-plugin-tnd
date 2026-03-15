/**
 * Koishi 小说下载插件
 * 支持番茄小说等平台的TXT格式电子书下载
 * 
 * @author Qingyan Agent
 * @version 1.0.0
 */

import { Context, Schema, h, Logger, Session } from 'koishi'
import { NovelDownloadService } from './services/downloader'
import { Config, NovelDownloaderConfig, defaultConfig, NovelPlatform, NovelInfo } from './api/types'

const logger = new Logger('novel-downloader')

// 导出配置Schema
export { Config }

// 声明插件名称
export const name = 'novel-downloader'

// 声明插件可注入的服务
export const inject = ['http']

// 插件主函数
export function apply(ctx: Context, config: NovelDownloaderConfig) {
  // 合并默认配置
  const finalConfig = { ...defaultConfig, ...config }
  
  // 初始化下载服务
  const downloadService = new NovelDownloadService(ctx, finalConfig)
  
  // 注册服务到上下文
  ctx.novelDownloader = downloadService as any

  logger.info('小说下载插件已启动')

  // ==================== 命令注册 ====================

  /**
   * 小说搜索命令
   * 用法: novel.search <关键词>
   */
  ctx.command('novel.search <keyword:text>', '搜索小说')
    .alias('小说搜索')
    .alias('n搜索')
    .option('page', '-p <page:number> 页码', { fallback: 1 })
    .option('platform', '-t <platform> 平台(fanqie)', { fallback: 'fanqie' })
    .action(async ({ session, options }, keyword) => {
      if (!keyword) {
        return '请输入搜索关键词，例如: novel.search 斗破苍穹'
      }

      await session.send(`正在搜索 "${keyword}"，请稍候...`)

      try {
        const result = await downloadService.search(
          keyword,
          options.platform as NovelPlatform,
          options.page
        )

        if (result.novels.length === 0) {
          return '未找到相关小说，请尝试其他关键词。'
        }

        const lines: string[] = []
        lines.push(`📚 搜索结果 (第${options.page}页，共${result.total}部)`)
        lines.push('─'.repeat(30))

        result.novels.slice(0, 10).forEach((novel, index) => {
          const status = novel.status === '已完结' ? '✅' : '📖'
          const words = novel.wordCount ? `${(novel.wordCount / 10000).toFixed(1)}万字` : ''
          lines.push(`${index + 1}. ${status}《${novel.title}》`)
          lines.push(`   作者: ${novel.author} ${words ? `| ${words}` : ''}`)
          lines.push(`   ID: ${novel.id}`)
        })

        lines.push('─'.repeat(30))
        lines.push('💡 使用 novel.info <ID> 查看详情')
        lines.push('💡 使用 novel.download <ID> 下载小说')

        return lines.join('\n')
      } catch (error) {
        logger.error('搜索失败:', error)
        return `搜索失败: ${error.message}`
      }
    })

  /**
   * 小说详情命令
   * 用法: novel.info <小说ID>
   */
  ctx.command('novel.info <id:string>', '查看小说详情')
    .alias('小说详情')
    .alias('n详情')
    .option('platform', '-t <platform> 平台', { fallback: 'fanqie' })
    .action(async ({ session, options }, id) => {
      if (!id) {
        return '请输入小说ID，例如: novel.info 7143038691944959011'
      }

      // 尝试解析URL
      const novelId = downloadService.parseNovelId(id) || id

      await session.send('正在获取小说信息...')

      try {
        const novel = await downloadService.getNovelInfo(novelId)

        const lines: string[] = []
        lines.push('📖 小说详情')
        lines.push('═'.repeat(30))
        lines.push(`书名: 《${novel.title}》`)
        lines.push(`作者: ${novel.author}`)
        lines.push(`状态: ${novel.status || '未知'}`)
        
        if (novel.wordCount) {
          lines.push(`字数: ${(novel.wordCount / 10000).toFixed(1)}万字`)
        }
        
        if (novel.chapterCount) {
          lines.push(`章节: ${novel.chapterCount}章`)
        }

        if (novel.description) {
          lines.push('─'.repeat(30))
          lines.push('简介:')
          // 截断过长的简介
          const desc = novel.description.length > 200 
            ? novel.description.substring(0, 200) + '...' 
            : novel.description
          lines.push(desc)
        }

        lines.push('─'.repeat(30))
        lines.push(`ID: ${novel.id}`)
        lines.push('💡 使用 novel.download ' + novel.id + ' 下载')

        return lines.join('\n')
      } catch (error) {
        logger.error('获取详情失败:', error)
        return `获取详情失败: ${error.message}`
      }
    })

  /**
   * 小说下载命令
   * 用法: novel.download <小说ID>
   */
  ctx.command('novel.download <id:string>', '下载小说')
    .alias('小说下载')
    .alias('n下载')
    .option('platform', '-t <platform> 平台', { fallback: 'fanqie' })
    .option('format', '-f <format> 格式(txt/epub)', { fallback: finalConfig.defaultFormat })
    .option('encoding', '-e <encoding> 编码(utf-8/gbk)', { fallback: finalConfig.defaultEncoding })
    .option('start', '-s <start:number> 起始章节', { fallback: 1 })
    .option('end', '-d <end:number> 结束章节', { fallback: 0 })
    .action(async ({ session, options }, id) => {
      if (!id) {
        return '请输入小说ID，例如: novel.download 7143038691944949011'
      }

      // 尝试解析URL
      const novelId = downloadService.parseNovelId(id) || id

      try {
        // 先获取小说信息
        const novel = await downloadService.getNovelInfo(novelId)
        
        // 确认下载
        const chapterInfo = options.end > 0 
          ? `第${options.start}-${options.end}章`
          : '全部章节'
        
        await session.send(
          `即将下载《${novel.title}》(${chapterInfo})\n` +
          `格式: ${options.format} | 编码: ${options.encoding}\n` +
          `正在开始下载...`
        )

        // 创建下载任务
        const downloadOptions: any = {
          format: options.format,
          encoding: options.encoding
        }

        if (options.end > 0) {
          downloadOptions.chapterRange = {
            start: options.start,
            end: options.end
          }
        }

        const task = await downloadService.createTask(
          novelId,
          options.platform as NovelPlatform,
          downloadOptions
        )

        // 等待下载完成或定期更新进度
        let lastProgress = 0
        const maxWaitTime = 10 * 60 * 1000 // 最多等待10分钟
        const startTime = Date.now()

        while (true) {
          const currentTask = await downloadService.getTaskStatus(task.id)
          
          if (!currentTask) {
            return '下载任务丢失，请重试。'
          }

          if (currentTask.status === 'completed') {
            return (
              `✅ 下载完成！\n` +
              `书名: 《${novel.title}》\n` +
              `章节: ${currentTask.downloadedChapters}/${currentTask.totalChapters}\n` +
              `文件: ${currentTask.filePath}\n` +
              `💡 文件已保存到服务器，请联系管理员获取。`
            )
          }

          if (currentTask.status === 'failed') {
            return `❌ 下载失败: ${currentTask.error}`
          }

          // 更新进度
          if (currentTask.progress > lastProgress + 10) {
            await session.send(
              `📥 下载中... ${currentTask.progress}%\n` +
              `已下载: ${currentTask.downloadedChapters}/${currentTask.totalChapters}章`
            )
            lastProgress = currentTask.progress
          }

          // 检查超时
          if (Date.now() - startTime > maxWaitTime) {
            return '下载超时，任务仍在后台进行。请稍后使用 novel.tasks 查看状态。'
          }

          // 等待一段时间再检查
          await new Promise(resolve => setTimeout(resolve, 2000))
        }
      } catch (error) {
        logger.error('下载失败:', error)
        return `下载失败: ${error.message}`
      }
    })

  /**
   * 查看下载任务命令
   */
  ctx.command('novel.tasks', '查看下载任务')
    .alias('小说任务')
    .alias('n任务')
    .action(async ({ session }) => {
      const tasks = await downloadService.getAllTasks()

      if (tasks.length === 0) {
        return '暂无下载任务。'
      }

      const lines: string[] = []
      lines.push('📋 下载任务列表')
      lines.push('─'.repeat(30))

      tasks.slice(-10).reverse().forEach((task, index) => {
        const statusMap: Record<string, string> = {
          pending: '⏳ 等待中',
          downloading: `📥 下载中 ${task.progress}%`,
          completed: '✅ 已完成',
          failed: '❌ 失败'
        }
        
        lines.push(`${index + 1}. 《${task.title}》`)
        lines.push(`   状态: ${statusMap[task.status] || task.status}`)
        
        if (task.status === 'downloading') {
          lines.push(`   进度: ${task.downloadedChapters}/${task.totalChapters}章`)
        }
        
        if (task.error) {
          lines.push(`   错误: ${task.error}`)
        }
        
        lines.push(`   ID: ${task.id}`)
      })

      return lines.join('\n')
    })

  /**
   * 清理任务命令
   */
  ctx.command('novel.clear', '清理已完成任务')
    .alias('小说清理')
    .action(async ({ session }) => {
      const count = await downloadService.clearCompletedTasks()
      return `已清理 ${count} 个已完成任务。`
    })

  /**
   * 帮助命令
   */
  ctx.command('novel', '小说下载插件')
    .alias('小说')
    .action(({ session }) => {
      const lines: string[] = []
      lines.push('📚 小说下载插件帮助')
      lines.push('═'.repeat(30))
      lines.push('')
      lines.push('可用命令:')
      lines.push('  novel.search <关键词>  - 搜索小说')
      lines.push('  novel.info <ID>        - 查看小说详情')
      lines.push('  novel.download <ID>    - 下载小说')
      lines.push('  novel.tasks            - 查看下载任务')
      lines.push('  novel.clear            - 清理已完成任务')
      lines.push('')
      lines.push('下载选项:')
      lines.push('  -f <格式>    txt 或 epub')
      lines.push('  -e <编码>    utf-8 或 gbk')
      lines.push('  -s <章节>    起始章节')
      lines.push('  -d <章节>    结束章节')
      lines.push('')
      lines.push('示例:')
      lines.push('  novel.search 斗破苍穹')
      lines.push('  novel.download 7143038691944949011')
      lines.push('  novel.download 7143038691944949011 -f epub')
      lines.push('  novel.download 7143038691944949011 -s 1 -d 100')
      
      return lines.join('\n')
    })

  // 快捷命令别名
  ctx.command('n', '小说下载快捷命令')
    .action(({ session }) => {
      return '请使用 novel 命令查看帮助，或直接使用:\n' +
             'n搜索 <关键词> - 搜索小说\n' +
             'n详情 <ID> - 查看详情\n' +
             'n下载 <ID> - 下载小说'
    })
}

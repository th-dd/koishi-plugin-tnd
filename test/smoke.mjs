import assert from 'node:assert'
import { stat } from 'node:fs/promises'
import { TndApi } from '../lib/api.js'
import { sendNovelFile } from '../lib/transfer.js'
import { splitText, textResult } from '../lib/render.js'

const config = {
  apiBase: 'https://tnd.th-dd.top',
  apiPassword: '',
  maxSearchResults: 5,
  initialWait: 1000,
  pollInterval: 1500,
  jobTimeout: 120000,
  fileSendMaxRetries: 2,
  transferMode: 'file',
  cleanupJob: true,
  cooldown: 0,
  maxConcurrentJobs: 3,
  maxTextLength: 500,
  enableImage: false,
  imageWidth: 800,
  debug: true,
}
const ctx = {
  logger: {
    debug: (...a) => console.log('  [debug]', ...a),
    warn: (...a) => console.log('  [warn]', ...a),
    error: (...a) => console.log('  [error]', ...a),
    info: (...a) => console.log('  [info]', ...a),
  },
  puppeteer: undefined,
}

const api = new TndApi(ctx, config)

console.log('1. search')
const items = await api.search('斗破')
assert.ok(items.length > 0, 'search 无结果')
assert.ok(items.every((i) => /^\d+$/.test(i.book_id) && i.title), '搜索结果字段缺失')
console.log('   ok', items.length, '条，首条:', items[0].title)

console.log('2. preview')
const preview = await api.preview(items[0].book_id)
assert.ok(preview.book_name, 'preview 缺书名')
console.log('   ok', preview.book_name, preview.chapter_count, '章')

console.log('3. create small job (1-3)')
const job = await api.createJob(preview.book_id, { start: 1, end: 3 })
assert.ok(job.id, '未返回 job.id')
console.log('   ok job', job.id, job.state)

console.log('4. poll')
let finished
const deadline = Date.now() + 120000
while (Date.now() < deadline) {
  const current = await api.findJob(job.id)
  if (current && ['done', 'failed', 'canceled'].includes(current.state)) { finished = current; break }
  await new Promise((r) => setTimeout(r, 1500))
}
assert.ok(finished, '任务未在超时内结束')
assert.strictEqual(finished.state, 'done', '任务失败: ' + finished.message)
console.log('   ok done', JSON.stringify(finished.progress))

console.log('5. locate in library')
let found
let firstScan = true
const scanDeadline = Date.now() + 90000
while (Date.now() < scanDeadline && !found) {
  const entries = await api.library('', firstScan)
  firstScan = false
  found = entries.find((e) => e.kind === 'file' && e.name.startsWith(preview.book_name))
  if (!found) await new Promise((r) => setTimeout(r, 2000))
}
assert.ok(found, '目录里没找到产物')
console.log('   ok', found.rel_path, found.size)

console.log('6. transfer (temp file -> fake upload)')
const uploads = []
const session = {
  platform: 'onebot',
  isDirect: true,
  userId: '10001',
  channelId: 'private:10001',
  bot: {
    internal: {
      uploadPrivateFile: async (target, file, name) => { uploads.push({ target, file, name }); await stat(file) },
      uploadGroupFile: async (target, file, name) => { uploads.push({ target, file, name }); await stat(file) },
    },
  },
}
const message = await sendNovelFile(ctx, session, api, found.rel_path, '测试书籍.txt', config)
assert.strictEqual(uploads.length, 1, '未调用上传接口')
assert.strictEqual(uploads[0].target, '10001')
assert.strictEqual(uploads[0].name, '测试书籍.txt')
assert.ok(uploads[0].file.includes('tnd-'), '临时文件路径异常')
console.log('   ok', message)

console.log('7. anonymous url mode')
assert.strictEqual(await api.canAnonymous(), true, '匿名下载检测失败')

console.log('8. text helpers')
assert.deepStrictEqual(splitText('a'.repeat(1200), 500).map((s) => s.length), [500, 500, 200])
const rendered = textResult(items, '斗破', 2)
assert.ok(rendered.includes('斗破') && !rendered.includes('3. '), 'textResult 截断异常')

console.log('9. cleanup job')
if (config.cleanupJob) await api.deleteJob(job.id)
assert.strictEqual(await api.findJob(job.id), undefined)
console.log('   ok')

console.log('\nALL PASSED')

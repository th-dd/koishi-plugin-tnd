const assert = require('node:assert')
const http = require('node:http')
const { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { App } = require('koishi')
const mockMod = require('@koishijs/plugin-mock')
const mock = mockMod.default || mockMod
const plugin = require('../lib/index.js')
const transferMod = require('../lib/transfer.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SAVE_DIR = mkdtempSync(join(tmpdir(), 'tnd-save-'))
const LOCKED = { password: '' }
const uploads = []
const cancels = []

const BOOKS = {
  '7000000000000000001': { title: '测试小说甲', chapters: 30, behaviour: 'ok' },
  '7000000000000000002': { title: '测试小说乙', chapters: 12, behaviour: 'ok' },
  '7000000000000000099': { title: '失败的测试书', chapters: 5, behaviour: 'fail' },
  '7000000000000000098': { title: '卡住的测试书', chapters: 5, behaviour: 'stall' },
  '7000000000000000097': { title: '散装的测试书', chapters: 4, behaviour: 'bulk' },
  '7000000000000000096': { title: '要选格式的测试书', chapters: 4, behaviour: 'ask' },
}

let jobSeq = 0
const jobs = new Map()
const chosen = []

function search(q) {
  return Object.entries(BOOKS)
    .filter(([, b]) => b.title.includes('测试'))
    .map(([id, b]) => ({ book_id: id, book_name: b.title, author: '测试作者' }))
    .filter(() => !q || true)
}

function jobView(job) {
  const book = BOOKS[job.book_id] || {}
  return {
    id: job.id,
    book_id: job.book_id,
    title: book.title,
    state: job.state,
    message: job.message || null,
    created_ms: job.created_ms,
    progress: job.progress,
    book_name_options: job.book_name_options || null,
    format_options: job.format_options || null,
  }
}

function advance(job) {
  const book = BOOKS[job.book_id] || {}
  if (job.state === 'canceled') return
  if (book.behaviour === 'stall') {
    job.progress.saved_chapters = 1
    return
  }
  if (book.behaviour === 'fail') {
    job.state = 'failed'
    job.message = '风控校验失败'
    return
  }
  if (book.behaviour === 'ask' && !job.format_answer) {
    job.format_options = [
      { label: 'txt', value: 'txt' },
      { label: 'epub', value: 'epub' },
    ]
    job.state = 'running'
    return
  }
  const total = job.progress.chapter_total
  job.progress.saved_chapters = Math.min(total, job.progress.saved_chapters + Math.ceil(total / 3))
  job.state = job.progress.saved_chapters >= total ? 'done' : 'running'
  if (job.state === 'done') {
    const name = job.format_answer === 'epub' ? book.title + '.epub' : book.title + '.txt'
    if (book.behaviour === 'bulk') {
      require('node:fs').mkdirSync(join(SAVE_DIR, book.title), { recursive: true })
      writeFileSync(join(SAVE_DIR, book.title, '第1章.txt'), 'chapter')
      job.kind = 'dir'
      job.out = book.title
    } else {
      writeFileSync(join(SAVE_DIR, name), 'content-'.repeat(200))
      job.out = name
    }
  }
}

const ticker = setInterval(() => { for (const job of jobs.values()) advance(job) }, 120)

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = decodeURIComponent(url.pathname.replace(/\/+$/, '') || '/')
  const authed = !LOCKED.password || (req.headers.cookie || '').includes('tnd=ok')

  try {
    if (path === '/api/login' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      const password = JSON.parse(body || '{}').password
      if (password !== LOCKED.password) { if (process.env.TRACE) console.log('  login fail', JSON.stringify(password)); return send(res, 401, { ok: false }) }
      if (process.env.TRACE) console.log('  login ok')
      return send(res, 200, { ok: true, locked: true }, { 'set-cookie': 'tnd=ok; Path=/; HttpOnly' })
    }
    if (path === '/api/status') return send(res, 200, { locked: !!LOCKED.password, save_dir: SAVE_DIR, version: 'test' })
    if (path === '/api/config/full') return send(res, 200, { save_path: '', novel_format: 'txt' })
    if (!authed) { if (process.env.TRACE) console.log('  401', req.method, path, 'cookie=', req.headers.cookie || '(none)', 'need=', JSON.stringify(LOCKED.password)); return send(res, 401, { error: 'locked' }) }

    if (path === '/api/search') return send(res, 200, { items: search(url.searchParams.get('q') || '') })
    const previewMatch = path.match(/^\/api\/preview\/(\d+)$/)
    if (previewMatch) {
      const book = BOOKS[previewMatch[1]]
      if (!book) return send(res, 404, { error: 'not found' })
      return send(res, 200, {
        book_id: previewMatch[1], book_name: book.title, author: '测试作者', category: '测试',
        description: '这是一本用于本地测试的小说。', chapter_count: book.chapters, word_count: 30000, finished: true, score: 8.5,
      })
    }
    if (path === '/api/jobs' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      const payload = JSON.parse(body || '{}')
      const book = BOOKS[payload.book_id]
      if (!book) return send(res, 400, { error: 'bad book' })
      const start = payload.range_start || 1
      const end = payload.range_end || book.chapters
      const job = {
        id: ++jobSeq, book_id: payload.book_id, state: 'queued', created_ms: Date.now(),
        progress: { saved_chapters: 0, chapter_total: end - start + 1 },
      }
      jobs.set(job.id, job)
      return send(res, 200, { book_id: job.book_id, id: job.id, state: job.state })
    }
    if (path === '/api/jobs' && req.method === 'GET') return send(res, 200, { items: [...jobs.values()].map(jobView) })
    const actionMatch = path.match(/^\/api\/jobs\/(\d+)\/(cancel|book_name|format)$/)
    if (actionMatch) {
      const job = jobs.get(Number(actionMatch[1]))
      if (!job) return send(res, 404, {})
      let body = ''
      for await (const chunk of req) body += chunk
      const value = JSON.parse(body || '{}').value
      if (actionMatch[2] === 'cancel') { job.state = 'canceled'; cancels.push(job.id) }
      if (actionMatch[2] === 'format') { job.format_answer = value; chosen.push(value) }
      return send(res, 200, { ok: true })
    }
    const jobMatch = path.match(/^\/api\/jobs\/(\d+)$/)
    if (jobMatch) {
      if (req.method === 'DELETE') { jobs.delete(Number(jobMatch[1])); return send(res, 200, { ok: true }) }
      return send(res, 405, {})
    }
    if (path === '/api/library') {
      const rel = url.searchParams.get('path') || ''
      const dir = rel ? join(SAVE_DIR, rel) : SAVE_DIR
      let items = []
      try {
        items = readdirSync(dir, { withFileTypes: true }).map((entry) => {
          const full = join(dir, entry.name)
          let size = 0
          try { size = require('node:fs').statSync(full).size } catch {}
          return {
            kind: entry.isDirectory() ? 'dir' : 'file',
            name: entry.name,
            rel_path: rel ? rel + '/' + entry.name : entry.name,
            modified_ms: Date.now(),
            size,
          }
        })
      } catch { items = [] }
      return send(res, 200, { items, running: false, scanned: items.length })
    }
    const dl = path.match(/^\/download(-zip)?\/(.+)$/)
    if (dl) {
      const file = join(SAVE_DIR, dl[2])
      try {
        const data = readFileSync(file)
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="x"' })
        return res.end(data)
      } catch {
        try {
          const entries = readdirSync(file)
          res.writeHead(200, { 'content-type': 'application/zip' })
          return res.end(Buffer.from(entries.join(',')))
        } catch { return send(res, 404, {}) }
      }
    }
    return send(res, 404, { error: 'unknown ' + path })
  } catch (e) {
    return send(res, 500, { error: String(e) })
  }
})

function makeApp(overrides = {}) {
  const app = new App()
  app.plugin(mock)
  const config = {
    apiBase: '', apiPassword: '', maxSearchResults: 5, initialWait: 150, pollInterval: 120,
    jobTimeout: 15000, fileSendMaxRetries: 2, transferMode: 'auto', cleanupJob: true, quickDownload: true,
    cooldown: 0, maxConcurrentJobs: 3, maxTextLength: 500, enableImage: false, imageWidth: 800, debug: false,
    ...overrides,
  }
  return { app, config }
}

async function boot(overrides = {}) {
  const { app, config } = makeApp(overrides)
  await app.start()
  const bot = app.bots[0]
  bot.platform = 'onebot'
  bot.internal = {
    uploadPrivateFile: async (target, file, name) => { uploads.push({ target, file, name, direct: true }) },
    uploadGroupFile: async (target, file, name) => { uploads.push({ target, file, name, direct: false }) },
  }
  const client = app.mock.client('10001')
  client.event.platform = 'onebot'
  const second = app.mock.client('10001', '777')
  second.event.platform = 'onebot'
  const plain = app.mock.client('10001')
  app.plugin(plugin, { ...config, apiBase: server.base })
  await app.start()
  return { app, client, second, plain }
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  server.base = 'http://127.0.0.1:' + server.address().port

  console.log('1. 搜索（走插件命令）')
  const a = await boot()
  let replies = await a.client.receive('tnd 搜索 测试')
  assert.ok(replies.some((r) => r.includes('搜索「测试」')), '搜索没有返回结果: ' + replies)
  assert.ok(replies.every((r) => r.length <= 600), '文本未按 maxTextLength 分片')

  console.log('2. 预览')
  replies = await a.client.receive('tnd 预览 1')
  assert.ok(replies.join('').includes('测试小说甲'), '预览内容缺失')
  assert.ok(replies.join('').includes('章节：30'))
  assert.ok(replies.join('').includes('字数：30000'), '预览没显示字数')

  console.log('3. 非法序号')
  const fresh = await boot()
  replies = await fresh.client.receive('tnd 下载 3')
  assert.ok(replies.join('').includes('先使用 tnd 搜索'))

  console.log('4. 按序号下载（未加锁 → auto 走直链）')
  uploads.length = 0
  replies = await a.client.receive('tnd 下载 1 --range 1-2')
  assert.strictEqual(uploads.length, 1, '未上传: ' + replies)
  assert.strictEqual(uploads[0].name, '测试小说甲.txt')
  assert.ok(uploads[0].target === '10001' && uploads[0].direct, '私聊目标错误')
  assert.match(uploads[0].file, /^http:\/\/127\.0\.0\.1:\d+\/download\//, '未走直链模式: ' + uploads[0].file)
  const urlBody = await (await fetch(uploads[0].file)).text()
  assert.ok(urlBody.startsWith('content-'), '直链内容不可取')
  assert.match(replies.join('\n'), /(B|KB|MB)/, '完成提示没带文件大小: ' + replies.join(' | '))

  console.log('4b. 通用适配器（非 OneBot）走 h.file')
  uploads.length = 0
  replies = await fresh.plain.receive('tnd 搜索 测试')
  replies = await fresh.plain.receive('tnd 下载 1 --range 1-1')
  assert.strictEqual(uploads.length, 0, '通用适配器不该调用 internal')
  const element = replies.join('')
  assert.ok(element.includes('<file') && element.includes('title="测试小说甲.txt"'), 'h.file 元素异常: ' + element.slice(0, 200))

  console.log('5. 按 book_id 下载（P0 修复点）')
  uploads.length = 0
  replies = await fresh.client.receive('tnd 下载 7000000000000000002 --range 1-1')
  assert.strictEqual(uploads.length, 1, 'book_id 下载失败: ' + replies)
  assert.strictEqual(uploads[0].name, '测试小说乙.txt')

  console.log('6. 加锁服务 + 密码（应走临时文件）')
  const locked = await boot({ apiPassword: 'secret' })
  LOCKED.password = 'secret'
  await locked.client.receive('tnd 搜索 测试')
  uploads.length = 0
  replies = await locked.client.receive('tnd 下载 2 --range 1-1')
  assert.strictEqual(uploads.length, 1, '加锁下载失败: ' + replies)
  assert.ok(!uploads[0].file.startsWith('http'), '加锁时不应回传直链: ' + uploads[0].file)
  assert.ok(uploads[0].file.includes('tnd-'), '未使用临时文件: ' + uploads[0].file)
  LOCKED.password = ''

  console.log('7. 任务失败要透传服务端原因')
  replies = await a.client.receive('tnd 下载 7000000000000000099')
  assert.ok(replies.join('').includes('风控校验失败'), '失败原因未透传: ' + replies)

  console.log('8. 并发限制')
  const p1 = a.client.receive('tnd 下载 7000000000000000001 --range 1-1')
  await sleep(150)
  replies = await a.second.receive('tnd 下载 7000000000000000002 --range 1-1')
  assert.ok(replies.join('').includes('已有下载任务在进行中'), '并发未拦截: ' + replies)
  await p1

  console.log('9. 冷却')
  const cooled = await boot({ cooldown: 30 })
  await cooled.client.receive('tnd 搜索 测试')
  await cooled.client.receive('tnd 下载 1 --range 1-1')
  replies = await cooled.client.receive('tnd 下载 2 --range 1-1')
  assert.ok(replies.join('').includes('操作太快'), '冷却未生效: ' + replies)

  console.log('10. 服务端要求选格式时按 --format 自动应答')
  const ask = await boot()
  uploads.length = 0
  replies = await ask.client.receive('tnd 下载 7000000000000000096 --range 1-1 --format epub')
  assert.strictEqual(uploads.length, 1, '格式选择失败: ' + replies)
  assert.ok(uploads[0].name.endsWith('.epub'), '未使用 epub: ' + uploads[0].name)
  assert.ok(chosen.includes('epub'), '未提交格式选择')

  console.log('11. 散装模式打 zip 包')
  uploads.length = 0
  replies = await ask.client.receive('tnd 下载 7000000000000000097 --range 1-1')
  assert.strictEqual(uploads.length, 1, '散装下载失败: ' + replies)
  assert.ok(uploads[0].name.endsWith('.zip'), '散装未打包: ' + uploads[0].name)

  console.log('12. 超时取消')
  const short = await boot({ jobTimeout: 900 })
  replies = await short.client.receive('tnd 下载 7000000000000000098')
  assert.ok(replies.join('').includes('等待超时'), '超时未报: ' + replies)
  assert.ok(cancels.length > 0, '超时未取消任务')

  console.log('13. 任务清理')
  const seqBefore = jobSeq
  await a.client.receive('tnd 下载 7000000000000000002 --range 1-1')
  await sleep(400)
  assert.ok(![...jobs.keys()].some((id) => id > seqBefore), '任务未清理: ' + [...jobs.keys()])

  console.log('14. QQ 官方：markdown 元素 + 按钮组')
  const qqApp = await boot()
  const qqClient = qqApp.app.mock.client('20002')
  qqClient.event.platform = 'qq'
  replies = await qqClient.receive('tnd 搜索 测试')
  const qqOut = replies.join('')
  assert.ok(qqOut.includes('<qq:markdown'), '没有 qq:markdown 元素: ' + qqOut.slice(0, 200))
  assert.ok(qqOut.includes('<button-group'), '没有 button-group: ' + qqOut.slice(0, 200))
  assert.ok(qqOut.includes('id="tnd 下载 1"'), '按钮 id 不是命令: ' + qqOut.slice(0, 300))
  assert.ok(/<button[^>]*>1<\/button>/.test(qqOut), '按钮标签不是纯序号: ' + qqOut.slice(0, 300))
  assert.ok(!qqOut.includes("type=\"markdown\""), '仍在用旧的 message type=markdown')

  console.log('15. QQ 官方：文件用 data URL 且带标题（base64 限制）')
  uploads.length = 0
  replies = await qqClient.receive('tnd 下载 1 --range 1-1')
  const fileEl = replies.join('')
  assert.ok(fileEl.includes('<file'), '没有 file 元素: ' + fileEl.slice(0, 200))
  assert.ok(fileEl.includes('title="测试小说甲.txt"'), '文件名丢失: ' + fileEl.slice(0, 200))
  assert.ok(/src="(data:text\/plain;base64,|http)/.test(fileEl), 'src 异常: ' + fileEl.slice(0, 160))

  console.log('15b. QQ 官方：强制 base64 模式')
  const qqB64 = await boot({ transferMode: 'base64' })
  const qqB64Client = qqB64.app.mock.client('20003')
  qqB64Client.event.platform = 'qq'
  await qqB64Client.receive('tnd 搜索 测试')
  replies = await qqB64Client.receive('tnd 下载 1 --range 1-1')
  assert.ok(replies.join('').includes('src="data:text/plain;base64,'), '强制 base64 失效: ' + replies.join('').slice(0, 160))
  assert.ok(replies.join('').includes('title="测试小说甲.txt"'), 'base64 模式文件名丢失')

  console.log('16. 文转图（puppeteer)')
  const imgApp = await (async () => {
    const { app, config } = makeApp({ enableImage: true })
    app.puppeteer = {
      page: async () => ({
        setViewport() {}, setContent() {},
        $: async () => ({ screenshot: async () => Buffer.from('fake-png') }),
        close() {},
      }),
    }
    await app.start()
    const bot = app.bots[0]
    bot.platform = 'onebot'
    bot.internal = { uploadPrivateFile: async () => {}, uploadGroupFile: async () => {} }
    const client = app.mock.client('10001')
    client.event.platform = 'onebot'
    app.plugin(plugin, { ...config, apiBase: server.base })
    await app.start()
    return client
  })()
  replies = await imgApp.receive('tnd 搜索 测试')
  assert.ok(replies.join('').includes('<img'), '搜索结果没出图: ' + replies.join('').slice(0, 200))

  console.log('17. 宿主只吃 base64 时的自动回退')
  const b64 = await boot()
  b64.app.bots[0].internal = {
    uploadPrivateFile: async (t, file, name) => {
      if (!file.startsWith('base64://')) throw new Error('只支持 base64')
      uploads.push({ file, name })
    },
    uploadGroupFile: async () => { throw new Error('no') },
  }
  await b64.client.receive('tnd 搜索 测试')
  uploads.length = 0
  replies = await b64.client.receive('tnd 下载 1 --range 1-1')
  assert.strictEqual(uploads.length, 1, 'base64 回退失败: ' + replies)
  assert.ok(uploads[0].file.startsWith('base64://'), '最终未用 base64')
  assert.strictEqual(uploads[0].name, '测试小说甲.txt')

  await sleep(600) // 等清理任务的 DELETE 落地
  console.log('18. 搜索后回数字直接下载')
  const quick = await boot()
  await quick.client.receive('tnd 搜索 测试')
  uploads.length = 0
  replies = await quick.client.receive('2')
  assert.strictEqual(uploads.length, 1, '数字回复未触发下载: ' + replies)
  assert.strictEqual(uploads[0].name, '测试小说乙.txt')
  replies = await quick.client.receive('99')
  assert.ok(replies.join('').includes('序号无效'), '越界数字未提示: ' + replies)
  const noCache = await boot()
  replies = await noCache.client.receive('5')
  assert.strictEqual(replies.length, 0, '无缓存时不该抢数字: ' + replies)

  console.log('19. 取消下载')
  const cancelApp = await boot()
  replies = await cancelApp.client.receive('tnd 取消')
  assert.ok(replies.join('').includes('没有正在进行'), '空取消提示不对: ' + replies)
  await cancelApp.client.receive('tnd 搜索 测试')
  const running = cancelApp.client.receive('tnd 下载 7000000000000000098')
  await sleep(400)
  const cancelBefore = cancels.length
  replies = await cancelApp.second.receive('tnd 取消')
  assert.ok(replies.join('').includes('已取消'), '取消没有回执: ' + replies)
  await running
  assert.ok(cancels.length > cancelBefore, '没有调用服务端取消')
  uploads.length = 0
  replies = await cancelApp.client.receive('tnd 下载 1 --range 1-1')
  assert.strictEqual(uploads.length, 1, '取消后槽位没释放: ' + replies)

  console.log('20. QQ 官方：文件返回 Element 而不是字符串')
  const fakeApi = {
    canAnonymous: async () => true,
    downloadUrl: () => 'http://127.0.0.1/x/a.txt',
    zipUrl: () => 'http://127.0.0.1/x/a.zip',
    download: async () => new Response(Buffer.from('hello'), { status: 200 }),
  }
  const qqSession = { platform: 'qq', isDirect: true, userId: '1', bot: {} }
  const testCtx = { logger: { debug() {}, info() {}, warn() {}, error() {} } }
  const testConfig = { debug: false, transferMode: 'base64', fileSendMaxRetries: 1 }
  const el = await transferMod.sendNovelFile(testCtx, qqSession, fakeApi, 'a.txt', '书.txt', testConfig, {})
  assert.strictEqual(typeof el, 'object', '返回值不是 Element: ' + typeof el)
  assert.strictEqual(el.type, 'file')
  assert.strictEqual(el.attrs.title, '书.txt')
  assert.ok(String(el.attrs.src).startsWith('data:'), '未走 base64')
  assert.ok(Array.isArray(el.children), 'Element 结构不完整')

  console.log('21. QQ 官方：出图后不再补发 Markdown')
  const imgQq = await (async () => {
    const { app, config } = makeApp({ enableImage: true })
    app.puppeteer = { page: async () => ({ setViewport() {}, setContent() {}, $: async () => ({ screenshot: async () => Buffer.from('png') }), close() {} }) }
    await app.start()
    app.bots[0].platform = 'qq'
    const client = app.mock.client('30003')
    client.event.platform = 'qq'
    app.plugin(plugin, { ...config, apiBase: server.base })
    await app.start()
    return client
  })()
  replies = await imgQq.receive('tnd 搜索 测试')
  assert.strictEqual(replies.length, 1, '出图后又发了额外消息: ' + replies.length + ' / ' + replies.join(' | ').slice(0, 120))
  assert.ok(replies[0].includes('<img'), '没有图片: ' + replies[0].slice(0, 120))
  assert.ok(!replies[0].includes('qq:markdown'), '图片里混了 markdown')

  console.log('\nALL LOCAL TESTS PASSED')
}

main()
  .then(() => { clearInterval(ticker); server.close(); rmSync(SAVE_DIR, { recursive: true, force: true }) })
  .catch((e) => { console.error(e); clearInterval(ticker); server.close(); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1) })

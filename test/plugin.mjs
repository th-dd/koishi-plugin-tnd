import assert from 'node:assert'
import { apply, Config, name, inject } from '../lib/index.js'

const commands = new Map()
function makeCommand(cmdName) {
  const node = { name: cmdName, options: [], actions: [], subs: [], alias: (a) => node, usage: (u) => node }
  node.option = (n, rule) => { node.options.push({ n, rule }); return node }
  node.usage = (t) => { node.usageText = t; return node }
  node.example = (t) => { node.example = t; return node }
  node.action = (fn) => { node.actions.push(fn); return node }
  node.subcommand = (n) => {
    const child = makeCommand(node.name + '.' + n.split(' ')[0].slice(1))
    node.subs.push(child)
    commands.set(child.name, child)
    return child
  }
  return node
}
const middlewares = []
const ctx = {
  logger: { debug() {}, warn() {}, error() {}, info() {} },
  command: (n, d) => { const c = makeCommand(n); commands.set(n, c); return c },
  middleware: (fn) => { middlewares.push(fn); return () => {} },
}

assert.strictEqual(name, 'novel-downloader')
assert.deepStrictEqual(inject, { required: [], optional: ['puppeteer'] })
assert.ok(Config, 'Config 缺失')

const config = { apiBase: 'https://tnd.th-dd.top', apiPassword: '', maxSearchResults: 20, initialWait: 100, pollInterval: 100, jobTimeout: 1000, fileSendMaxRetries: 1, transferMode: 'auto', cleanupJob: true, quickDownload: true, cooldown: 0, maxConcurrentJobs: 2, maxTextLength: 500, enableImage: false, imageWidth: 800, debug: false }
apply(ctx, config)

const root = commands.get('tnd')
assert.ok(root, 'tnd 主命令缺失')
assert.deepStrictEqual([...commands.keys()].sort(), ['tnd', 'tnd.下载', 'tnd.取消', 'tnd.搜索', 'tnd.预览'])
assert.deepStrictEqual(commands.get('tnd.下载').options.map((o) => o.n), ['format', 'range', 'name'])
assert.ok(commands.get('tnd.搜索').usageText?.includes('tnd 搜索'), '缺少中文用法')
assert.ok(commands.get('tnd.下载').example, '缺少示例')
assert.strictEqual(middlewares.length, 1, '数字回复中间件未注册')

const session = { userId: '1', platform: 'onebot', send: async () => {} }
const reply = await commands.get('tnd.下载').actions[0]({ session, options: {} }, '3')
assert.match(String(reply), /先使用 tnd 搜索/)

console.log('plugin wiring ok')

import assert from 'node:assert'
import { apply } from '../lib/index.js'

const commands = new Map()
function makeCommand(cmdName) {
  const node = { name: cmdName, options: [], actions: [], children: [], alias: () => node, usage: () => node }
  node.option = () => node
  node.usage = () => node
  node.example = () => node
  node.alias = () => node
  node.action = (fn) => { node.actions.push(fn); return node }
  node.subcommand = (n) => {
    const child = makeCommand(node.name + '.' + n.split(' ')[0].slice(1))
    commands.set(child.name, child)
    node.children.push(child)
    return child
  }
  return node
}
const logs = []
const ctx = {
  logger: { debug: (...a) => logs.push(['debug', ...a]), warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]), info() {} },
  command: (n) => { const c = makeCommand(n); commands.set(n, c); return c },
  middleware: () => () => {},
}
const config = { apiBase: 'https://tnd.th-dd.top', apiPassword: '', maxSearchResults: 5, initialWait: 1000, pollInterval: 1500, jobTimeout: 120000, fileSendMaxRetries: 2, transferMode: 'file', cleanupJob: true, quickDownload: true, cooldown: 0, maxConcurrentJobs: 2, maxTextLength: 500, enableImage: false, imageWidth: 800, debug: true }
apply(ctx, config)

const sent = []
const uploads = []
const session = {
  userId: '90001',
  channelId: 'private:90001',
  platform: 'onebot',
  isDirect: true,
  bot: { internal: {
    uploadPrivateFile: async (target, file, name) => { uploads.push({ target, file, name }) },
    uploadGroupFile: async (target, file, name) => { uploads.push({ target, file, name }) },
  } },
  send: async (m) => { sent.push(String(m)) },
  sendQueued: async (m) => { sent.push(String(m)) },
}

const search = await commands.get('tnd.搜索').actions[0]({ session }, '斗破')
assert.ok(sent.length > 0, '搜索没有发出结果')
assert.match(sent.join('\n'), /搜索「斗破」/)

const preview = await commands.get('tnd.预览').actions[0]({ session }, '1')
assert.ok(typeof preview === 'string' && preview.includes('💡') || sent.some((s) => s.includes('💡')), '预览没有输出')

const target = '1'
const reply = await commands.get('tnd.下载').actions[0]({ session, options: { range: '1-2' } }, target)
assert.strictEqual(uploads.length, 1, '未触发上传，返回: ' + reply)
assert.match(uploads[0].name, /\.txt$/)
assert.match(sent.join('\n'), /已创建任务/)
assert.match(String(reply), /已发送/)
console.log('command flow ok:', uploads[0].name, '| reply:', reply)

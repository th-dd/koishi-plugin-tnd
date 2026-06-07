"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Config = exports.inject = exports.name = void 0;
exports.apply = apply;
const koishi_1 = require("koishi");
const promises_1 = require("timers/promises");
exports.name = 'tomato-downloader';
exports.inject = ['puppeteer'];
exports.Config = koishi_1.Schema.object({
    apiBase: koishi_1.Schema.string().required().description('TND 服务地址，如 http://tnd.th-dd.top'),
    apiPassword: koishi_1.Schema.string().required().description('TND 服务的密码锁密码'),
    enableImage: koishi_1.Schema.boolean().default(true).description('将搜索结果渲染为图片（需要 koishi-plugin-puppeteer）'),
    imageWidth: koishi_1.Schema.number().default(800).description('图片宽度'),
    debug: koishi_1.Schema.boolean().default(false).description('开启调试日志')
});
const searchCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5分钟
function apply(ctx, config) {
    const base = config.apiBase.replace(/\/$/, '');
    let cookieString = null;
    function logDebug(...args) {
        if (config.debug)
            ctx.logger.debug('[DEBUG]', ...args);
    }
    // 登录获取 Cookie
    async function login() {
        if (cookieString)
            return true;
        logDebug('登录 TND:', `${base}/api/login`);
        try {
            const res = await fetch(`${base}/api/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: config.apiPassword })
            });
            if (res.status === 200) {
                const setCookies = res.headers.getSetCookie?.() || [];
                if (setCookies.length) {
                    cookieString = setCookies.map(c => c.split(';')[0]).join('; ');
                }
                else {
                    const single = res.headers.get('set-cookie');
                    if (single)
                        cookieString = single;
                }
                ctx.logger.info('TND 登录成功');
                return true;
            }
            ctx.logger.error(`登录失败: ${res.status}`);
            return false;
        }
        catch (e) {
            ctx.logger.error(`登录异常: ${e.message}`);
            return false;
        }
    }
    function getHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        if (cookieString)
            headers['Cookie'] = cookieString;
        return headers;
    }
    async function authedFetch(path, options, retry = 3) {
        if (!cookieString)
            await login();
        let res = await fetch(`${base}${path}`, {
            ...options,
            headers: { ...getHeaders(), ...(options?.headers || {}) }
        });
        if (res.status === 429 && retry > 0) {
            const wait = parseInt(res.headers.get('Retry-After') || '15') * 1000;
            ctx.logger.warn(`限流，等待 ${wait / 1000}s`);
            await (0, promises_1.setTimeout)(wait);
            return authedFetch(path, options, retry - 1);
        }
        if (res.status === 401 && cookieString) {
            ctx.logger.warn('Cookie 失效，重新登录');
            cookieString = null;
            await login();
            return fetch(`${base}${path}`, {
                ...options,
                headers: { ...getHeaders(), ...(options?.headers || {}) }
            });
        }
        return res;
    }
    // 生成图片（可选，需要 puppeteer）
    async function renderResultsAsImage(items, keyword) {
        if (!config.enableImage)
            return null;
        logDebug('生成图片，条目数:', items.length);
        try {
            const browser = await ctx.puppeteer.browser();
            const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; padding: 20px; background: #f5f5f5; }
          .container { max-width: ${config.imageWidth}px; margin: 0 auto; background: white; border-radius: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); overflow: hidden; }
          .header { background: #2c3e50; color: white; padding: 16px 24px; }
          .header h2 { margin: 0; font-size: 1.5rem; }
          .header p { margin: 8px 0 0; opacity: 0.8; font-size: 0.9rem; }
          table { width: 100%; border-collapse: collapse; }
          th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #eee; }
          th { background: #f8f9fa; font-weight: 600; color: #2c3e50; }
          tr:hover { background: #f8f9fa; }
          .book-id { font-family: monospace; font-size: 0.8rem; color: #7f8c8d; }
          .footer { padding: 12px 24px; background: #f8f9fa; color: #7f8c8d; font-size: 0.8rem; text-align: center; border-top: 1px solid #eee; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>🔍 搜索「${escapeHtml(keyword)}」</h2>
            <p>共找到 ${items.length} 本小说，请回复序号下载</p>
          </div>
          <table>
            <thead><tr><th>序号</th><th>书名</th><th>作者</th><th>小说ID</th></td></thead>
            <tbody>
              ${items.map((item, idx) => `
                <tr>
                  <td style="font-weight: bold;">${idx + 1}</td>
                  <td>${escapeHtml(item.title)}</td>
                  <td>${escapeHtml(item.author || '未知')}</td>
                  <td class="book-id">${item.book_id}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <div class="footer">💡 使用 tnd 下载 &lt;序号&gt; 下载（例如 tnd 下载 1）</div>
        </div>
      </body>
      </html>`;
            const page = await browser.newPage();
            await page.setViewport({ width: config.imageWidth, height: 800 });
            await page.setContent(html, { waitUntil: 'networkidle0' });
            const element = await page.$('.container');
            const screenshot = await element.screenshot({ type: 'png' });
            await page.close();
            return screenshot;
        }
        catch (e) {
            ctx.logger.error(`图片生成失败: ${e.message}`);
            return null;
        }
    }
    function escapeHtml(str) {
        return str.replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m] || m));
    }
    const tnd = ctx.command('tnd', '番茄小说下载器');
    // 搜索子命令（中英文别名）
    const searchCmd = tnd.subcommand('.search <keyword:text>', '搜索小说');
    searchCmd.alias('.搜索');
    searchCmd.action(async ({ session }, keyword) => {
        if (!keyword)
            return '用法：tnd 搜索 小说名';
        logDebug(`搜索: ${keyword}`);
        try {
            const res = await authedFetch(`/api/search?q=${encodeURIComponent(keyword)}`);
            if (!res.ok)
                return `搜索失败 (${res.status})`;
            const data = await res.json();
            const items = data.items || [];
            if (!items.length)
                return '没有找到相关小说。';
            const userId = session?.userId || 'global';
            searchCache.set(userId, { items, timestamp: Date.now() });
            if (config.enableImage) {
                const img = await renderResultsAsImage(items.slice(0, 20), keyword);
                if (img)
                    return koishi_1.h.image(img, 'image/png');
            }
            let msg = `🔍 找到 ${items.length} 本：\n`;
            items.slice(0, 20).forEach((b, i) => {
                msg += `${i + 1}. ${b.title} (${b.author || '未知'})\n`;
            });
            msg += `\n💡 使用 tnd 下载 <序号>`;
            return msg;
        }
        catch (e) {
            return `搜索失败: ${e.message}`;
        }
    });
    // 下载子命令（中英文别名）
    const downloadCmd = tnd.subcommand('.download <target>', '下载小说');
    downloadCmd.alias('.下载');
    downloadCmd.action(async ({ session }, target) => {
        if (!target)
            return '用法：tnd 下载 <序号> 或 tnd 下载 <book_id>';
        logDebug(`下载目标: ${target}`);
        let book_id = null;
        let book_title = null;
        if (/^\d+$/.test(target) && target.length > 15) {
            book_id = target;
        }
        else {
            const userId = session?.userId || 'global';
            const cached = searchCache.get(userId);
            if (!cached || Date.now() - cached.timestamp > CACHE_TTL) {
                return '未找到搜索结果，请先使用 tnd 搜索';
            }
            const idx = parseInt(target, 10);
            if (isNaN(idx) || idx < 1 || idx > cached.items.length) {
                return `序号无效，请输入 1-${cached.items.length}`;
            }
            book_id = cached.items[idx - 1].book_id;
            book_title = cached.items[idx - 1].title;
        }
        if (!book_id)
            return '无法获取小说 ID';
        if (!book_title)
            return '无法获取书名，请重新搜索';
        try {
            // 1. 创建下载任务
            const createRes = await authedFetch('/api/jobs', {
                method: 'POST',
                body: JSON.stringify({ book_id })
            });
            if (!createRes.ok)
                return `创建任务失败 (${createRes.status})`;
            const job = await createRes.json();
            const taskId = job.id || job.data?.id;
            if (!taskId)
                return `创建失败: ${JSON.stringify(job)}`;
            await session?.send(`📥 任务已创建 (ID: ${taskId})，正在下载...`);
            // 2. 等待总计 120 秒
            const INITIAL_WAIT = 20000; // 20 秒
            const RETRY_INTERVAL = 5000; // 5 秒
            const MAX_RETRIES = 20; // 20 次 → 总 20 + 20*5 = 120 秒
            await (0, promises_1.setTimeout)(INITIAL_WAIT);
            // 3. 构造文件链接（格式：{base}/download/书名.txt）
            const fileName = `${book_title}.txt`;
            const fileUrl = `${base}/download/${encodeURIComponent(fileName)}`;
            // 4. 轮询检查文件是否可访问
            for (let i = 0; i < MAX_RETRIES; i++) {
                const checkRes = await fetch(fileUrl, { method: 'HEAD' });
                if (checkRes.ok) {
                    logDebug(`文件已就绪 (尝试 ${i + 1} 次)，链接: ${fileUrl}`);
                    return koishi_1.h.file(fileUrl);
                }
                logDebug(`文件未就绪 (尝试 ${i + 1}/${MAX_RETRIES})，等待 ${RETRY_INTERVAL / 1000} 秒...`);
                await (0, promises_1.setTimeout)(RETRY_INTERVAL);
            }
            return `下载超时（已等待 120 秒），请稍后手动访问 TND 获取。任务 ID: ${taskId}`;
        }
        catch (e) {
            ctx.logger.error(`下载异常: ${e.message}`);
            return `下载失败: ${e.message}`;
        }
    });
}

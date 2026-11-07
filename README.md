# koishi-plugin-novel-downloader

> 2.0.0 起非 OneBot 适配器（含 QQ 官方）发送文件改为返回消息元素，修复官机发送时崩进程的问题。变更见 [CHANGELOG](CHANGELOG.md)。

在 Koishi 里搜索、预览并下载番茄小说（对接 [TND](https://tnd.th-dd.top) 服务）。

## 安装

```bash
npm install koishi-plugin-novel-downloader
```

可选安装 `koishi-plugin-puppeteer`，用于把搜索结果渲染成图片；不装也能用，只是发文字。

## 配置

```yaml
plugins:
  novel-downloader:
    apiBase: https://tnd.th-dd.top   # TND 服务地址（必填）
    apiPassword: ''                  # 服务密码锁密码，未加锁留空
    maxSearchResults: 20             # 搜索结果最大显示数量
    initialWait: 8000                # 建任务后首次轮询前等待 (毫秒)
    pollInterval: 5000               # 任务进度轮询间隔 (毫秒)
    jobTimeout: 600000               # 单任务最长等待 (毫秒)
    fileSendMaxRetries: 3            # 发送失败重试次数
    transferMode: auto               # auto | url | file | base64
    cleanupJob: true                 # 完成后删除服务端任务记录
    cooldown: 15                     # 同用户下载冷却 (秒)，0 关闭
    maxConcurrentJobs: 3             # 全局并发任务上限
    quickDownload: true              # 搜索后直接回数字即可下载
    maxTextLength: 1800              # 单条消息字符上限
    enableImage: false               # 搜索结果渲染成图片（需 puppeteer）
    imageWidth: 800
    debug: false
```

### transferMode

| 值 | 说明 |
|---|---|
| `auto` | 服务未加锁时直接给适配器下载直链（省流量），失败或服务加锁时回退临时文件 |
| `url` | 只给直链，由 OneBot 实现自行下载 |
| `file` | 先下载到本机临时文件再上传，兼容性最好 |
| `base64` | 转 base64://，小文件可用，大文件吃内存 |

## 使用

| 命令 | 说明 |
|---|---|
| `tnd 搜索 <关键词>` | 搜索小说并缓存序号 |
| `tnd 预览 <序号/ID>` | 查看简介、章节数，下载前确认 |
| `tnd 下载 <序号/ID>` | 创建下载任务并在完成后发送文件 |
| `tnd 下载 1 --format epub` | 服务端要求选择格式时指定 |
| `tnd 下载 1 --range 1-50` | 只下载指定章节 |
| `tnd 下载 1 --name 我的书` | 自定义发送的文件名 |
| 搜索后直接回 `1` | 等价于 `tnd 下载 1`（10 分钟内有效，`quickDownload` 可关） |
| `tnd 取消` | 取消自己正在进行的下载，约 0.25 秒内生效并释放并发槽 |

下载过程中会按轮询间隔播报进度，完成后自动发送 txt/epub/pdf（散装模式打成 zip），完成提示会带上文件实际大小；`tnd 预览` 也会显示字数与预估体积。
QQ 官方的结果用「序号」按钮，标签只有数字；截图用 `load` 事件（不等 networkidle0），失败自动降级文字。
`debug: true` 的日志走 INFO 级别，容器默认日志就能看到 `[tnd]` 行。

## 适配器

- **OneBot 11**（LLOneBot / NapCat / Lagrange 等）：走 `upload_group_file` / `upload_private_file`，群聊私聊自动区分，文件名显式传给接口
- **QQ 官方**：用适配器认识的 `<qq:markdown>` + `<button-group>` 发结果和按钮；文件走 data URL(base64) 并带 `title`
- **Telegram / Discord**：文本 + Markdown 降级
- 宿主读不到本地路径（跨机部署）时把 `transferMode` 设成 `base64`；`auto` 在直链和临时文件都失败时也会自动退到 base64
- 开启 `enableImage` 需要 `koishi-plugin-puppeteer`，走它的 `page()` API，兼容旧版 `browser()`

## 开发

```shell
npm i
npm run typecheck
npm test                             # 本地全量测试：不联网，自带 TND mock 服务
npm run test:live                    # 打真服务跑搜索/预览/下载（可选）
npm run build && npm pack            # 产物 tgz
yarn add ./koishi-plugin-novel-downloader-2.0.0.tgz   # 装进容器
```

测试说明：`test/local.cjs` 起一个本地 TND mock 服务，用真实 Koishi App + mock 适配器把插件按命令跑一遍，
覆盖搜索、预览、按序号/ID 下载、加锁鉴权、失败透传、并发/冷却、格式选择、散装打包、超时取消和任务清理。

## 发布

打 tag 即触发 GitHub Actions 发布到 npm（`NPM_TOKEN` 为带 Bypass 2FA 的 Granular token，放在仓库 Secrets 里）：

```bash
npm version patch          # 或 minor / major
git push --follow-tags
```

工作流会先校验 tag 与 `package.json` 版本一致，再跑 `typecheck` + `npm test`，然后带 provenance 发 npmjs，最后以 `@th-dd/koishi-plugin-novel-downloader` 这个作用域名同步一份到 GitHub Packages。

需要仓库 Secrets 里配 `NPM_TOKEN`（Granular token，Read and write + Bypass 2FA + 仅限本包）。GitHub Packages 用内置 `GITHUB_TOKEN`，装在别处时：

```bash
yarn config set 'npmScopes.th-dd.npmRegistryServer' https://npm.pkg.github.com
yarn add @th-dd/koishi-plugin-novel-downloader
```

## License

MIT

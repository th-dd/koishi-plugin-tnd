# Koishi 小说下载插件

从番茄小说等平台下载 TXT/EPUB 格式电子书。

## 安装

```bash
npm install koishi-plugin-novel-downloader
```

## 配置

```yaml
plugins:
  novel-downloader:
    apiBase: https://tnd.th-dd.top   # TND 服务地址（必填）
    apiPassword: your_password        # TND 服务密码（必填）
    maxSearchResults: 20              # 搜索结果最大显示数量
    initialWait: 30000                # 创建任务后初始等待时间 (毫秒)
    retryInterval: 10000              # 文件检查重试间隔 (毫秒)
    maxFileCheckRetries: 33           # 文件检查最大重试次数
    fileSendMaxRetries: 3             # 文件发送失败最大重试次数
    maxTextLength: 4000               # 单条消息最大字符数
    enableImage: false                # 将搜索结果渲染为图片（需要 koishi-plugin-puppeteer）
    imageWidth: 800                   # 图片宽度
    debug: false                      # 开启调试日志
```

## 使用

| 命令 | 说明 |
|------|------|
| `tnd 搜索 <关键词>` | 搜索小说 |
| `tnd 下载 <序号/ID>` | 下载小说 |

## 开发

```shell
npm i                                 # 安装依赖
npm run build && npm pack             # 构建产物
yarn add ./koishi-plugin-novel-downloader-<x.x.x>.tgz  # 进入容器安装
```

## 示例

```
# 搜索
tnd 搜索 斗破苍穹

# 下载（根据搜索结果序号）
tnd 下载 1

# 下载（直接使用 Book ID）
tnd 下载 7143038691944949011
```

## 选项

| 参数 | 说明 |
|------|------|
| `apiBase` | TND 服务地址（必填） |
| `apiPassword` | TND 服务密码（必填） |
| `maxSearchResults` | 搜索结果最大显示数量 |
| `initialWait` | 创建任务后初始等待时间 |
| `retryInterval` | 文件检查重试间隔 |
| `maxFileCheckRetries` | 文件检查最大重试次数 |
| `fileSendMaxRetries` | 文件发送失败最大重试次数 |
| `enableImage` | 将搜索结果渲染为图片 |
| `debug` | 开启调试日志 |

## License

MIT

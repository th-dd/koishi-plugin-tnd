# Koishi 小说下载插件

一个功能强大的 Koishi 插件，支持从番茄小说等平台下载 TXT/EPUB 格式的电子书。

## 功能特性

- 🔍 **小说搜索** - 支持关键词搜索小说
- 📖 **详情查看** - 查看小说详细信息、章节列表
- 📥 **小说下载** - 支持 TXT 和 EPUB 格式下载
- ⚙️ **灵活配置** - 支持编码、章节范围等选项
- 📊 **任务管理** - 查看下载进度和任务状态
- 🌐 **多平台支持** - 目前支持番茄小说，可扩展更多平台

## 安装

### 方式一：通过 Koishi 插件市场安装

在 Koishi 控制台的插件市场中搜索 `novel-downloader` 并安装。

### 方式二：手动安装

```bash
# 进入 Koishi 实例目录
cd your-koishi-instance

# 安装插件
npm install koishi-plugin-novel-downloader
```

### 方式三：本地开发安装

```bash
# 克隆或下载插件源码
cd koishi-plugin-novel-downloader

# 安装依赖
npm install

# 构建
npm run build

# 在 Koishi 实例中链接
npm link
```

## 配置

在 `koishi.yml` 中添加配置：

```yaml
plugins:
  novel-downloader:
    # 默认下载格式
    defaultFormat: txt
    # 默认文件编码
    defaultEncoding: utf-8
    # 下载保存路径
    downloadPath: ./downloads/novels
    # 并发下载数量
    concurrency: 5
    # 请求超时时间（毫秒）
    timeout: 30000
    # 是否启用缓存
    enableCache: true
    # 缓存过期时间（秒）
    cacheExpire: 3600
```

## 使用方法

### 基本命令

| 命令 | 别名 | 说明 |
|------|------|------|
| `novel.search <关键词>` | `小说搜索`, `n搜索` | 搜索小说 |
| `novel.info <ID>` | `小说详情`, `n详情` | 查看小说详情 |
| `novel.download <ID>` | `小说下载`, `n下载` | 下载小说 |
| `novel.tasks` | `小说任务`, `n任务` | 查看下载任务 |
| `novel.clear` | `小说清理` | 清理已完成任务 |
| `novel` | `小说` | 查看帮助 |

### 使用示例

#### 1. 搜索小说

```
novel.search 斗破苍穹
n搜索 诡秘之主
```

#### 2. 查看小说详情

```
novel.info 7143038691944949011
n详情 7143038691944949011
```

#### 3. 下载小说

```
# 基本下载
novel.download 7143038691944949011

# 指定格式
novel.download 7143038691944949011 -f epub

# 指定编码
novel.download 7143038691944949011 -e gbk

# 下载指定章节范围
novel.download 7143038691944949011 -s 1 -d 100
```

#### 4. 查看下载任务

```
novel.tasks
n任务
```

### 下载选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-f, --format` | 输出格式 (txt/epub) | txt |
| `-e, --encoding` | 文件编码 (utf-8/gbk) | utf-8 |
| `-s, --start` | 起始章节 | 1 |
| `-d, --end` | 结束章节 | 0 (全部) |

## 输出格式

### TXT 格式

```
书名
作者: 作者名
========================================

【简介】
小说简介内容...

========================================

第一章 章节标题

章节内容...

────────────────────────────────────────

第二章 章节标题

章节内容...
```

### EPUB/HTML 格式

生成带有样式的 HTML 文件，支持：
- 响应式布局
- 清晰的章节分隔
- 美观的排版

## 项目结构

```
koishi-plugin-novel-downloader/
├── package.json          # 插件配置
├── tsconfig.json         # TypeScript 配置
├── README.md             # 说明文档
└── src/
    ├── index.ts          # 主入口
    ├── api/
    │   ├── types.ts      # 类型定义
    │   └── fanqie.ts     # 番茄小说 API
    └── services/
        └── downloader.ts # 下载服务
```

## 扩展开发

### 添加新平台支持

1. 在 `src/api/` 下创建新的 API 文件，实现 `PlatformApi` 接口：

```typescript
// src/api/newplatform.ts
import { PlatformApi, NovelPlatform } from './types'

export class NewPlatformApi implements PlatformApi {
  name = '新平台'
  platform: NovelPlatform = 'other'
  
  async search(keyword: string, page?: number, pageSize?: number) {
    // 实现搜索逻辑
  }
  
  async getNovelInfo(novelId: string) {
    // 实现获取详情
  }
  
  async getChapterList(novelId: string) {
    // 实现获取章节列表
  }
  
  async getChapterContent(novelId: string, chapterId: string) {
    // 实现获取章节内容
  }
  
  async getChapterContents(novelId: string, chapterIds: string[]) {
    // 实现批量获取
  }
}
```

2. 在 `src/services/downloader.ts` 中注册新平台：

```typescript
import { NewPlatformApi } from '../api/newplatform'

// 在 initPlatformApis 方法中添加
this.platformApis.set('other', new NewPlatformApi(this.ctx, this.config.timeout))
```

## 注意事项

1. **版权声明**：下载的小说仅供个人学习使用，请勿用于商业用途
2. **API 限制**：番茄小说 API 可能有访问频率限制，插件已内置延迟机制
3. **文件存储**：下载的文件保存在服务器端，需要管理员协助获取
4. **网络要求**：需要服务器能够访问番茄小说 API

## 常见问题

### Q: 搜索不到小说？
A: 可能是网络问题或 API 不可用，请检查服务器网络连接。

### Q: 下载失败？
A: 可能是小说 ID 错误、网络超时或 API 限制，请查看日志获取详细错误信息。

### Q: 如何获取下载的文件？
A: 文件保存在服务器的 `downloadPath` 配置路径下，需要联系管理员获取。

## 更新日志

### v1.0.0
- 初始版本发布
- 支持番茄小说搜索和下载
- 支持 TXT 和 EPUB 格式
- 支持章节范围选择
- 支持任务管理

## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request！

## 相关链接

- [Koishi 官方文档](https://koishi.chat)
- [番茄小说官网](https://www.fanqienovel.com)

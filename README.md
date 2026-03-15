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
    defaultFormat: txt        # 默认格式
    defaultEncoding: utf-8    # 默认编码
    downloadPath: ./downloads/novels
```

## 使用

| 命令 | 说明 |
|------|------|
| `novel.search <关键词>` | 搜索小说 |
| `novel.info <ID>` | 查看详情 |
| `novel.download <ID>` | 下载小说 |
| `novel.tasks` | 查看任务 |

## 示例

```
# 搜索
novel.search 斗破苍穹

# 下载
novel.download 7143038691944949011

# 指定格式
novel.download 7143038691944949011 -f epub

# 下载指定章节
novel.download 7143038691944949011 -s 1 -d 100
```

## 选项

| 参数 | 说明 |
|------|------|
| `-f` | 格式 (txt/epub) |
| `-e` | 编码 (utf-8/gbk) |
| `-s` | 起始章节 |
| `-d` | 结束章节 |

## License

MIT

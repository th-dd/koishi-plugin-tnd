# 2.0.0 生产部署（宿主机 /data/koishi → 容器内 /koishi）

> 假定宿主机可 sudo，容器内应用目录是 /koishi，且 /data/koishi 已挂进容器。
> 包 SHA256：D5F1B71500874A49AACD2F8A078C9D656F12105361E61EE01EB6786942F9FC72

## 0. 确认容器名（本文按 koishi 写）

~~~bash
cd /data/koishi
sudo docker compose ps
# 没有 compose ps 的话：
sudo docker ps --format '{{.Names}}\t{{.Image}}' | grep -i koishi
~~~

## 1. 备份

~~~bash
B=~/koishi-backup-$(date +%F-%H%M)
sudo mkdir -p $B
sudo cp -a /data/koishi/koishi.yml /data/koishi/package.json $B/
ls -l $B/
~~~

## 2. 传到宿主机并校验

本机（Windows PowerShell）：

~~~powershell
scp .\koishi-plugin-novel-downloader-2.0.0.tgz <user>@<host>:/data/koishi/
~~~

服务器上：

~~~bash
cd /data/koishi
sha256sum koishi-plugin-novel-downloader-2.0.0.tgz
# 必须等于 58DAC33A1737DA2B95D8329CAD2010BD35A5DBA25C095AEF65CB276A21CB3D53
~~~

上面 ls 报不存在，说明目录没挂进容器，改用：

~~~bash
sudo docker cp koishi-plugin-novel-downloader-2.0.0.tgz koishi:/koishi/
~~~

## 3. 安装（容器内）

~~~bash
sudo docker compose exec koishi yarn add ./koishi-plugin-novel-downloader-2.0.0.tgz
sudo docker compose exec koishi node -p "require('/koishi/node_modules/koishi-plugin-novel-downloader/package.json').version"
# 输出必须是 2.0.0
~~~

## 4. 改配置（只动 novel-downloader 块）

~~~bash
sudo cp -a /data/koishi/koishi.yml /data/koishi/koishi.yml.bak-$(date +%F-%H%M)
sudo nano /data/koishi/koishi.yml
~~~

把 novel-downloader 下的这些项改成下面这样（apiBase / apiPassword 保持原样）：

~~~yaml
      transferMode: base64
      debug: true
      cooldown: 30
      cleanupJob: true
      maxConcurrentJobs: 2
      enableImage: true
      initialWait: 8000
      pollInterval: 5000
      jobTimeout: 600000
~~~

顺手删掉两个已废弃的 key：retryInterval、maxFileCheckRetries。

## 5. 重启 + 看日志

~~~bash
cd /data/koishi
sudo docker compose restart koishi
sleep 5
sudo docker compose logs --tail 200 koishi | grep -iE 'novel-downloader|schema|error|warn'
~~~

标准：有 novel-downloader 加载记录、没有 schema/插件报错。然后挂着 logs -f 测，看 [tnd] 行。

## 6. 只测这 4 条（QQ 私聊或群）

1. tnd 搜索 斗破（QQ 官方）→ Markdown 表格 + 按钮，不是 ## / | 纯文本
2. tnd 下载 1 --range 1-3（OneBot 与 QQ 官方各一次）→ 文件名是 书名.txt，不是 file.txt / file
3. 搜索出图（enableImage + puppeteer 已装）
4. 拔网或超时 → 报原始原因，不干等 5 分钟

## 7. 回滚

~~~bash
cd /data/koishi
sudo docker compose exec koishi yarn add koishi-plugin-novel-downloader@1.1.5
sudo cp $B/koishi.yml ./koishi.yml
sudo docker compose restart koishi
~~~
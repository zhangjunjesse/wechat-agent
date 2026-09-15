# 部署与验证清单：日报管道（ADR-0017）

> 目标：把含「报告类公共任务管道」的 wechat-agent 0.1.0 源码包推上生产
> `https://datadefender.cn/wechat-agent` 并完成真实链路验证。
> 源码包：`deploy/wechat-agent-0.1.0.tgz`（`npm pack` 现打，含全部新文件，无 node_modules、
> 无 data/ 敏感数据；服务器侧依赖不动——本版本零新 npm 依赖）。

## ✅ 部署记录（2026-09-15 已完成，含实测）

- 方式：容器 `node:22-bookworm-slim` 直接**挂载源码** `/opt/wechat-agent/app -> /app`
  （CMD `node /app/src/server.mjs`，WORKDIR=`/`）。部署 = 换 `app/` 源码 + `docker restart`，
  **env 零改动**：WORKDIR=`/` 使默认相对路径 `data/reports.db` / `data/tasks.db` /
  `data/user-files` 恰好落在持久卷 `/data`（挂载 `/opt/wechat-agent/data -> /data`）。
- 步骤：备份 `app` → `app.bak-20260916-report` → 上传 tgz → 解包 + `rsync -a --delete
  --exclude node_modules` 同步（清掉残留 `tmp-probe.mjs`，保留服务器 node_modules）→
  把「每日早报」`last_run_at` 回拨一天强制补跑当天轮 → `docker restart`。
- 实测结果：报告 `rp-0edff76a-20260915` 生成 **7 条 AI/科技要闻**（带公众号来源 +
  微信原文链接）；**封面图经 image-studio 技能生成**（1.8MB PNG）；公网页
  `/reports/<id>` 与 `/cover` 均 HTTP 200；微信推送成功（`lastError` 为空，旧版同日
  曾报 `402 Insufficient Balance` 未复现）。
- 部署后发现 focus 值被模型带上 schema 提示词前缀 → 已加 `normalizeFocus` 渲染层去前缀
  （271/271 全绿）并同步生产，次日轮生效。

> ⚠️ 若将来把容器 WORKDIR 改成 /app 或改用构建镜像，则 `data/xxx` 相对路径会落到
> 容器层——届时必须显式设置 `REPORTS_FILE=/data/reports.db`、`TASKS_FILE=/data/tasks.db`、
> `USER_FILES_ROOT=/data/user-files` 等。

## 0. 部署前检查（服务器上）

```bash
cd /opt/wechat-agent
cat server.env          # 确认以下三项：
```

| 变量 | 要求 | 说明 |
|---|---|---|
| `REPORTS_FILE` | **不需要**（当前挂载式部署下默认即可） | WORKDIR=`/` 时默认 `data/reports.db` 即 `/data/reports.db`（持久卷）；改 WORKDIR 才需显式设置 |
| `USER_FILES_ROOT` | 默认即可 | 同上，`data/user-files` 落 `/data/user-files`（封面技能产物持久） |
| `TOAPIS_API_KEY` | 有则封面出图；无则自动纯文字降级 | 不算故障，只是没封面 |

```bash
# 确认当前容器参数（挂载/端口/env），照此复刻
docker inspect wechat-agent --format '{{json .Mounts}} {{json .HostConfig.PortBindings}}'
```

## 1. 部署（沿用既定流程：备份 → 解包 → rm + run）

```bash
cd /opt/wechat-agent
# 备份旧版（可回滚）
mv app app.bak-20260916-report
# 上传并解包新源码（本地先 scp deploy/wechat-agent-0.1.0.tgz 上来）
mkdir app && tar -xzf wechat-agent-0.1.0.tgz -C app --strip-components=1
# 编辑 server.env：追加 REPORTS_FILE=/data/reports.db（其余不动）
# 重建容器 —— 必须 docker rm + docker run（docker restart 不会重读 env-file）
docker rm -f wechat-agent
# 按步骤 0 的 docker inspect 结果复刻挂载与端口，例如：
docker run -d --name wechat-agent --restart unless-stopped \
  --env-file /opt/wechat-agent/server.env \
  -p 127.0.0.1:8789:8789 \
  -v /opt/wechat-agent/data:/data \
  -v /opt/wechat-agent/assistant-qr.jpg:/app/assistant-qr.jpg:ro \
  -v /opt/wechat-sync/data:/wechat-sync-data:ro \
  wechat-agent:latest   # 镜像若需重建：先 docker build -t wechat-agent .
```

启动成功标志（日志）：
- `global tasks loaded: 每日早报`
- `wechat-agent listening on http://127.0.0.1:8789`

## 2. 重启后立即验证（若已过北京 08:00，首轮 sweep 会立即触发今天的日报）

| # | 检查项 | 怎么验 | 通过标准 |
|---|---|---|---|
| V1 | 今日报告已生成入库 | `sqlite3 /opt/wechat-agent/data/reports.db 'select id, name, run_at, items_count from reports'` | 出现 `rp-…-<今天>` 行，items_count ≥ 3 |
| V2 | 公网页可访问 | 浏览器打开 `https://datadefender.cn/wechat-agent/reports/<id>`（id 取 V1 结果） | 移动端响应式页面：日期、条目卡片、原文链接可点 |
| V3 | 微信收到推送 | 订阅者微信（需最近互动过，contextToken 有效） | 封面图（如有）+ 摘要文本，文本含完整版链接 |
| V4 | 服务器日志无异常 | `docker logs wechat-agent --tail 100` | 无 `report_unparsable`、无未捕获异常 |

> 未到 08:00 时：等 08:00 触发即可，或把 server.env 里 GLOBAL_TASKS_FILE 指向的
> 配置临时改早一点（记得改回），不推荐改生产数据。

## 3. 分天验证（去重 + 追问）

- **次日（D+1）**：08:00 后对比 V1 的新报告条目标题，与 D0 不应重复（近 7 天指纹去重）。
  若 agent 偶发输出非 JSON → `lastError` 出现 `report_unparsable`（降级直推，不丢内容）。
- **追问**：微信里回复「第 3 条展开讲讲」→ agent 应调 `get_daily_report` 取回当天条目再展开。
- **D+7 内**：同主题旧闻不应再出现；出现少量延续报道属设计内保底（删后 <3 条不删）。

## 4. 回滚

```bash
cd /opt/wechat-agent
docker rm -f wechat-agent
mv app.bak-20260916-report app   # 或重新解包旧 tgz
docker run -d ...（复刻步骤 1 参数，env 去掉 REPORTS_FILE 即可）
```

## 5. 已知边界（不是故障）

- 封面依赖 `TOAPIS_API_KEY` + 服务器可访问 `TOAPIS_BASE_URL`（国内建议 `https://toapis.cn`）；
  缺失时纯文字推送。
- `get_daily_report` 只对**已订阅该任务的用户**可见（权限隔离）。
- 公网页无鉴权——内容为公共新闻、URL 不可猜测，可接受；后续如加个性化内容需加访问控制。

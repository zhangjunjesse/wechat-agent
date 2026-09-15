# 部署与验证清单：日报管道（ADR-0017）

> 目标：把含「报告类公共任务管道」的 wechat-agent 0.1.0 源码包推上生产
> `https://datadefender.cn/wechat-agent` 并完成真实链路验证。
> 源码包：`deploy/wechat-agent-0.1.0.tgz`（`npm pack` 现打，含全部新文件，无 node_modules、
> 无 data/ 敏感数据；服务器侧依赖不动——本版本零新 npm 依赖）。

## 0. 部署前检查（服务器上）

```bash
cd /opt/wechat-agent
cat server.env          # 确认以下三项：
```

| 变量 | 要求 | 缺失后果 |
|---|---|---|
| `REPORTS_FILE` | **必须新增** `/data/reports.db` | 报告库写进容器临时层，重建容器即丢；公网页 404 |
| `USER_FILES_ROOT` | 应为 `/data/user-files` | 封面图（技能产物）写容器临时层，重启丢失 |
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

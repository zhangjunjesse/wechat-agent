#!/bin/bash
set -e
rm -rf /tmp/wa-new && mkdir -p /tmp/wa-new
tar -xzf /opt/wechat-agent/wechat-agent-0.1.0-poster.tgz -C /tmp/wa-new
rsync -a --delete --exclude node_modules /tmp/wa-new/package/ /opt/wechat-agent/app/
rm -rf /tmp/wa-new
echo "SYNC_OK"
# 回拨 last_run_at 到昨天 → 重启后首轮 sweep 立即触发今天的日报（幂等 upsert + 新海报 + 推送）
docker exec wechat-agent node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/tasks.db");
db.prepare("UPDATE tasks SET last_run_at = ? WHERE name = ? AND scope = ?").run(Date.UTC(2026, 8, 14, 0, 0, 0), "每日早报", "global");
console.log("BACKDATED");
'
docker restart wechat-agent
echo "RESTARTED"

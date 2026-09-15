#!/bin/bash
echo "--- report ---"
docker exec wechat-agent node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/reports.db");
const r = db.prepare("SELECT id, name, items_count, poster_path, run_at FROM reports ORDER BY run_at DESC LIMIT 1").get();
console.log(JSON.stringify(r));
'
echo "--- task ---"
docker exec wechat-agent node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/tasks.db");
const t = db.prepare("SELECT name, enabled, kind, last_run_at, last_error FROM tasks WHERE name = ?").get("每日早报");
console.log(JSON.stringify({ name: t.name, enabled: t.enabled, kind: t.kind, lastRunAt: new Date(t.last_run_at).toISOString(), lastError: t.last_error }));
'
echo "--- poster route ---"
PID=$(docker exec wechat-agent node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/reports.db");
const r = db.prepare("SELECT id FROM reports ORDER BY run_at DESC LIMIT 1").get();
process.stdout.write(r.id);
')
curl -s -o /dev/null -w "poster HTTP %{http_code} %{content_type} %{size_download}B\n" "http://127.0.0.1:8789/reports/$PID/poster"

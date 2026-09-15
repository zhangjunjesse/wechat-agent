#!/bin/bash
echo "--- scheduler code version ---"
docker exec wechat-agent sh -c 'grep -c "runReportTask" /app/src/services/task-scheduler.mjs; grep -c "posterRender" /app/src/services/task-scheduler.mjs'
echo "--- all reports ---"
docker exec wechat-agent node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/reports.db");
console.log(JSON.stringify(db.prepare("SELECT id, run_at, items_count, poster_path FROM reports").all(), null, 1));
'
echo "--- task exact ---"
docker exec wechat-agent node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/tasks.db");
const t = db.prepare("SELECT name, last_run_at, last_error, created_at FROM tasks WHERE name = ?").get("每日早报");
console.log(JSON.stringify({ lastRunAt: new Date(t.last_run_at).toISOString(), lastError: JSON.stringify(t.last_error), createdAt: new Date(t.created_at).toISOString() }));
'

#!/bin/bash
docker exec wechat-agent node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/reports.db");
const r = db.prepare("SELECT id, run_at, items_count, poster_path FROM reports ORDER BY run_at DESC LIMIT 1").get();
console.log(JSON.stringify(r));
'
docker exec wechat-agent node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/tasks.db");
const t = db.prepare("SELECT last_run_at, last_error FROM tasks WHERE name = ?").get("每日早报");
console.log("lastRunAt:", new Date(t.last_run_at).toISOString(), "lastError:", JSON.stringify(t.last_error));
'

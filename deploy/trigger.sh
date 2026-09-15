#!/bin/bash
docker exec wechat-agent node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/tasks.db");
db.prepare("UPDATE tasks SET last_run_at = ? WHERE name = ? AND scope = ?").run(Date.UTC(2026, 8, 14, 0, 0, 0), "每日早报", "global");
console.log("BACKDATED, waiting for next tick (30s) then agent run (~1-3min)...");
'

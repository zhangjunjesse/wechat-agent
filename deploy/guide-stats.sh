#!/bin/bash
docker exec wechat-agent node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/tasks.db");
console.log("=== 订阅者 ===");
const tasks = db.prepare("SELECT name, subscribers FROM tasks WHERE scope = ?").all("global");
for (const t of tasks) console.log(t.name, "subscribers:", JSON.parse(t.subscribers || "[]").length, "人");
console.log("=== 主题订阅（谁设了主题、何时）===");
const topics = db.prepare("SELECT user_id, task_name, topics, updated_at FROM report_topics").all();
if (!topics.length) console.log("(暂无用户设置主题)");
for (const t of topics) console.log(t.user_id, t.task_name, JSON.parse(t.topics).join("/"), "设置于", new Date(t.updated_at).toISOString());
console.log("=== 最近报告（有无个性化版）===");
const rdb = new DatabaseSync("/data/reports.db");
const reps = rdb.prepare("SELECT id, user_id, run_at, items_count FROM reports ORDER BY run_at DESC LIMIT 5").all();
for (const r of reps) console.log(r.id, "user=" + (r.user_id || "公共"), new Date(r.run_at).toISOString(), r.items_count + "条");
'

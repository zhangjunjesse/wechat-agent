#!/bin/bash
docker exec wechat-agent node -e '
const { TaskStore } = require("/app/src/services/task-store.mjs");
const { nextRunAt } = require("/app/src/services/schedule.mjs");
const store = new TaskStore({ file: "/data/tasks.db" });
const tasks = store.getAllEnabled();
console.log("enabled tasks:", tasks.length);
for (const t of tasks) {
  const anchor = t.lastRunAt > 0 ? t.lastRunAt : t.createdAt;
  let next = null, err = null;
  try { next = nextRunAt(t.schedule, anchor); } catch (e) { err = e.message; }
  console.log(JSON.stringify({ name: t.name, kind: t.kind, anchor: new Date(anchor).toISOString(), next: next ? new Date(next).toISOString() : null, due: next ? next <= Date.now() : false, err }));
}
store.close();
'

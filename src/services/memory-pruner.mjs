/** 记忆清理器（DESIGN-memory-lifecycle.md §4.6 轻量路径）。
 *
 * todo 是唯一按「时间规则」自动清理的类别：
 *   - 过期：due > 0 且已过期 > TODO_EXPIRED_DAYS(7) 天 → 归档（reason='expired_todo'）
 *   - 老化：due = 0 且 > TODO_AGED_DAYS(15) 天未更新 → 归档（reason='aged_todo'）
 *
 * 为什么只清 todo：
 *   - identity / preference 是用户画像核心 → 永不自动清理（保护栏）；
 *   - fact / episodic 的价值判断交给第一层评分（memory-importance 的归档阈值），
 *     不按年龄粗暴删除。
 *
 * 清理 = **归档**（status='archived' + payload 进 archived_memories），不是物理删除：
 * 可审计、可回滚。用户显式要求删除（delete_todo 工具）才是物理删除。
 *
 * 阈值集中为常量，env 可覆盖（参数调优，非决策变更）。 */

export const TODO_EXPIRED_DAYS = Number(process.env.TODO_EXPIRED_DAYS || 7)
export const TODO_AGED_DAYS = Number(process.env.TODO_AGED_DAYS || 15)

/** 归档该用户已过期/老化的 todo 卡片。返回计数（供维护日志使用）。 */
export function pruneTodos(store, userId, now = Date.now()) {
  const cards = store.listCategory(userId, 'todo')
  const expired = []
  const aged = []
  for (const card of cards) {
    if (card.due > 0) {
      if ((now - card.due) / 86400000 > TODO_EXPIRED_DAYS) expired.push(card)
    } else {
      const ageDays = (now - Number(card.updatedAt || card.createdAt || now)) / 86400000
      if (ageDays > TODO_AGED_DAYS) aged.push(card)
    }
  }
  let archived = 0
  if (expired.length) archived += store.archive(userId, expired.map((c) => c.id), 'expired_todo', now)
  if (aged.length) archived += store.archive(userId, aged.map((c) => c.id), 'aged_todo', now)
  return { archived, expired: expired.length, aged: aged.length }
}

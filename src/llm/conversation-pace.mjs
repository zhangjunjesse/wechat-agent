import { humanizeGap } from '../services/time.mjs'

/**
 * 会话时间感知（ADR-0015）——该能力的唯一"内容仓库"。
 *
 * 集中管理"时间流逝"相关的所有内容，避免散落在 system-prompt / agent 各处：
 *   1. 阈值配置        GAP_THRESHOLD_MS（超过它才注入间隔提示）
 *   2. 动态注入文案    buildGapLine()（间隔行，注入动态 system）
 *   3. 静态节奏规则    PACE_RULES（对话节奏，拼入静态 instructions）
 *
 * 维护约定：改文案、调阈值、换格式，只改这一个文件；
 * system-prompt 与 agents-sdk-agent 只从这里 import，不各自写文案。
 */

/** 间隔超过该值（默认 2 小时）才注入「距上次对话…」；2 小时内视为连续对话。
 * 可用环境变量 GAP_THRESHOLD_MS 覆盖（毫秒）。 */
export const GAP_THRESHOLD_MS = Number(process.env.GAP_THRESHOLD_MS || 2 * 3600 * 1000)

/** 静态对话节奏规则：只给方向，不写死话术；行为由模型自由发挥。 */
export const PACE_RULES = [
  '【对话节奏】',
  '1. 距上次对话较久（隔天或更久）时：先自然问候，以用户当前意图为主，不主动硬接旧话题；用户提起旧话题才接续，必要时一句话衔接（例如"上次说的X后来怎样了"）。',
  '2. 距上次对话较短（数小时内）：正常连续对话，不提间隔。',
  '3. 打招呼类消息不要长篇回应，简短自然即可。',
  '4. 【长任务节奏】预计需要较长时间（多次工具调用/查大量记录/生成文档图片）的任务：先用 notify_user 说一句"我先去查/处理，稍等"，处理中每完成一个阶段可再用 notify_user 汇报一次（一次任务最多 2-3 次），最后给出完整结果；不要长时间沉默后再一次性倾倒结果。',
]

/** 生成动态间隔行：非首次（updatedAtMs>0）且间隔超过阈值时返回
 * 「距上次对话：4 天 3 小时。」，否则返回空串（调用方不注入）。
 * @param {number} updatedAtMs 上次对话时间戳（epoch ms，0 表示首次）
 * @param {number} nowMs 当前时间戳（默认 Date.now()）
 * @returns {string} 间隔行或空串
 */
export function buildGapLine(updatedAtMs, nowMs = Date.now()) {
  if (!updatedAtMs) return ''
  const gapMs = nowMs - updatedAtMs
  if (gapMs <= GAP_THRESHOLD_MS) return ''
  return `距上次对话：${humanizeGap(gapMs)}。`
}

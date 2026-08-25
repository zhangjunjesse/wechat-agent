import { tool } from '@openai/agents'
import { beijingDateTimeStr, beijingParts } from '../services/time.mjs'

/** Misc tools: current time, skill loading, clarification. */
export function miscTools({ skillRegistry }) {
  const getCurrentTime = tool({
    name: 'get_current_time',
    description: '获取当前准确时间、日期、星期',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const p = beijingParts(Date.now())
      return `${beijingDateTimeStr(Date.now())} 周${'日一二三四五六'[p.weekday]}`
    },
  })

  const useSkill = tool({
    name: 'use_skill',
    description: [
      '加载一个技能的完整指令。系统提示词里的"可用技能"列表只有名字和一句话描述——一旦用户需求匹配其中某个技能，这是强制要求：必须先调用本工具加载该技能完整指令，再据此执行，不要凭猜测直接执行、也不要只是提到某技能存在却不实际调用。',
      '同一技能在本轮对话中已加载过，无需重复调用；若已在之前的工具结果里看到过其完整指令，直接照做即可。',
    ].join('\n'),
    parameters: { type: 'object', properties: { name: { type: 'string', description: '技能名（对应可用技能列表里的名字）' } }, required: ['name'] },
    execute: async (input, ctx) => {
      const userId = ctx?.context?.userId
      const enabledGlobal = skillRegistry.resolveEnabled(ctx?.context?.profile?.enabledSkills)
      const skill = skillRegistry.get(userId, input.name, enabledGlobal)
      if (!skill) return `技能「${input.name}」不存在。可用：${skillRegistry.list(userId, enabledGlobal).map((s) => s.name).join(', ') || '无'}`
      const loaded = ctx?.context?.loadedSkills
      if (loaded?.has(input.name)) return `技能「${input.name}」本轮已加载过，请直接按之前返回的指令执行，无需重复加载。`
      loaded?.add(input.name)
      return `【技能 ${skill.name}】${skill.instructions}`
    },
  })

  const askUser = tool({
    name: 'ask_user',
    description: '当信息不足、有多个候选或需要用户确认时，向用户提问（例如"为哪辆车预约保养"）。返回后等用户回答。',
    parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    execute: async (input) => `[需要用户澄清] ${input.question}`,
  })

  return { getCurrentTime, useSkill, askUser }
}

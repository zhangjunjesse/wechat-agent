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
    description: '加载一个已注册技能的详细指令（当用户需求匹配某个技能时使用）',
    parameters: { type: 'object', properties: { name: { type: 'string', description: '技能名' } }, required: ['name'] },
    execute: async (input) => {
      const skill = skillRegistry.get(input.name)
      return skill ? `【技能 ${skill.name}】${skill.instructions}` : `技能「${input.name}」不存在。可用：${skillRegistry.list().map((s) => s.name).join(', ') || '无'}`
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

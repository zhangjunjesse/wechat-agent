import { tool } from '@openai/agents'

/** 技能运行时管理工具（ADR-0013 设计第 3 块）。仅当 ADMIN_SKILLS=1 时由
 * buildTools 注册——运维/管理员通过对话热增删改全局技能，立即生效无需重启。
 *
 * 安全边界：写入只允许 SKILL.md（name 校验 + frontmatter 校验 + 大小上限，见
 * SkillRegistry.addSkill）；remove 只接受合法技能名。用户私有技能不在此管理范围。 */
export function manageSkillTools({ skillRegistry }) {
  const manageSkill = tool({
    name: 'manage_skill',
    description:
      '管理全局技能（管理员）：add/update 新增或更新一个技能（name + 完整 SKILL.md 内容，frontmatter 必须含 name/description），' +
      'remove 删除一个技能，list 查看全部。写入立即可用，无需重启。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'remove', 'list'], description: '操作类型' },
        name: { type: 'string', description: '技能名（小写字母/数字/连字符）' },
        content: { type: 'string', description: 'SKILL.md 完整内容（add/update 必填，含 frontmatter）' },
      },
      required: ['action'],
    },
    execute: async (input) => {
      if (input.action === 'list') {
        const list = skillRegistry.listGlobal()
        if (!list.length) return '当前没有任何全局技能。'
        return list.map((s) => `- ${s.name}${s.version ? ` v${s.version}` : ''}: ${s.description}`).join('\n')
      }
      if (input.action === 'remove') {
        const r = skillRegistry.removeSkill({ name: input.name })
        return r.ok ? `已删除技能：${input.name}` : `删除失败：${r.error}`
      }
      if (input.action === 'add' || input.action === 'update') {
        if (!input.name || !input.content) return 'add/update 需要 name 和 content（SKILL.md 完整内容）'
        const r = skillRegistry.addSkill({ name: input.name, content: input.content })
        return r.ok ? `已${input.action === 'update' ? '更新' : '新增'}技能：${input.name}` : `写入失败：${r.error}`
      }
      return `未知操作：${input.action}`
    },
  })
  return { manageSkill }
}

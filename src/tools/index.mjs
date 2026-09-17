import { fileTools } from './file-tools.mjs'
import { codeTools } from './code-tools.mjs'
import { webTools } from './web-tools.mjs'
import { todoTools } from './todo-tools.mjs'
import { miscTools } from './misc-tools.mjs'
import { wechatTools } from './wechat-tools.mjs'
import { wechatSendTools } from './wechat-send-tools.mjs'
import { binaryFileTools } from './binary-file-tools.mjs'
import { gzhTools } from './gzh-tools.mjs'
import { manageSkillTools } from './manage-skill-tools.mjs'
import { imageTools } from './image-tools.mjs'
import { posterTools } from './poster-tools.mjs'
import { larkTools } from './lark-tools.mjs'
import { taskTools } from './task-tools.mjs'
import { groupTagTools } from './group-tag-tools.mjs'
import { expertModeTools } from './expert-mode-tools.mjs'

/** Assemble the full tool set for the agent. All tools read userId from run
 * context (ctx.context.userId) so per-user sandboxing and data isolation hold.
 *
 * `wechatLogStore` is optional: when not configured (no WECHAT_LOG_DB / no
 * mounted sync DB — e.g. local dev, tests) the wechat_* tools are simply
 * omitted rather than registered broken.
 *
 * `issueDownloadLink(userId, relPath) => url|null` is optional: when provided
 * (see server.mjs), write_file and run_code return a real, fetchable URL for
 * files they write (ADR-0008) — the universal fallback that works on any
 * channel, including the web chat which has no WeChat session to send through.
 *
 * `provider` (optional) is the ILinkProvider instance, wired into `send_file`
 * (ADR-0009) so it can push a real WeChat file attachment when the current
 * turn's run-context `channel` says we're on a WeChat conversation.
 *
 * `wechatMediaDir` (optional) is the wechat-sync media directory (same mount
 * as the sync DB) for wechat_fetch_chat_file (ADR-0029); when absent the tool
 * still registers but honestly reports it can't fetch file bytes.
 *
 * `vision` (optional) is a VisionClient instance (ADR-0030): only when
 * VISION_MODEL is configured does image_describe get registered — same
 * "config missing → feature silently absent" pattern as lark/wechat_*.
 *
 * `expertMode` (optional, ADR-0033) is `{ store, ttlMs, expertModel }`: only when
 * an expert model is configured does `set_expert_mode` get registered — same
 * "config missing → feature silently absent" pattern as lark/vision. It is
 * deliberately NOT passed for the delegation subagent tool set (ADR-0024): a
 * background task must not flip the user's interactive model out from under him.
 *
 * `use_skill` is NOT assembled here: it carries the per-user skill catalog in
 * its description and is built per turn by AgentsSdkAgent (ADR-0013).
 * `manage_skill` is only registered when ADMIN_SKILLS=1 (runtime skill
 * management, see ADR-0013). */
export function buildTools({ memoryManager, skillRegistry, fetchImpl, wechatLogStore, wechatMediaDir, root, issueDownloadLink, provider, taskStore, reportStore, reportUrl = null, lark, vision = null, groupProfiles = null, expertMode = null }) {
  const files = fileTools({ root, issueDownloadLink })
  const code = codeTools()
  const web = webTools({ fetchImpl })
  const todos = todoTools({ memoryManager })
  const misc = miscTools({ skillRegistry })
  const send = wechatSendTools({ provider, root })
  const binary = binaryFileTools({ root, issueDownloadLink })
  const gzh = gzhTools()
  const image = imageTools({ root, vision })
  const poster = posterTools({ root })
  const tools = [
    files.readFile, files.writeFile, files.listFiles,
    code.runCode,
    binary.createXlsx, binary.createDocx, binary.createPdf,
    web.getWeather, web.webFetch,
    todos.addTodo, todos.listTodo,
    misc.getCurrentTime, misc.askUser,
    send.sendFile,
    send.notifyUser,
    gzh.gzhSearch, gzh.gzhContent,
    image.imageGenerate,
    poster.renderPoster,
  ]
  // 视觉理解（ADR-0030）：VISION_MODEL 未配置时 vision 为 null，工具压根不存在
  if (image.imageDescribe) tools.push(image.imageDescribe)
  // 专家模式（ADR-0033）：未配置 EXPERT_MODEL 时 expertMode 为 null，工具不注册
  if (expertMode?.store) {
    const expert = expertModeTools({ store: expertMode.store, ttlMs: expertMode.ttlMs, expertModel: expertMode.expertModel })
    tools.push(expert.setExpertMode)
  }
  if (process.env.ADMIN_SKILLS === '1') {
    const manage = manageSkillTools({ skillRegistry })
    tools.push(manage.manageSkill)
  }
  if (taskStore) {
    const tasks = taskTools({ taskStore, reportStore, provider, reportUrl })
    tools.push(tasks.createTask, tasks.listMyTasks, tasks.deleteTask, tasks.listGlobalTasks, tasks.subscribeTask, tasks.unsubscribeTask)
    tools.push(tasks.updateReportTopics, tasks.listReportTopics)
    // resend_daily_report 也随 reportStore 门控（ADR-0026）：子 agent 走
    // taskStore:null/reportStore:null 的受限工具集，这两个都不会被注册。
    if (reportStore) tools.push(tasks.getDailyReport, tasks.resendDailyReport)
  }
  if (wechatLogStore) {
    const wechat = wechatTools({ wechatLogStore, root, mediaDir: wechatMediaDir })
    tools.push(wechat.wechatListChats, wechat.wechatSearchChat, wechat.wechatSearchMentions, wechat.wechatSearchMyMessages, wechat.wechatFetchChatFile)
    // 群画像纠正（DESIGN-wechat-digest.md）：同时需要 groupProfiles（写入）与
    // wechatLogStore（解析群名 + 权限边界），两者缺一就不注册。
    if (groupProfiles) {
      const groupTags = groupTagTools({ groupProfiles, wechatLogStore })
      tools.push(groupTags.listGroupTags, groupTags.setGroupTag)
    }
  }
  if (lark?.client) {
    // 飞书文档（ADR-0021）：仅在配置 LARK_APP_ID/SECRET 时注册；redirectUri 供 OAuth 回调
    const basePath = process.env.PUBLIC_BASE_PATH || '/wechat-agent/'
    const redirectUri = `${(process.env.PUBLIC_BASE_URL || 'https://datadefender.cn').replace(/\/$/, '')}${basePath}lark/auth/callback`
    const larkToolsSet = larkTools({ client: lark.client, redirectUri })
    tools.push(larkToolsSet.larkAuth, larkToolsSet.larkAuthStatus, larkToolsSet.larkSearchDocs, larkToolsSet.larkReadDoc, larkToolsSet.larkCreateDoc, larkToolsSet.larkEditDoc, larkToolsSet.larkExportDoc)
  }
  return tools
}

import { fileTools } from './file-tools.mjs'
import { codeTools } from './code-tools.mjs'
import { webTools } from './web-tools.mjs'
import { todoTools } from './todo-tools.mjs'
import { miscTools } from './misc-tools.mjs'
import { wechatTools } from './wechat-tools.mjs'
import { wechatSendTools } from './wechat-send-tools.mjs'

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
 * turn's run-context `channel` says we're on a WeChat conversation. */
export function buildTools({ memoryManager, skillRegistry, fetchImpl, wechatLogStore, root, issueDownloadLink, provider }) {
  const files = fileTools({ root, issueDownloadLink })
  const code = codeTools()
  const web = webTools({ fetchImpl })
  const todos = todoTools({ memoryManager })
  const misc = miscTools({ skillRegistry })
  const send = wechatSendTools({ provider, root })
  const tools = [
    files.readFile, files.writeFile, files.listFiles,
    code.runCode,
    web.getWeather, web.webFetch,
    todos.addTodo, todos.listTodo,
    misc.getCurrentTime, misc.useSkill, misc.askUser,
    send.sendFile,
  ]
  if (wechatLogStore) {
    const wechat = wechatTools({ wechatLogStore })
    tools.push(wechat.wechatListChats, wechat.wechatSearchChat, wechat.wechatSearchMentions, wechat.wechatSearchMyMessages)
  }
  return tools
}

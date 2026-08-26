import { fileTools } from './file-tools.mjs'
import { codeTools } from './code-tools.mjs'
import { webTools } from './web-tools.mjs'
import { todoTools } from './todo-tools.mjs'
import { miscTools } from './misc-tools.mjs'
import { wechatTools } from './wechat-tools.mjs'

/** Assemble the full tool set for the agent. All tools read userId from run
 * context (ctx.context.userId) so per-user sandboxing and data isolation hold.
 *
 * `wechatLogStore` is optional: when not configured (no WECHAT_LOG_DB / no
 * mounted sync DB — e.g. local dev, tests) the wechat_* tools are simply
 * omitted rather than registered broken.
 *
 * `issueDownloadLink(userId, relPath) => url|null` is optional: when provided
 * (see server.mjs), write_file and run_code return a real, fetchable URL for
 * files they write — see ADR-0008 for why that link is the only way a WeChat
 * user can ever get the file (no file-send in the bot channel, no browse UI
 * on the web). Omitted in tests/local dev, where tools just skip the link. */
export function buildTools({ memoryManager, skillRegistry, fetchImpl, wechatLogStore, root, issueDownloadLink }) {
  const files = fileTools({ root, issueDownloadLink })
  const code = codeTools()
  const web = webTools({ fetchImpl })
  const todos = todoTools({ memoryManager })
  const misc = miscTools({ skillRegistry })
  const tools = [
    files.readFile, files.writeFile, files.listFiles,
    code.runCode,
    web.getWeather, web.webFetch,
    todos.addTodo, todos.listTodo,
    misc.getCurrentTime, misc.useSkill, misc.askUser,
  ]
  if (wechatLogStore) {
    const wechat = wechatTools({ wechatLogStore })
    tools.push(wechat.wechatListChats, wechat.wechatSearchChat, wechat.wechatSearchMentions, wechat.wechatSearchMyMessages)
  }
  return tools
}

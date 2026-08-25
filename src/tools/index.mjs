import { fileTools } from './file-tools.mjs'
import { webTools } from './web-tools.mjs'
import { todoTools } from './todo-tools.mjs'
import { miscTools } from './misc-tools.mjs'
import { wechatTools } from './wechat-tools.mjs'

/** Assemble the full tool set for the agent. All tools read userId from run
 * context (ctx.context.userId) so per-user sandboxing and data isolation hold.
 *
 * `wechatLogStore` is optional: when not configured (no WECHAT_LOG_DB / no
 * mounted sync DB — e.g. local dev, tests) the wechat_* tools are simply
 * omitted rather than registered broken. */
export function buildTools({ memoryManager, skillRegistry, fetchImpl, wechatLogStore }) {
  const files = fileTools()
  const web = webTools({ fetchImpl })
  const todos = todoTools({ memoryManager })
  const misc = miscTools({ skillRegistry })
  const tools = [
    files.readFile, files.writeFile, files.listFiles,
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

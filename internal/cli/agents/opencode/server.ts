import { renameSync, writeFileSync } from "node:fs"

const statusFile = new URL("../status.json", import.meta.url)
const headerNames = ["x-dari-selected-model", "x-dari-thinking-level", "x-dari-lease-turns-remaining", "x-dari-session-pinned", "x-request-id"]

// The server half of OpenCode's Dari status. It tags each request with its
// kind and agent, reads each Dari response's routing headers, and writes the
// rendered status per session next to the plugin. The file lives outside the
// plugin directory so status writes do not trigger OpenCode's plugin reloads. The launcher supplies the status renderer through the
// environment.
export default {
  id: "dari.status",
  setup: async (ctx: any) => {
    const executable = process.env.DARI_STATUS_EXECUTABLE
    // OpenCode names the session but not the kind of request or the agent;
    // Dari uses both to split Activity into main, subagent, and background work.
    await ctx.session.hook("model.request", (event: any) => {
      event.headers["x-opencode-request-kind"] = event.kind
      event.headers["x-opencode-agent"] = event.agent
    }, { providerID: "dari" })
    const statuses: Record<string, string> = {}
    const routes: Record<string, Record<string, string>> = {}
    const generations: Record<string, number> = {}
    // Only the most recently started render per session may write; each one
    // reads the current state, so an older result is stale. The write and
    // rename run synchronously, so they never interleave.
    const render = async (sessionID: string) => {
      if (!executable) return
      const generation = generations[sessionID] = (generations[sessionID] ?? 0) + 1
      const args = ["agent-status", "--headers", JSON.stringify(routes[sessionID])]
      const child = Bun.spawn([executable, ...args], { stdout: "pipe", stderr: "ignore" })
      const status = (await new Response(child.stdout).text()).trim()
      if ((await child.exited) !== 0 || !status || generations[sessionID] !== generation) return
      statuses[sessionID] = status
      const temporary = new URL("../status.json.tmp", import.meta.url)
      writeFileSync(temporary, JSON.stringify(statuses))
      renameSync(temporary, statusFile)
    }
    await ctx.session.hook("http.response", async (event: any) => {
      const response = event.response.headers
      if (event.kind !== "primary" || !response.get(headerNames[0])) return
      routes[event.sessionID] = Object.fromEntries(headerNames.filter(name => response.has(name)).map(name => [name, response.get(name)]))
      render(event.sessionID).catch(() => {})
    }, { providerID: "dari" })
  },
}

// The TUI half of OpenCode's Dari status: shows the prompt's session status in
// its footer, reading what the server half writes.
import { readFileSync } from "node:fs"
import { createSignal, Show } from "solid-js"

const statusFile = new URL("../status.json", import.meta.url)

export default {
  id: "dari.status",
  setup(context: any) {
    const [statuses, setStatuses] = createSignal<Record<string, string>>({})
    let last = ""
    const timer = setInterval(() => {
      try {
        const content = readFileSync(statusFile, "utf8")
        if (content !== last) setStatuses(JSON.parse((last = content)))
      } catch {}
    }, 500)
    context.ui.slot({
      append: "prompt.footer.status",
      render: (input: { sessionID?: string }) => (
        <Show when={input.sessionID && statuses()[input.sessionID]}>
          <text fg={context.theme.text.muted}>{statuses()[input.sessionID!]}</text>
        </Show>
      ),
    })
    return () => clearInterval(timer)
  },
}

import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"

const id = "internal:waveterm"
let queue = Promise.resolve()

function send(args: string[]) {
  queue = queue.then(async () => {
    try {
      const process = Bun.spawn({ cmd: ["wsh", "agentnotify", "--agent", "opencode", ...args], stdout: "ignore", stderr: "ignore" })
      await process.exited
    } catch {
      // Outside WaveTerm, wsh is unavailable and notifications are intentionally disabled.
    }
  })
}

function isShellError(output: string) {
  return /command not found|permission denied|no such file or directory|not recognized as an internal or external command/i.test(output)
}

const tui: TuiPlugin = async (api) => {
  if (!process.env.WAVETERM_JWT || !process.env.WAVETERM_BLOCKID) return

  const owned = new Set<string>()
  const waiting = new Set<string>()
  const errored = new Set<string>()

  function owns(sessionID: string) {
    return owned.has(sessionID) && !api.state.session.get(sessionID)?.parentID
  }

  function notify(sessionID: string, status: string, message: string, lifecycle = "terminal", beep = false) {
    if (!owns(sessionID)) return
    const args = ["--status", status, "--lifecycle", lifecycle]
    if (beep) args.push("--beep")
    args.push(message)
    send(args)
  }

  // The slot runs in this TUI process, establishing ownership without relying on
  // server-global events that are shared by every attached client.
  api.slots.register({
    slots: {
      session_prompt(_ctx, props) {
        owned.add(props.session_id)
        return null
      },
    },
  })

  api.event.on("session.status", (event) => {
    const sessionID = event.properties.sessionID
    if (!owns(sessionID)) return
    if (event.properties.status.type === "busy" || event.properties.status.type === "retry") {
      if (!waiting.has(sessionID) && !errored.has(sessionID)) notify(sessionID, "info", "Working...", "intermediate")
      return
    }
    if (event.properties.status.type === "idle") {
      waiting.delete(sessionID)
      if (errored.delete(sessionID)) return
      notify(sessionID, "completion", "Session complete")
    }
  })

  api.event.on("question.asked", (event) => {
    const sessionID = event.properties.sessionID
    if (!owns(sessionID)) return
    waiting.add(sessionID)
    const question = event.properties.questions[0]
    notify(sessionID, "question", question?.question || question?.header || "Input required", "terminal", true)
  })

  api.event.on("question.replied", (event) => waiting.delete(event.properties.sessionID))
  api.event.on("question.rejected", (event) => waiting.delete(event.properties.sessionID))

  api.event.on("permission.asked", (event) => {
    const sessionID = event.properties.sessionID
    if (!owns(sessionID)) return
    waiting.add(sessionID)
    const pattern = event.properties.patterns[0]
    notify(sessionID, "question", pattern ? `${event.properties.permission}: ${pattern}` : `${event.properties.permission} permission required`, "terminal", true)
  })

  api.event.on("permission.replied", (event) => waiting.delete(event.properties.sessionID))

  api.event.on("message.part.updated", (event) => {
    const part = event.properties.part
    if (part.type !== "tool" || !owns(part.sessionID)) return
    if (part.state.status === "running") {
      errored.delete(part.sessionID)
      if (!waiting.has(part.sessionID)) notify(part.sessionID, "info", part.state.title || part.tool, "intermediate")
      return
    }
    if (part.state.status === "error") {
      errored.add(part.sessionID)
      notify(part.sessionID, "error", part.state.error)
      return
    }
    if (part.state.status !== "completed") return
    const output = part.state.output || String(part.state.metadata?.output || "")
    const exit = part.state.metadata?.exit ?? part.state.metadata?.exitCode ?? part.state.metadata?.exit_code
    if ((exit !== undefined && Number(exit) !== 0) || (part.tool === "bash" && isShellError(output))) {
      errored.add(part.sessionID)
      notify(part.sessionID, "error", output || `Exit code ${exit}`)
    }
  })

  api.event.on("session.error", (event) => {
    const sessionID = event.properties.sessionID
    if (!sessionID || !owns(sessionID)) return
    errored.add(sessionID)
    notify(sessionID, "error", "Session error")
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }

export default plugin

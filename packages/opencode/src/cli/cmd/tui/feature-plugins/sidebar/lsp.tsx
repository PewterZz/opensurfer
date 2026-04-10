import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, For, Show } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useRoute } from "@tui/context/route"
import { Locale } from "@/util/locale"

const id = "internal:sidebar-lsp"

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const sync = useSync()
  const route = useRoute()

  const currentSessionID = createMemo(() =>
    route.data.type === "session" ? route.data.sessionID : undefined,
  )

  const sessions = createMemo(() =>
    sync.data.session
      .filter((s) => !s.parentID)
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .slice(0, 20),
  )

  return (
    <box gap={1}>
      <text fg={theme().text}>
        <b>History</b>
      </text>
      <Show when={sessions().length === 0}>
        <text fg={theme().textMuted}>No previous sessions</text>
      </Show>
      <For each={sessions()}>
        {(session) => {
          const isCurrent = createMemo(() => session.id === currentSessionID())
          const isWorking = createMemo(
            () => sync.data.session_status?.[session.id]?.type === "busy",
          )
          return (
            <box
              flexDirection="row"
              gap={1}
              onMouseUp={() => {
                if (isCurrent()) return
                props.api.route.navigate("session", { sessionID: session.id })
              }}
            >
              <text
                flexShrink={0}
                fg={
                  isCurrent()
                    ? theme().primary
                    : isWorking()
                      ? theme().success
                      : theme().textMuted
                }
              >
                {isCurrent() ? "●" : isWorking() ? "◉" : "○"}
              </text>
              <box flexGrow={1} overflow="hidden">
                <text
                  fg={isCurrent() ? theme().primary : theme().text}
                  wrapMode="none"
                  overflow="hidden"
                >
                  {session.title}
                </text>
                <text fg={theme().textMuted}>{Locale.time(session.time.updated)}</text>
              </box>
            </box>
          )
        }}
      </For>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 300,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin

/**
 * MARK: task-start — docs/PROTOCOL.md §63.3 on Windows, what the Mac's `AppState` does for the start screen and the task
 * dialog: read a GitHub issue (`task_fetch`), start straight away (the window's empty chat, else a fresh one), start a task
 * in this window (`create_branch`, a fresh chat when the current one holds a conversation, the first prompt) and put the
 * first prompt where the chat takes text — the composer, or a terminal chat's prompt as one bracketed paste (never Enter),
 * retried for up to 30 s while its Claude Code starts. Nothing here ever sends the prompt.
 */
import type { ReviewState, SessionCapabilities, SessionMeta, TaskFetchedEvent } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import { t } from "./i18n";
import { insertIntoComposer } from "./composerBridge";
import { defaultChatKind } from "./continueTerminal";
import { sessionsOf } from "./sessions";
import { useStore } from "./store";
import { liveTerminalChatId, pasteIntoLiveTerminal } from "./terminal/terminalChat";
import { ptyAvailable } from "./terminal/ptyInfo";
import { pastedText } from "./terminalPaste";
import { showToast } from "./toast";
import { hideStartScreen } from "./startScreen";
import { needsNewChat, taskFetchRefusal, type FetchedTask } from "./taskStart";

type Bridge = Parameters<typeof engineRequest>[1];

const log = (line: string) => useStore.setState((s) => ({ logs: [...s.logs, line].slice(-500) }));

/** `task_fetch {ref}`: the GitHub issue, or an Error whose message says why in the user's words. */
export async function fetchTask(ref: string, bridge?: Bridge): Promise<FetchedTask> {
  try {
    const reply = (await engineRequest({ type: "task_fetch", ref }, bridge)) as TaskFetchedEvent;
    const task = reply.task;
    return {
      id: typeof task?.id === "string" && task.id ? task.id : String(task?.number ?? ""),
      ...(typeof task?.number === "number" ? { number: task.number } : {}),
      title: typeof task?.title === "string" ? task.title : "",
      body: typeof task?.body === "string" ? task.body : "",
      url: typeof task?.url === "string" ? task.url : "",
      labels: Array.isArray(task?.labels) ? task.labels.filter((l): l is string => typeof l === "string") : [],
    };
  } catch (e) {
    const r = refusalOf(e);
    log(`[info] task_fetch: ${r.error}`);
    throw new Error(taskFetchRefusal(r.code, r.detail) ?? refusalMessage(r));
  }
}

/** The MCP servers a task can be read with: the live session's, else the ones it reported at start, by name. */
export function taskMcpServerNames(live: readonly { name: string }[], capabilities: SessionCapabilities | null | undefined, cached?: SessionCapabilities | null): string[] {
  const names = [...live, ...(capabilities?.mcpServers ?? []), ...(cached?.mcpServers ?? [])].map((m) => m.name);
  return [...new Set(names.filter((n) => n.length > 0))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

const currentChat = (state: ReviewState): SessionMeta | null => {
  const sessions = sessionsOf(state);
  return sessions.list.find((m) => m.id === sessions.currentId) ?? null;
};

/** 바로 시작: the window's chat when it is still empty, else a fresh one (Settings' kind). */
export async function startStraight(): Promise<void> {
  const s = useStore.getState();
  if (needsNewChat(currentChat(s.state))) await s.newChat();
}

/**
 * 업무로 시작 in this window: the branch (`name`; null in a folder tracked without git), a fresh chat when the current one
 * holds a conversation, then `prompt` where that chat takes text — never sent. Returns why it stopped (null: done).
 */
export async function startTaskHere(name: string | null, prompt: string, bridge?: Bridge): Promise<string | null> {
  if (name !== null) {
    try {
      await engineRequest({ type: "create_branch", name }, bridge);
      await useStore.getState().settle();
    } catch (e) {
      const r = refusalOf(e);
      log(`[warn] create_branch: ${r.error}`);
      return refusalMessage(r);
    }
  }
  const s = useStore.getState();
  let terminal = currentChat(s.state)?.kind === "terminal";
  if (needsNewChat(currentChat(s.state))) {
    if (!(await s.newChat())) return useStore.getState().lastError ?? t("Could not open a new chat");
    terminal = defaultChatKind(useStore.getState().settings, ptyAvailable()) === "terminal";
  }
  deliverFirstPrompt(prompt, terminal);
  return null;
}

/** What `deliverFirstPrompt` does with the window (the live ones by default; tests pass their own). */
export type FirstPromptIO = {
  /** The window's current chat is known (a new workbench's draft can come before the snapshot that names its chat). */
  chatKnown(): boolean;
  isTerminal(): boolean;
  /** The bracketed paste into the live terminal chat's prompt: null when it went in, else why not (yet). */
  paste(text: string): string | null;
  insert(text: string): void;
  notify(text: string): void;
  log(line: string): void;
};

const liveIO: FirstPromptIO = {
  chatKnown: () => currentChat(useStore.getState().state) !== null,
  isTerminal: () => liveTerminalChatId(useStore.getState().state) !== null,
  paste: (text) => pasteIntoLiveTerminal(text),
  insert: (text) => void insertIntoComposer(text),
  notify: (text) => showToast(text),
  log,
};

export const FIRST_PROMPT_TRIES = 100;
export const FIRST_PROMPT_STEP_MS = 300;
let firstPromptTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The task's first prompt where the chat takes text: the composer, or — a terminal chat — its Claude Code's prompt as one
 * bracketed paste, never Enter, retried every 0.3 s for up to 30 s while it starts (then the composer, with the reason).
 * `terminal` undefined: the current chat's kind once the window knows it. A later prompt replaces one still waiting.
 */
export function deliverFirstPrompt(text: string, terminal?: boolean, io: FirstPromptIO = liveIO): void {
  if (!text) return;
  if (firstPromptTimer) clearTimeout(firstPromptTimer);
  firstPromptTimer = null;
  hideStartScreen();
  let tries = 0;
  const step = () => {
    firstPromptTimer = null;
    if (terminal !== undefined || io.chatKnown()) {
      if (!(terminal ?? io.isTerminal())) return io.insert(text);
      if (io.isTerminal() && io.paste(text) === null) return io.notify(pastedText());
    }
    tries += 1;
    if (tries >= FIRST_PROMPT_TRIES) {
      const why = t("The task's first prompt could not go into the terminal — it is in the message box of a chat instead");
      io.log(`[warn] task-start: ${why}`);
      io.insert(text);
      io.notify(why);
      return;
    }
    firstPromptTimer = setTimeout(step, FIRST_PROMPT_STEP_MS);
  };
  step();
}

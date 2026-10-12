/**
 * MARK: wave5 w5-board — docs/PROTOCOL.md §43.1: the agent board's avatars, the same rule as the Mac's Core `AgentAvatar`
 * (both checked against engine/test/fixtures/agentAvatars.json): one round face per agent type (an icon and a pastel tone;
 * a type the table does not know is the sparkle robot in its identity color), the icon of the tool an agent runs, the
 * Korean names of the frequent MCP servers' tools ("두레이 업무 읽기"), the agent's mood, the board's summary line and the
 * tab the board remembers per project.
 */
import type { AgentNode } from "@reviewgate/engine";
import { currentLanguage, t } from "./i18n";
import { stepLine, stepOf, toolTitle } from "./agentGlance";
import { toolLabel } from "./toolLabel";
import { agentTypeLabel } from "./agents";

export const AVATAR_TONES = [
  "coral", "peach", "butter", "lime", "leaf", "mint", "teal", "sky", "periwinkle", "lavender", "grape", "pink", "rose", "sand", "slate", "claude",
] as const;
export type AvatarTone = (typeof AVATAR_TONES)[number];

export type AvatarIcon =
  | "hammer" | "compass" | "binoculars" | "flask" | "brush" | "pencil" | "glasses" | "shield" | "bug" | "map" | "scales" | "atom"
  | "stamp" | "book" | "branch" | "footprints" | "checklist" | "robot" | "claude";

export type AgentAvatar = { icon: AvatarIcon; tone: AvatarTone; name: string; badge: string | null };

const KNOWN: Record<string, [AvatarIcon, AvatarTone]> = {
  executor: ["hammer", "coral"],
  architect: ["compass", "sky"],
  explore: ["binoculars", "mint"],
  "test-engineer": ["flask", "lavender"],
  designer: ["brush", "pink"],
  writer: ["pencil", "butter"],
  "code-reviewer": ["glasses", "teal"],
  "security-reviewer": ["shield", "periwinkle"],
  debugger: ["bug", "lime"],
  planner: ["map", "peach"],
  plan: ["map", "peach"],
  critic: ["scales", "rose"],
  scientist: ["atom", "grape"],
  verifier: ["stamp", "leaf"],
  "document-specialist": ["book", "sand"],
  "git-master": ["branch", "peach"],
  tracer: ["footprints", "slate"],
  "qa-tester": ["checklist", "mint"],
};

/** By identity color (the Mac's `AgentIdentity.colorIndex`) for a type the table does not know. */
const BY_IDENTITY: AvatarTone[] = ["teal", "periwinkle", "pink", "lavender", "mint", "sky", "sand", "butter"];

/** The Mac's `AgentIdentity.colorIndex`: FNV-1a (32-bit) over the UTF-8 of the type without its plugin, bits 13 up, mod 8. */
export function identityIndex(type: string): number {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(agentTypeLabel(type))) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return (hash >>> 13) % 8;
}

/** The plugin as a small badge: `oh-my-claudecode:executor` → "OMC", `acme-tools:smoke` → "acme-tools" (Mac `pluginBadge`). */
export function pluginBadge(type: string): string | null {
  const i = type.lastIndexOf(":");
  if (i < 0) return null;
  const prefix = type.slice(0, i).trim();
  if (!prefix) return null;
  if (prefix === "oh-my-claudecode" || prefix === "omc") return "OMC";
  return [...prefix].length > 12 ? [...prefix].slice(0, 11).join("") + "…" : prefix;
}

export function avatarOf(type: string): AgentAvatar {
  const name = agentTypeLabel(type);
  const badge = pluginBadge(type);
  const known = KNOWN[name.toLowerCase()];
  if (known) return { icon: known[0], tone: known[1], name, badge };
  return { icon: "robot", tone: BY_IDENTITY[identityIndex(type)] ?? "teal", name, badge };
}

export const MAIN_AVATAR: AgentAvatar = { icon: "claude", tone: "claude", name: "", badge: null };

export type ToolIcon =
  | "doc" | "pencil" | "terminal" | "magnifier" | "globe" | "sparkles" | "agent" | "checklist" | "plug" | "dooray" | "database"
  | "searchCluster" | "browser" | "wrench";

type McpServerKind = "dooray" | "mysql" | "elasticsearch" | "chrome";

export function mcpServerKind(server: string): McpServerKind | null {
  const s = server.toLowerCase();
  if (s.includes("dooray")) return "dooray";
  if (s.includes("mysql")) return "mysql";
  if (s.includes("elastic")) return "elasticsearch";
  if (s.includes("chrome")) return "chrome";
  return null;
}

export function toolIconOf(tool: string): ToolIcon {
  switch (tool) {
    case "Read":
    case "NotebookRead":
      return "doc";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "pencil";
    case "Bash":
    case "BashOutput":
    case "KillShell":
    case "KillBash":
    case "PowerShell":
      return "terminal";
    case "Grep":
    case "Glob":
    case "LS":
    case "ToolSearch":
      return "magnifier";
    case "WebFetch":
    case "WebSearch":
      return "globe";
    case "Skill":
      return "sparkles";
    case "Agent":
    case "Task":
    case "SendMessage":
      return "agent";
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return "checklist";
  }
  const l = toolLabel(tool);
  if (l.kind !== "mcp") return "wrench";
  switch (mcpServerKind(l.server ?? "")) {
    case "dooray":
      return "dooray";
    case "mysql":
      return "database";
    case "elasticsearch":
      return "searchCluster";
    case "chrome":
      return "browser";
    default:
      return "plug";
  }
}

type Words = [ko: string, en: string];
const readTask: Words = ["업무 읽기", "read a task"];
const editTask: Words = ["업무 고치기", "update a task"];
const projects: Words = ["프로젝트 보기", "read projects"];
const wiki: Words = ["위키 읽기", "read the wiki"];
const members: Words = ["멤버 보기", "look up members"];
const pickBrowser: Words = ["브라우저 고르기", "pick a browser"];
const upload: Words = ["파일 올리기", "upload a file"];

const ACTIONS: Record<McpServerKind, Record<string, Words>> = {
  dooray: {
    get_posts: ["업무 읽기", "read tasks"],
    get_post_detail: readTask,
    get_post_by_id: readTask,
    get_post_with_comments: ["업무·댓글 읽기", "read a task and its comments"],
    get_post_comments: ["댓글 읽기", "read comments"],
    add_post_comment: ["댓글 달기", "add a comment"],
    update_post_comment: ["댓글 고치기", "edit a comment"],
    search_posts: ["업무 찾기", "search tasks"],
    find_posts_across_projects: ["업무 찾기", "search tasks"],
    create_post: ["업무 만들기", "create a task"],
    update_post: editTask,
    update_post_users: editTask,
    bulk_update_post_status: editTask,
    bulk_close_posts: editTask,
    add_post_tag: editTask,
    get_projects: projects,
    get_project_detail: projects,
    get_project_workflows: projects,
    get_wiki_page: wiki,
    get_wiki_pages: wiki,
    get_wikis: wiki,
    search_wiki_pages: ["위키 찾기", "search the wiki"],
    create_wiki_page: ["위키 쓰기", "write a wiki page"],
    update_wiki_page: ["위키 고치기", "edit a wiki page"],
    get_my_info: members,
    get_member: members,
    search_members: members,
    get_members_by_email: members,
    download_post_file: ["첨부 받기", "download an attachment"],
  },
  mysql: {
    execute_query: ["쿼리 실행", "run a query"],
    describe_table: ["테이블 구조 보기", "describe a table"],
    list_tables: ["테이블 목록 보기", "list tables"],
    list_databases: ["DB 목록 보기", "list databases"],
    connect_prod: ["운영 DB 연결", "connect to production"],
    disconnect_prod: ["운영 DB 연결 끊기", "disconnect from production"],
  },
  elasticsearch: {
    esql: ["ES|QL 조회", "ES|QL query"],
    search: ["검색", "search"],
    list_indices: ["인덱스 목록 보기", "list indices"],
    get_mappings: ["매핑 보기", "read mappings"],
    get_shards: ["샤드 보기", "read shards"],
  },
  chrome: {
    navigate: ["페이지 이동", "open a page"],
    computer: ["화면 조작", "click and type"],
    javascript_tool: ["자바스크립트 실행", "run JavaScript"],
    browser_batch: ["여러 동작 실행", "run several actions"],
    read_page: ["페이지 읽기", "read the page"],
    get_page_text: ["페이지 글 읽기", "read the page text"],
    find: ["요소 찾기", "find on the page"],
    form_input: ["입력하기", "fill a form"],
    file_upload: upload,
    upload_image: upload,
    tabs_context_mcp: ["탭 확인", "check the tabs"],
    tabs_create_mcp: ["탭 열기", "open a tab"],
    tabs_close_mcp: ["탭 닫기", "close a tab"],
    read_console_messages: ["콘솔 보기", "read the console"],
    read_network_requests: ["네트워크 보기", "read network requests"],
    switch_browser: pickBrowser,
    select_browser: pickBrowser,
    list_connected_browsers: pickBrowser,
    resize_window: ["창 크기 바꾸기", "resize the window"],
    gif_creator: ["GIF 만들기", "record a GIF"],
    shortcuts_execute: ["단축키 실행", "run a shortcut"],
    shortcuts_list: ["단축키 보기", "list shortcuts"],
  },
};

const SERVER_NAMES: Record<McpServerKind, Words> = {
  dooray: ["두레이", "Dooray"],
  mysql: ["MySQL", "MySQL"],
  elasticsearch: ["엘라스틱서치", "Elasticsearch"],
  chrome: ["크롬", "Chrome"],
};

/** `mcp__dooray__dooray_get_posts` → `get_posts` (the tool without its server's repeated prefix, underscores kept). */
function rawToolName(tool: string, server: string): string {
  let rest = tool.slice("mcp__".length + server.length + 2);
  if (rest.startsWith(server + "_") && rest.length > server.length + 1) rest = rest.slice(server.length + 1);
  const short = server.split("-")[0] ?? server;
  if (short !== server && rest.startsWith(short + "_") && rest.length > short.length + 1) rest = rest.slice(short.length + 1);
  return rest;
}

/**
 * What an agent runs, in words: "두레이 업무 읽기 · 4821" / "Dooray: read tasks · 4821" for the frequent MCP servers, else
 * the §39.3 title ("Bash · ./gradlew test", "context7 · query docs", "스킬 acme-tools:smoke").
 */
export function toolText(tool: string, detail?: string | null, language: string = currentLanguage()): string {
  const d = detail && detail.trim() ? detail : null;
  const l = toolLabel(tool);
  const kind = l.kind === "mcp" && l.server ? mcpServerKind(l.server) : null;
  if (!kind || !l.server) return toolTitle(tool, d);
  const ko = language.toLowerCase().startsWith("ko");
  const [serverKo, serverEn] = SERVER_NAMES[kind];
  const action = ACTIONS[kind][rawToolName(tool, l.server)];
  const head = action ? (ko ? `${serverKo} ${action[0]}` : `${serverEn}: ${action[1]}`) : `${ko ? serverKo : serverEn} · ${l.name}`;
  return d ? `${head} · ${d}` : head;
}

export type AgentMood = "working" | "waiting" | "retrying" | "done" | "failed" | "stopped" | "idle";

export function moodOf(a: Pick<AgentNode, "status" | "retry">, awaitingPermission: boolean): AgentMood {
  switch (a.status) {
    case "pending":
    case "running":
      if (awaitingPermission) return "waiting";
      return a.retry ? "retrying" : "working";
    case "paused":
      return awaitingPermission ? "waiting" : "idle";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    default:
      return "stopped";
  }
}

export function mainMood(running: boolean, awaitingPermission: boolean): AgentMood {
  if (awaitingPermission) return "waiting";
  return running ? "working" : "idle";
}

/** The face moves (Reduce Motion shows the still picture). */
export const moodMoves = (m: AgentMood): boolean => m === "working" || m === "waiting" || m === "retrying";

export function moodWords(m: AgentMood): string {
  switch (m) {
    case "working":
      return t("working now");
    case "waiting":
      return t("waiting for permission");
    case "retrying":
      return t("retrying");
    case "done":
      return t("finished");
    case "failed":
      return t("failed");
    case "stopped":
      return t("stopped");
    case "idle":
      return t("resting");
  }
}

export type BoardSummary = { working: number; waiting: number; retrying: number; today: number };

/** The Mac's `AgentBoardSummary.of`: who works, who waits, who retries, and how many distinct agents started today. */
export function boardSummary(
  agents: readonly AgentNode[],
  history: readonly AgentNode[],
  awaiting: (a: AgentNode) => boolean,
  mainWaiting = false,
  now: Date = new Date(),
): BoardSummary {
  const s: BoardSummary = { working: 0, waiting: 0, retrying: 0, today: 0 };
  for (const a of agents) {
    const m = moodOf(a, awaiting(a));
    if (m === "working") s.working++;
    else if (m === "waiting") s.waiting++;
    else if (m === "retrying") s.retrying++;
  }
  if (mainWaiting) s.waiting++;
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const seen = new Set<string>();
  for (const a of [...agents, ...history]) {
    if (a.startedAt >= dayStart && !seen.has(a.toolUseId)) {
      seen.add(a.toolUseId);
      s.today++;
    }
  }
  return s;
}

/** "지금 3명 일하는 중 · 1명 권한 대기 · 오늘 12명 다녀감" — most urgent first, one quiet part when nothing goes on. */
export function summaryParts(s: BoardSummary): string[] {
  const out: string[] = [];
  if (s.working > 0) out.push(t("{0} working now", s.working));
  if (s.waiting > 0) out.push(t("{0} waiting for permission", s.waiting));
  if (s.retrying > 0) out.push(t("{0} retrying", s.retrying));
  if (out.length === 0) out.push(s.today > 0 ? t("Everyone is resting") : t("All quiet — subagents gather here when Claude calls them"));
  if (s.today > 0) out.push(t("{0} visited today", s.today));
  return out;
}

export const BOARD_TABS = ["agents", "brain", "graph"] as const;
export type BoardTab = (typeof BOARD_TABS)[number];

const tabKey = (project: string) => `rg.board.tab.${project}`;

/** The tab the board was on for `project` (agents when unknown). */
export function readBoardTab(project: string | null | undefined): BoardTab {
  if (!project) return "agents";
  try {
    const v = localStorage.getItem(tabKey(project));
    return (BOARD_TABS as readonly string[]).includes(v ?? "") ? (v as BoardTab) : "agents";
  } catch {
    return "agents";
  }
}

export function writeBoardTab(project: string | null | undefined, tab: BoardTab): void {
  if (!project) return;
  try {
    localStorage.setItem(tabKey(project), tab);
  } catch {
    /* private mode etc. */
  }
}

// ------------------------------------------------------------ the agent panel's layout (§42.4, the Mac's AgentPanelLayout)

/** Agents side by side from this many on are compact rows (one line each, a click opens the card). */
export const COMPACT_FROM = 3;

/** Siblings (in start order) grouped into batches that ran at the same time (overlapping start…end); `now` closes live ones. */
export function parallelBatches(siblings: readonly AgentNode[], now: number): AgentNode[][] {
  const batches: AgentNode[][] = [];
  let batchEnd = -Infinity;
  for (const a of siblings) {
    const start = a.startedAt;
    const end = a.endedAt ?? (isLiveStatus(a.status) ? now : start + (a.durationMs ?? 0));
    const last = batches[batches.length - 1];
    if (last && start < batchEnd) {
      last.push(a);
      batchEnd = Math.max(batchEnd, end);
    } else {
      batches.push([a]);
      batchEnd = end;
    }
  }
  return batches;
}

const isLiveStatus = (s: AgentNode["status"]): boolean => s === "running" || s === "pending" || s === "paused";

/**
 * A compact row's second line: what a live agent does now (its step, else its tool), what a finished one left (its error,
 * else its report's or summary's first line); null when there is nothing.
 */
export function rowDetail(a: AgentNode, now: number): string | null {
  if (isLiveStatus(a.status)) {
    const step = stepOf(a);
    if (step) return stepLine(step, now);
    return a.lastTool ? toolTitle(a.lastTool, null) : null;
  }
  for (const text of [a.error, a.reportPreview, a.summary]) {
    const line = firstLine(text);
    if (line) return line;
  }
  return null;
}

function firstLine(text: string | undefined): string | null {
  if (!text) return null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[#*>\- ]+|[#*>\- ]+$/g, "");
    if (line) return [...line].slice(0, 200).join("");
  }
  return null;
}

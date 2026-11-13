/**
 * Message composer (the Mac app's `ChatView.composer`): textarea with Ctrl+Enter send, a plain Send that
 * never touches the review, the separate "Accept N & Send" dropdown (Ctrl/⌘+Shift+Enter, confirmed above
 * three files), Stop / Request changes, the pending-review banner, the capabilities caption + popover
 * and the `/` slash palette. The text box is always editable: while Claude works (or the gate is closed) the send
 * button becomes "Add to queue" with a "Stop & send" alternative (src/renderer/sendQueue.ts, `QueueBar`), and
 * ↑ / ↓ on the composer's first / last line walk this project's sent messages (src/renderer/promptHistory.ts; Esc restores the draft).
 * MARK: wave6 w6-terminal — §44.1 as in the terminal: Shift+Tab cycles the permission mode, the mode line under the box
 * says which one runs, Esc stops a running turn (after the palettes and the history had their Esc).
 * §23 `@` opens the file popover (mentions become chips, also dropped in from the review list); §24 images come from
 * paste, drag-drop and the attach button (thumbnail chips) — both go out with the message (and wait with it in the queue).
 * MARK: §49 "Run as Task" (next to attach): the draft and its @ mentions start in a new workbench instead (the sheet); once
 * the task started there, the draft empties if it still holds that text (images stay here).
 * MARK: §50 "바로 보내기": while a turn of ours runs and the draft has no images, the primary button (and ⌘↩) puts the
 * message into that turn (src/renderer/sendNow.ts); its menu queues it for after the turn or stops the turn and sends it.
 * MARK: r1-composer M08 — while Claude's question (AskUserQuestion) is open the box answers it (⌘↩, the primary "답하기";
 * src/renderer/openQuestion.ts): the text goes to the question it answers now, 1…N in an empty box pick an option, ⌥↩ sends
 * the text apart from the question. M14 — the `/` palette and ⌘/ work while Claude works too.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import type { FileItem } from "@reviewgate/engine";
import { imageFilesOf, mergeImages, pickedToDraft, readImageFile, type DraftImage } from "../../composerAttach";
import { formatBytes } from "../../../shared/attachments"; // r2-chats-cards M34
import { refusalCodeText, refusalMessage } from "../../errorCodes";
import { refusalOf } from "../../engineRequest";
import { addMentions, changedMentionPaths, droppedMentionPaths, MAX_MENTIONS, MENTION_DEBOUNCE_MS, MENTION_DRAG_TYPE, mentionOptions, mentionToken, removeToken, type MentionOption } from "../../mentions";
import { DraftChips } from "./ComposerChips";
import { CHANGED_SHORTCUT_LABEL, MentionPopover } from "./MentionPopover";
import { canAcceptAndSend } from "../../friction";
import { t } from "../../i18n";
import { draftOf, historyEscape, historyStep, IDLE_NAV, loadHistory, pushHistory, saveHistory, type HistoryNav } from "../../promptHistory";
import { newChatRefusal, projectRootHash } from "../../sessions";
import { loadDraft, saveDraft, windowStorage } from "../../sessionKeep";
import { backgroundWorkOn, isBackgroundKey, noteBackgroundKey } from "../../background"; // MARK: §52
import { showToast } from "../../toast";
import { useUnsavedWork } from "../../unsavedWork";
import { useComposerPresence } from "../../storeComposer";
import { collectFailedNotice } from "../../composerSend"; // MARK: r2-review-flow (M30)
import { CopyButton } from "../common/CopyButton";
import { sendKeyLabel } from "../../shortcutKeys";
import { cannotSendReason, capabilitiesOf, hasPendingReview, isRunning, useStore } from "../../store";
import { Menu } from "../Menu";
import { CapabilitiesPopover } from "./CapabilitiesPopover";
import { mcpAttention } from "../../mcp";
import { ComposerModeLine, ModeMenu } from "./ModeMenu";
import { isModeCycleKey } from "../../terminalMode"; // MARK: wave6 w6-terminal (§44.1)
import { NextMessageModelMenu } from "./AutoModelBits"; // MARK: wave5 w5-model (§43.4)
import { PendingBanner } from "./PendingBanner";
import { QueueBar } from "./QueueBar";
import { BtwOverlay } from "./BtwOverlay"; // §56.1
import { btwNothingYet, btwQuestion, useBtw } from "../../btw";
import { SlashPalette, slashPaletteShows, slashToken, useSlashPalette, type SlashEntry } from "./SlashPalette";
import { capabilitiesCaption } from "../../slashCommands"; // MARK: wave3 desktop-session — §36.5
// MARK: wave3 desktop-agents — §36.4 the "main is waiting" line, §36.1 a report handed over from the agent details sheet
import { WaitingLine } from "../agents/AgentBits";
// MARK: wave3 desktop-flow — §36.14 PR comments handed to the composer (desktop-agents' bridge, the same file)
import { joinDraft, useComposerInsert, useTaskLeftComposer } from "../../composerBridge";
import { composerTaskText, runAsTaskEnabled } from "../../runAsTask"; // MARK: §49
// MARK: wave4 w4-safety — polish-12 a draft per chat, robustness-07 "Force restart"
import { chatDraftKey, draftAfterKeyChange, isFirstIdentification, stashChips, takeChips } from "../../workSafety";
import { isComposing, isEnter } from "../../ime";
// MARK: wave4b w4b-tabs — §39.2 a send from another chat shown read-only switches there first
import { sendInViewedChat, useViewing, viewingSendBlocker, viewingSendWait } from "../../viewedChat";
import { ViewingChatBar } from "./ViewingChat";
import { canSteerDraft, composerEnter, plainEnterAction, primarySend, separateEnter, workingHint } from "../../sendNow"; // MARK: §50
import { shortcutTargetId } from "../../permissionQueue"; // r2-chats-cards M24
import { annotationsFor, clearQuestionNotes } from "../../questionNotes"; // r2-chats-cards M08b
// MARK: r1-composer M08 — Claude's open question answered from the box
import { currentQuestion, draftAnswers, emptyDraft, fillAnswer, isComplete, openQuestionOf, parseQuestions, pickOption, useQuestionDrafts } from "../../openQuestion";

export function Composer() {
  const state = useStore((s) => s.state);
  const cachedCapabilities = useStore((s) => s.cachedCapabilities);
  const send = useStore((s) => s.send);
  const interrupt = useStore((s) => s.interrupt);
  const moveToBackground = useStore((s) => s.moveToBackground); // MARK: §52
  const settings = useStore((s) => s.settings);
  const interruptStuck = useStore((s) => s.interruptStuck); // MARK: wave4 w4-safety
  const forceRestartStuckTurn = useStore((s) => s.forceRestartStuckTurn);
  const requestChanges = useStore((s) => s.requestChanges);
  const restartSession = useStore((s) => s.restartSession);
  const enqueueMessage = useStore((s) => s.enqueueMessage);
  const pullBackLastWaiting = useStore((s) => s.pullBackLastWaiting); // §50.3
  const interruptAndSend = useStore((s) => s.interruptAndSend);
  const steer = useStore((s) => s.steer); // MARK: §50
  const cyclePermissionMode = useStore((s) => s.cyclePermissionMode); // MARK: wave6 w6-terminal (§44.1)
  const root = useStore((s) => s.state.project?.root ?? null);
  // MARK: wave1 desktop-session — §30 "세션 종료됨" offers a new chat too; polish-03 keeps the draft across a reload.
  const newChat = useStore((s) => s.newChat);
  const switchRefusal = useStore((s) => newChatRefusal(s.state)); // r2-chats-cards M31 (§9): while Claude works it waits
  // MARK: §49 Run as Task
  const runAsTask = useStore((s) => runAsTaskEnabled(s.settings));
  const openDialog = useStore((s) => s.openDialog);
  const keep = useMemo(() => windowStorage(), []);

  const [draft, setDraft] = useState(() => loadDraft(keep, chatDraftKey(root ? projectRootHash(root) : null, useStore.getState().state.sessions?.currentId)));
  // §23 / §24: chips that go out with the text.
  const [mentions, setMentions] = useState<string[]>([]);
  const [mentionDirs, setMentionDirs] = useState<Record<string, true>>({});
  const [images, setImages] = useState<DraftImage[]>([]);
  const [nextModel, setNextModel] = useState<string | null>(null); // MARK: wave5 w5-model — §43.4 "이번엔 opus"
  /** The list async adds merge into (paste / drop / dialog may overlap). */
  const imagesRef = useRef<DraftImage[]>([]);
  const saidResized = useRef(new Set<number>()); // r2-chats-cards M34
  imagesRef.current = images;
  const [attachErrors, setAttachErrors] = useState<string[]>([]);
  const [dropping, setDropping] = useState(false);
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissedAt, setMentionDismissedAt] = useState<number | null>(null);
  const [fileItems, setFileItems] = useState<FileItem[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const listFiles = useStore((s) => s.listFiles);
  const changedFiles = useStore((s) => s.state.changedFiles);
  const [showCaps, setShowCaps] = useState(false);
  const [paletteForced, setPaletteForced] = useState(false);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  /** "Accept N & Send" asks first when it would accept more than three files. */
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // polish P4-composer-16: the box grows with what is typed (up to 40% of the window) from the height the user last dragged
  // it to (kept across launches); a long prompt is no longer typed in a 60 px slot.
  const minHeight = useRef(readComposerHeight());
  const lastSet = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = Math.max(minHeight.current, Math.round(window.innerHeight * 0.4));
    const h = Math.min(max, Math.max(minHeight.current, el.scrollHeight + 2));
    el.style.height = `${h}px`;
    el.style.maxHeight = `${max}px`;
    lastSet.current = h;
  }, [draft]);
  const rememberDrag = () => {
    const el = inputRef.current;
    if (!el || lastSet.current === null) return;
    const h = Math.round(el.getBoundingClientRect().height);
    if (Math.abs(h - lastSet.current) < 2) return; // not a drag: the height this effect set
    minHeight.current = Math.max(COMPOSER_MIN_HEIGHT, h);
    lastSet.current = h;
    writeComposerHeight(minHeight.current);
  };
  const [splitOpen, setSplitOpen] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);

  // ↑ / ↓ prompt history, per project (localStorage).
  const projectHash = root ? projectRootHash(root) : null;
  const [history, setHistory] = useState<string[]>(() => loadHistory(projectHash));
  const [nav, setNav] = useState<HistoryNav>(IDLE_NAV);
  const navRef = useRef(nav); // MARK: wave6 w6-terminal (§44.1): the parked draft, read when the chat changes
  navRef.current = nav;
  useEffect(() => {
    setHistory(loadHistory(projectHash));
    setNav(IDLE_NAV);
  }, [projectHash]);
  // polish-03: the draft is kept per project (localStorage since p-lifecycle P4-composer-07: a reload, closing the window or
  // quitting brings it back).
  // MARK: wave4 w4-safety — polish-12: and per chat (`state.sessions.currentId`): a chat tab shows its own draft and chips.
  // wave4b w4b-tabs (§39.2): a chat shown read-only has its own draft too.
  const viewing = useViewing();
  const chatId = useStore((s) => viewing?.id ?? s.state.sessions?.currentId ?? null);
  const draftKey = chatDraftKey(projectHash, chatId);
  // polish P4-composer-07: what closing the window (or quitting) would lose here — the images (never saved) and the draft
  // (kept for this window only).
  useUnsavedWork("composerImages", () => (images.length > 0 ? t("{0} attached images will be lost.", images.length) : null));
  useUnsavedWork("composerDraft", () => (draft.trim().length > 0 ? t("The message you are typing will be lost.") : null));
  // polish P4-composer-08: the chat tabs show which chat holds an unsent draft or images (ChatTabs reads it).
  useEffect(() => {
    if (chatId && !viewing) useComposerPresence.getState().report(chatId, { images: images.length, draft: draft.trim().length > 0 });
  }, [chatId, viewing, images.length, draft]);
  const draftHash = useRef(draftKey);
  draftHash.current = draftKey;
  const shownKey = useRef(draftKey);
  const chipsRef = useRef({ mentions, mentionDirs, images });
  chipsRef.current = { mentions, mentionDirs, images };
  useEffect(() => {
    const previous = shownKey.current;
    shownKey.current = draftKey;
    const kept = loadDraft(keep, draftKey);
    if (previous === draftKey) {
      if (kept) setDraft((d) => (d.length === 0 ? kept : d));
      return;
    }
    // MARK: wave6 w6-terminal — §44.1: a recalled prompt on screen is not the draft; the one typed before ↑ goes on.
    const parked = navRef.current.index !== null ? navRef.current.saved : null;
    if (parked !== null) setNav(IDLE_NAV);
    setDraft((d) => draftAfterKeyChange(previous, draftKey, parked ?? d, kept));
    if (previous === null || isFirstIdentification(previous, draftKey)) return;
    stashChips(previous, chipsRef.current);
    const chips = takeChips<typeof chipsRef.current>(draftKey);
    setMentions(chips?.mentions ?? []);
    setMentionDirs(chips?.mentionDirs ?? {});
    setImages(chips?.images ?? []);
  }, [draftKey, keep]);
  // MARK: wave6 w6-terminal — §44.1: while a recalled prompt is shown, the draft typed before ↑ is what is kept.
  useEffect(() => saveDraft(keep, draftHash.current, draftOf(nav, draft)), [draft, nav, keep]);
  const remember = (text: string) => {
    palette.recordText(text); // wave3 desktop-session — §36.5: a sent /command leads the palette next time
    const next = pushHistory(history, text);
    if (next !== history) {
      setHistory(next);
      saveHistory(projectHash, next);
    }
    setNav(IDLE_NAV);
  };
  /** Puts `text` in the box with the caret at its end (or start: wave6 w6-terminal — after ↑, so the next ↑ walks on). */
  const showDraft = (text: string, at: "start" | "end" = "end") => {
    setDraft(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) el.selectionStart = el.selectionEnd = at === "start" ? 0 : el.value.length;
    });
  };
  // MARK: wave3 desktop-agents — §36.1 "메인으로 보내기": the report lands after the draft, focused, for the user's own words.
  useComposerInsert((text, chips) => {
    // wave6 w6-terminal (§44.1): while a recalled prompt is shown, the report joins the draft typed before ↑.
    const parked = navRef.current.index !== null ? navRef.current.saved : null;
    setNav(IDLE_NAV);
    setDraft((d) => joinDraft(parked ?? d, text));
    // r2-chats-cards M31 / M33 (§9): a held message that will not go out comes back with its mentions and images.
    if (chips) {
      setMentions((m) => addMentions(m, chips.mentions).list);
      setMentionDirs((d) => ({ ...d, ...chips.mentionDirs }));
      const merged = mergeImages(imagesRef.current, chips.images.map((image) => ({ ok: true as const, image })));
      imagesRef.current = merged.list;
      setImages(merged.list);
      if (merged.errors.length > 0) setAttachErrors(merged.errors);
    }
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = el.value.length;
      el.scrollTop = el.scrollHeight;
    });
  });
  // MARK: §49 — the task taken from here started in its workbench: its text leaves this composer (unless edited since).
  useTaskLeftComposer((started) => {
    if (composerTaskText(draft, mentions) !== started) return;
    setNav(IDLE_NAV);
    setDraft("");
    setMentions([]);
    setMentionDirs({});
  });
  // polish P4-composer-12: the send menu from the keyboard — the first item takes the focus, ↑ / ↓ move, Enter / Space choose,
  // Esc closes it and gives the focus back to its button.
  const splitMenuRef = useRef<HTMLDivElement>(null);
  const splitChevRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (splitOpen) splitMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [splitOpen]);
  const onSplitMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'));
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length === 0) return;
      const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
      items[next]?.focus();
    } else if (isEnter(e) || e.key === " ") {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.click();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setSplitOpen(false);
      splitChevRef.current?.focus();
    }
  };
  useEffect(() => {
    if (!splitOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (splitRef.current && !splitRef.current.contains(e.target as Node)) setSplitOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [splitOpen]);

  const { caps, cached } = capabilitiesOf({ state, cachedCapabilities });
  // §22: the live MCP list when the engine sent one, else what the session reported at start.
  const mcpLive = useStore((s) => (s.mcp.loaded ? s.mcp.servers : null));
  const mcpList = mcpLive ?? caps?.mcpServers ?? [];
  const mcpWarn = mcpAttention(mcpList);
  const running = isRunning(state);
  // MARK: wave4b w4b-tabs — §39.2: from another chat shown read-only, Send moves the session there (when it can); the
  // running chat's review actions and queue wait until it is shown again.
  const queuedCount = useStore((s) => s.queue.items.length);
  const viewBlock = viewing ? viewingSendBlocker(state, queuedCount > 0) : null;
  // r2-chats-cards M33 (§9): Claude works in the live chat — a send from the viewed chat waits for it, it is not refused.
  const viewWait = viewing ? viewingSendWait(state, queuedCount > 0) : null;
  const acceptAndSend = !viewing && canAcceptAndSend(state);
  const canSend = viewing ? viewBlock === null : state.gate.canSend;
  const canRequest = state.gate.canRequestChanges;
  const pending = state.gate.pendingCount;
  const noteCount = state.reviewNotes.filter((n) => !n.sent).length; // wave2 desktop-flow — §34.4: sent notes are never sent again
  // r2-chats-cards M33: the line says why it waits and that the send key still sends (the Mac's words).
  const viewWaitKeyHint = settings?.returnSends !== false
    ? t("↩ sends it here once Claude is done in the running chat")
    : t("⌘↩ sends it here once Claude is done in the running chat");
  const reason = viewing ? (viewBlock ?? (viewWait !== null ? `${viewWait} — ${viewWaitKeyHint}` : null)) : cannotSendReason(state);
  /** The gate is closed but a project is open: the message waits in the queue instead. */
  const queueMode = !viewing && !canSend && state.project !== null;
  /** r2-review-flow M30: the session ended — a message queues and the session restarts (the queue sends it once it is up). */
  const sessionEnded = state.project !== null && !state.session.open && !state.session.starting;
  const hasText = draft.trim().length > 0;
  /** §50: the draft can go into the running turn (a draft with images waits in the queue). */
  const canSteer = canSteerDraft(state, { queueMode, viewing: viewing !== null, images: images.length });
  // MARK: r1-composer M08 — Claude's open question: ⌘↩ answers it instead of putting the text into the turn (where it would
  // wait behind the question), ⌥↩ sends the text apart from it, 1…N in an empty box pick an option.
  const question = useStore((s) => openQuestionOf(s.state, viewing !== null));
  const questions = useMemo(() => (question ? parseQuestions(question.input) : []), [question]);
  const questionDraft = useQuestionDrafts((s) => (question ? s.drafts[question.requestId] : undefined));
  const setQuestionDraft = useQuestionDrafts((s) => s.setDraft);
  const clearQuestionDraft = useQuestionDrafts((s) => s.clearDraft);
  const answerQuestions = useStore((s) => s.answerQuestions);
  const shownQuestionDraft = questionDraft ?? emptyDraft(questions);
  const questionReady = question !== null && isComplete(questions, shownQuestionDraft);
  const questionCurrent = question ? currentQuestion(questions, shownQuestionDraft) : null;
  const questionOptions = questionCurrent !== null ? (questions[questionCurrent]?.options.length ?? 0) : 0;
  // MARK: r2-chats-cards M24 (§33.10) — a permission card waits and text is typed: the send key denies the card with this
  // text as the instruction (Claude follows it in the same turn) instead of the text waiting behind the card.
  const cardForText = !viewing && question === null && hasText ? shortcutTargetId(state) : null;
  const primary = primarySend({ canSend, queueMode, canSteer, question: question !== null, card: cardForText !== null });
  // polish P4-composer-13: the hint names the key in use (↩ while "Return sends the message" is on).
  const sendKey = sendKeyLabel(settings?.returnSends);
  const hint = workingHint(reason, canSteer, state.gate.blockedReason === "awaiting_permission" && !hasText, question !== null, settings?.returnSends !== false, cardForText !== null);

  const token = slashToken(draft);
  // MARK: composer parity — §56.1 /btw: the answer over the box, a question that got none, and the chat it belongs to.
  const btwOverlay = useBtw((s) => s.overlay);
  const btwFailure = useBtw((s) => s.failure);
  const askBtw = useBtw((s) => s.ask);
  const showLastBtw = useBtw((s) => s.showLast);
  const dismissBtw = useBtw((s) => s.dismiss);
  const liveChatId = useStore((s) => s.state.sessions?.currentId ?? s.state.session.sessionId ?? null);
  useEffect(() => {
    if (!btwFailure) return;
    setAttachErrors([btwFailure.text]);
    setDraft((d) => (d.length === 0 ? `/btw ${btwFailure.question}` : d));
  }, [btwFailure]);
  useEffect(() => dismissBtw(), [liveChatId, dismissBtw]);
  // MARK: r1-composer M14 — the palette works while Claude works or the session starts too (a pick goes into the draft).
  const paletteVisible = slashPaletteShows({ projectOpen: state.project !== null, dismissed: paletteDismissed, forced: paletteForced, token });

  // §23: the `@query` at the caret (not while the slash palette is open).
  const mention = paletteVisible || state.project === null ? null : mentionToken(draft, caret);
  const mentionVisible = mention !== null && mentionDismissedAt !== mention.start;
  const mentionQuery = mention?.query ?? null;
  const changedPaths = useMemo(() => changedMentionPaths(changedFiles), [changedFiles]);
  const options = useMemo(
    () => (mentionVisible ? mentionOptions(mentionQuery ?? "", fileItems, changedPaths, CHANGED_SHORTCUT_LABEL()) : []),
    [mentionVisible, mentionQuery, fileItems, changedPaths],
  );
  useEffect(() => {
    if (!mentionVisible || mentionQuery === null) return;
    let live = true;
    setFilesLoading(true);
    const id = setTimeout(() => {
      listFiles(mentionQuery)
        .then((items) => {
          if (!live) return;
          setFileItems(items);
          setFilesError(null);
        })
        .catch((e: unknown) => {
          if (!live) return;
          setFileItems([]);
          setFilesError(refusalMessage(refusalOf(e)));
        })
        .finally(() => live && setFilesLoading(false));
    }, MENTION_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [mentionVisible, mentionQuery, listFiles]);
  useEffect(() => setMentionIndex(0), [mentionQuery]);

  /** Adds mention chips (the cap says so when some did not fit). */
  const addMentionPaths = (paths: string[], dirs: string[] = []) => {
    const r = addMentions(mentions, paths);
    setMentions(r.list);
    if (dirs.length > 0) setMentionDirs((d) => ({ ...d, ...Object.fromEntries(dirs.map((p) => [p.replace(/\/+$/, ""), true as const])) }));
    setAttachErrors(r.overflow > 0 ? [refusalCodeText("too_many_mentions", String(MAX_MENTIONS)) ?? "too_many_mentions"] : []);
  };
  const removeMention = (path: string) => setMentions((m) => m.filter((x) => x !== path));

  /** Picking an option: the `@query` leaves the text, the path(s) become chips. */
  const pickMention = (o: MentionOption) => {
    if (!mention) return;
    const el = inputRef.current;
    const at = el?.selectionStart ?? caret;
    const r = removeToken(draft, mention.start, Math.max(at, mention.start + 1 + mention.query.length));
    setDraft(r.text);
    setCaret(r.caret);
    if (o.kind === "changed") addMentionPaths(o.paths);
    else addMentionPaths([o.item.path], o.item.kind === "dir" ? [o.item.path] : []);
    requestAnimationFrame(() => {
      const box = inputRef.current;
      if (!box) return;
      box.focus();
      box.selectionStart = box.selectionEnd = r.caret;
    });
  };

  /** Images from paste / drop / the attach button. */
  const addImages = async (files: File[]) => {
    if (files.length === 0) return;
    const read = await Promise.all(files.map((f) => readImageFile(f)));
    const m = mergeImages(imagesRef.current, read);
    imagesRef.current = m.list;
    setImages(m.list);
    setAttachErrors(m.errors);
    sayResized(m.list);
  };
  /** r2-chats-cards M34 (§24): a big screenshot is attached scaled down — said once, not refused. */
  const sayResized = (list: DraftImage[]) => {
    const resized = list.find((i) => i.resizedFrom !== undefined && !saidResized.current.has(i.id));
    if (!resized) return;
    saidResized.current.add(resized.id);
    showToast(t("Scaled down to fit: {0} → {1}", formatBytes(resized.resizedFrom!), formatBytes(resized.bytes)));
  };
  const pickImages = async () => {
    const picked = await window.rg.pickImages();
    if (picked.length === 0) return;
    const m = mergeImages(imagesRef.current, picked.map(pickedToDraft));
    imagesRef.current = m.list;
    setImages(m.list);
    setAttachErrors(m.errors);
    sayResized(m.list);
    inputRef.current?.focus();
  };
  const removeImage = (id: number) => {
    imagesRef.current = imagesRef.current.filter((i) => i.id !== id);
    setImages(imagesRef.current);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFilesOf(e.clipboardData).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    void addImages(files);
  };
  const acceptsDrop = (e: DragEvent) => e.dataTransfer.types.includes(MENTION_DRAG_TYPE) || e.dataTransfer.types.includes("Files");
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!state.project || !acceptsDrop(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dropping) setDropping(true);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDropping(false);
    if (!state.project || !acceptsDrop(e)) return;
    e.preventDefault();
    const paths = droppedMentionPaths(e.dataTransfer);
    if (paths.length > 0) {
      addMentionPaths(paths);
      inputRef.current?.focus();
      return;
    }
    void addImages(Array.from(e.dataTransfer.files ?? []));
    inputRef.current?.focus();
  };

  /** What goes out with the text; the chips are cleared once it is sent / queued. */
  const extras = () => ({ mentions, attachments: images.map((i) => i.attachment), ...(nextModel ? { model: nextModel } : {}) });
  const clearChips = () => {
    setNextModel(null); // MARK: wave5 w5-model — the one-message model goes with the message it was picked for
    setMentions([]);
    setMentionDirs({});
    setImages([]);
    setAttachErrors([]);
  };
  // MARK: wave3 desktop-session — §36.5: sections (recently used first), descriptions, "Starting session…".
  const palette = useSlashPalette(caps, token, projectHash);
  const entries = palette.entries;

  const closePalette = () => {
    setPaletteForced(false);
    setPaletteDismissed(true);
  };
  const openPalette = () => {
    if (state.project === null) return; // r1-composer M14: not only while a message could be sent
    setPaletteForced(true);
    setPaletteDismissed(false);
    setPaletteIndex(0);
    inputRef.current?.focus();
  };
  const closeCaps = useCallback(() => setShowCaps(false), []);

  /** Replaces the typed `/token` (or prepends when the draft has none) with `/name `. */
  const pick = (entry: SlashEntry) => {
    palette.record(entry.name);
    const inserted = `/${entry.name} `;
    if (draft.startsWith("/")) {
      const rest = draft.slice(1);
      const m = /\s/.exec(rest);
      const tail = m ? rest.slice(m.index).replace(/^\s+/, "") : "";
      setDraft(inserted + tail);
    } else {
      setDraft(inserted + draft);
    }
    closePalette();
    inputRef.current?.focus();
  };

  /**
   * §56.1: `/btw <question>` is the app's command, whatever the turn does: asked on the side (the answer opens over the
   * box), never sent, queued or put into the turn; `/btw` alone shows this chat's last answer again. False for any other text.
   */
  const takeBtw = (): boolean => {
    const q = btwQuestion(draft);
    if (q === null) return false;
    setSplitOpen(false);
    if (state.project === null) {
      setAttachErrors([t("Open a project first (⌘O)")]);
      return true;
    }
    setDraft("");
    closePalette();
    setNav(IDLE_NAV);
    if (q === "") {
      if (!showLastBtw(liveChatId)) setAttachErrors([btwNothingYet()]);
    } else {
      void askBtw(q, liveChatId);
    }
    inputRef.current?.focus();
    return true;
  };

  /** Plain Send: the message goes out and every file keeps the state it had. */
  const doSend = () => {
    if (takeBtw()) return; // §56.1
    if (!canSend || draft.trim().length === 0) return;
    if (viewing) {
      // wave4b w4b-tabs (§39.2): move the session to this chat first; a refused switch gives the text back.
      const text = draft;
      const kept = extras();
      const keptChips = { mentions, mentionDirs, images }; // given back with the text, as on the Mac
      setDraft("");
      closePalette();
      remember(text);
      clearChips();
      void sendInViewedChat(text, kept, undefined, keptChips).then((ok) => {
        if (ok) return;
        setDraft((d) => (d.length === 0 ? text : d));
        setMentions((m) => (m.length === 0 ? keptChips.mentions : m));
        setMentionDirs((d) => (Object.keys(d).length === 0 ? keptChips.mentionDirs : d));
        setImages((i) => (i.length === 0 ? keptChips.images : i));
      });
      inputRef.current?.focus();
      return;
    }
    setDraft("");
    closePalette();
    remember(draft);
    send(draft, extras());
    clearChips();
    inputRef.current?.focus();
  };

  /** "Add to queue": sent in order once a plain Send is allowed again. */
  const doQueue = () => {
    if (takeBtw()) return; // §56.1
    if (!queueMode || !hasText) return;
    setDraft("");
    closePalette();
    remember(draft);
    enqueueMessage(draft, false, extras());
    clearChips();
    inputRef.current?.focus();
  };

  /**
   * §50 "바로 보내기": the draft goes into the running turn (refused by the engine, it waits in the queue — store `steer`).
   * The one-message model stays for the next message of its own (a turn's model does not change midway).
   */
  const doSteer = () => {
    setSplitOpen(false);
    if (takeBtw()) return; // §56.1
    if (!canSteer || !hasText) return;
    const text = draft;
    const sentMentions = mentions;
    setDraft("");
    closePalette();
    remember(text);
    void steer(text, { mentions: sentMentions });
    setMentions([]);
    setMentionDirs({});
    setAttachErrors([]);
    inputRef.current?.focus();
  };

  /**
   * r1-composer M08: the box answers Claude's open question — the text answers the question it answers now (the card goes
   * out once every question has an answer), or with an empty box the card goes as it is. Never steered: it would only wait
   * behind the question. Chips stay for the next message.
   */
  const doAnswer = () => {
    setSplitOpen(false);
    if (takeBtw()) return; // §56.1
    if (!question) return;
    if (!hasText) {
      if (!questionReady) return;
      answerQuestions(question.requestId, draftAnswers(questions, shownQuestionDraft), annotationsFor(question.requestId, questions, shownQuestionDraft));
      clearQuestionDraft(question.requestId);
      clearQuestionNotes(question.requestId);
      return;
    }
    const filled = fillAnswer(questions, shownQuestionDraft, draft);
    if (!filled) return;
    setDraft("");
    closePalette();
    setNav(IDLE_NAV);
    if (isComplete(questions, filled.draft)) {
      answerQuestions(question.requestId, draftAnswers(questions, filled.draft), annotationsFor(question.requestId, questions, filled.draft));
      clearQuestionDraft(question.requestId);
      clearQuestionNotes(question.requestId);
    } else {
      setQuestionDraft(question.requestId, filled.draft);
    }
    inputRef.current?.focus();
  };

  /** r2-chats-cards M24 (§33.10): the waiting card is denied with the typed text as its instruction; the text leaves the box. */
  const doDenyWithText = () => {
    setSplitOpen(false);
    if (takeBtw()) return; // §56.1
    const text = draft.trim();
    if (!cardForText || text.length === 0) return;
    useStore.getState().respondPermission(cardForText, false, text);
    setDraft("");
    closePalette();
    setNav(IDLE_NAV);
    inputRef.current?.focus();
  };

  /** r1-composer M08: "질문과 별개로 보내기" (⌥↩) — into the turn, read once the question is answered; else the queue. */
  const doSeparately = () => {
    setSplitOpen(false);
    if (separateEnter({ question: question !== null, hasText, queueMode, canSteer }) === "steer") doSteer();
    else doQueue();
  };

  /** "Stop & send": interrupt the turn, then send this message first. */
  const doStopAndSend = () => {
    setSplitOpen(false);
    if (takeBtw()) return; // §56.1
    if (!running || !hasText) return;
    setDraft("");
    closePalette();
    remember(draft);
    interruptAndSend(draft, extras());
    clearChips();
    inputRef.current?.focus();
  };

  /** "Accept N & Send" (⌘⇧↩): only ever reached by choosing it explicitly. r2-review-flow M28: at once, never behind a dialog. */
  const doAcceptAndSend = () => {
    if (!acceptAndSend || draft.trim().length === 0) return;
    sendAccepting();
  };

  const sendAccepting = () => {
    if (takeBtw()) return; // §56.1
    if (!acceptAndSend || draft.trim().length === 0) return;
    const count = pending;
    setDraft("");
    closePalette();
    remember(draft);
    send(draft, { acceptPending: true, ...extras() });
    clearChips();
    showToast(t("Accepted {0} files and sent your message", count));
    inputRef.current?.focus();
  };

  /** Sends the review notes (plus the composer text, if any) as the next turn; bypasses `canSend` by design. */
  const doRequestChanges = () => {
    if (!canRequest) return;
    const extra = draft.trim();
    setDraft("");
    closePalette();
    requestChanges(extra.length > 0 ? extra : null);
    inputRef.current?.focus();
  };

  // ⌘⇧C (Ctrl on other platforms): Request changes when notes exist, otherwise focus the composer.
  const requestOrFocus = useRef(() => {});
  requestOrFocus.current = () => {
    if (!viewing && noteCount > 0 && canRequest) doRequestChanges(); // wave4b w4b-tabs: not from another chat
    else inputRef.current?.focus();
  };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== "c") return;
      if (useStore.getState().dialog) return;
      e.preventDefault();
      requestOrFocus.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(e)) return; // wave4 w4-input (polish-11): the IME's own Enter / Tab / arrows
    // §56.1: Enter or Space in an empty box closes the /btw answer over it (Esc closes it below, after the palette).
    if (btwOverlay?.kind === "answered" && draft === "" && (isEnter(e) || e.key === " ") && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      dismissBtw();
      return;
    }
    // MARK: wave6 w6-terminal — §44.1: Shift+Tab cycles the mode like the terminal (default → accept edits → plan → auto);
    // only here — everywhere else Shift+Tab still moves the focus back.
    if (isModeCycleKey(e)) {
      e.preventDefault();
      cyclePermissionMode();
      return;
    }
    // MARK: §52 — Ctrl+B in an empty box while a turn runs: the running command goes on in the background (otherwise
    // Ctrl+B does what it did — toggles the sidebar).
    if (isBackgroundKey(e, { draftEmpty: draft.trim().length === 0, turnRunning: running, enabled: backgroundWorkOn(settings), viewing: viewing !== null })) {
      e.preventDefault();
      noteBackgroundKey();
      void moveToBackground().then((why) => why && showToast(why));
      return;
    }
    if (mentionVisible && mention && !e.metaKey && !e.ctrlKey && !e.altKey) {
      switch (e.key) {
        case "ArrowDown":
          if (options.length === 0) break;
          e.preventDefault();
          setMentionIndex((i) => (i + 1) % options.length);
          return;
        case "ArrowUp":
          if (options.length === 0) break;
          e.preventDefault();
          setMentionIndex((i) => (i - 1 + options.length) % options.length);
          return;
        case "Enter":
        case "Tab":
          if (options.length === 0) break;
          e.preventDefault();
          pickMention(options[Math.min(mentionIndex, options.length - 1)]!);
          return;
        case "Escape":
          e.preventDefault();
          setMentionDismissedAt(mention.start);
          return;
      }
    }
    // MARK: r1-composer M08 — ⌥↩ while Claude's question is open: the text goes to Claude apart from it (else a new line).
    if (isEnter(e) && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && separateEnter({ question: question !== null, hasText, queueMode, canSteer })) {
      e.preventDefault();
      doSeparately();
      return;
    }
    // 1…9 in an empty box: that option of the question the box answers (nothing is sent; ⌘↩ sends the card).
    if (question && draft.length === 0 && !e.metaKey && !e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      const next = pickOption(questions, shownQuestionDraft, Number(e.key));
      if (next) {
        e.preventDefault();
        setQuestionDraft(question.requestId, next);
        return;
      }
    }
    // polish P4-composer-13: Enter sends as on the Mac (Settings › "Return sends the message", on unless turned off); Shift+Enter
    // is a new line. Never while a palette takes the key, never mid-composition (isEnter); an empty box swallows it.
    const enter = isEnter(e) ? plainEnterAction(e, { returnSends: settings?.returnSends, paletteVisible, hasText, question: question !== null }) : null;
    if (enter === "swallow") {
      e.preventDefault();
      return;
    }
    if (isEnter(e) && ((e.ctrlKey || e.metaKey) || enter === "send")) {
      e.preventDefault();
      // wave4b w4b-tabs (§39.2): from another chat shown read-only only a plain ⌘↩ sends (there); nothing stops or queues
      // in the running chat from here.
      // §50: while Claude works ⌘↩ puts the draft into the turn when it can take it, else into the queue.
      switch (composerEnter(e, { viewing: viewing !== null, canSend, canSteer, question: question !== null, card: cardForText !== null })) {
        case "answer":
          doAnswer();
          break;
        case "deny":
          doDenyWithText();
          break;
        case "acceptAndSend":
          doAcceptAndSend();
          break;
        case "send":
          doSend();
          break;
        case "stopAndSend":
          doStopAndSend();
          break;
        case "steer":
          doSteer();
          break;
        case "queue":
          doQueue();
          // MARK: r2-review-flow — M30: an ended session restarts; the queue sends the message once it is up.
          if (sessionEnded && state.session.canRestart) void restartSession();
          break;
      }
      return;
    }
    if (e.key === "/" && (e.ctrlKey || e.metaKey) && !e.altKey) {
      e.preventDefault();
      openPalette();
      return;
    }
    if (!paletteVisible) {
      const el = e.currentTarget;
      const caret = el.selectionStart === el.selectionEnd ? el.selectionStart : null;
      // §50.3: as in the terminal, ↑ in an empty box first brings back the last message waiting (queued, else in Claude's
      // turn) to edit; with nothing waiting it walks the prompt history.
      if (e.key === "ArrowUp" && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && draft === "" && nav.index === null && !viewing && pullBackLastWaiting()) {
        e.preventDefault();
        return;
      }
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        const step = historyStep(history, nav, draft, caret, e.key === "ArrowUp" ? -1 : 1);
        if (!step) return;
        e.preventDefault();
        setNav(step.nav);
        showDraft(step.draft, step.caret);
        return;
      }
      if (e.key === "Escape") {
        // wave6 w6-terminal (§44.1): a recalled prompt on screen → Esc brings the typed draft back first; the next Esc stops.
        const step = historyEscape(nav);
        if (step) {
          e.preventDefault();
          setNav(step.nav);
          showDraft(step.draft, step.caret);
        } else if (btwOverlay !== null) {
          e.preventDefault(); // §56.1: the side answer first, then the turn
          dismissBtw();
        } else if (running && !viewing) {
          // MARK: wave6 w6-terminal — §44.1: Esc stops Claude's running turn, as in the terminal (Ctrl+. does too).
          e.preventDefault();
          interrupt();
        }
      }
      return;
    }
    switch (e.key) {
      case "Enter":
      case "Tab":
        e.preventDefault();
        if (isEnter(e) && token?.toLowerCase() === "btw" && takeBtw()) break; // §56.1: `/btw` typed out runs at once
        if (entries.length === 0) closePalette();
        else pick(entries[Math.min(paletteIndex, entries.length - 1)]!);
        break;
      case "ArrowUp":
        if (entries.length === 0) return;
        e.preventDefault();
        setPaletteIndex((i) => (i - 1 + entries.length) % entries.length);
        break;
      case "ArrowDown":
        if (entries.length === 0) return;
        e.preventDefault();
        setPaletteIndex((i) => (i + 1) % entries.length);
        break;
      case "Escape":
        e.preventDefault();
        closePalette();
        break;
    }
  };

  const separateItem = (
    <div role="menuitem" tabIndex={-1} aria-disabled={!hasText} className={`item ${!hasText ? "disabled" : ""}`} onClick={() => (hasText ? doSeparately() : undefined)} data-testid="Send apart from the question">
      <span className="col" style={{ gap: 1 }}>
        <span>{t("Send apart from the question")}</span>
        <span className="tiny faint">{t("Claude reads it once the question is answered (⌥↩)")}</span>
      </span>
    </div>
  );

  const queueItem = (
    <div role="menuitem" tabIndex={-1} aria-disabled={!hasText} className={`item ${!hasText ? "disabled" : ""}`} onClick={() => (hasText ? (setSplitOpen(false), doQueue()) : undefined)} data-testid="Queue item">
      <span className="col" style={{ gap: 1 }}>
        <span>{t("Add to queue")}</span>
        <span className="tiny faint">{t("Sent in order when sending is possible")}</span>
      </span>
    </div>
  );

  return (
    <div
      className={`composer ${dropping ? "dropping" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={onDrop}
      data-testid="Composer"
    >
      {paletteVisible && <SlashPalette sections={palette.sections} selection={Math.min(paletteIndex, Math.max(entries.length - 1, 0))} emptyState={palette.emptyState} cached={cached} starting={palette.starting} onPick={pick} onHover={setPaletteIndex} />}
      {mentionVisible && (
        <MentionPopover
          options={options}
          selection={Math.min(mentionIndex, Math.max(options.length - 1, 0))}
          loading={filesLoading}
          error={filesError}
          query={mentionQuery ?? ""}
          onPick={pickMention}
          onHover={setMentionIndex}
        />
      )}
      <ViewingChatBar /* MARK: wave4b w4b-tabs — §39.2 "이 채팅을 보는 중이에요 — 보내면 이 채팅으로 이어가요" */ />
      <PendingBanner />
      {/* MARK: r2-review-flow — M30 (§3): the input stays open after a failed collection; Retry is right here too */}
      {!viewing && <CollectFailedLine />}
      <WaitingLine />
      <QueueBar />
      <DraftChips mentions={mentions} images={images} dirs={mentionDirs} onRemoveMention={removeMention} onRemoveImage={removeImage} />
      {attachErrors.length > 0 && (
        <div className="attach-errors" role="alert" data-testid="Attach errors">
          <span className="grow">{attachErrors.map((m, i) => <div key={i}>{m}</div>)}</span>
          <button type="button" className="plain tiny" onClick={() => setAttachErrors([])} aria-label={t("Dismiss")} title={t("Dismiss")}>×</button>
        </div>
      )}
      {dropping && <div className="drop-hint" aria-hidden="true">{t("Drop files to mention them, or images to attach")}</div>}
      <BtwOverlay /* §56.1: the /btw answer, over the box */ />
      <textarea
        ref={inputRef}
        className="composer-input"
        aria-label={t("Message")}
        value={draft}
        placeholder={
          question
            ? questionOptions > 0
              ? t("Answer Claude's question — or press 1–{0} to pick an option", questionOptions)
              : t("Answer Claude's question")
            : running
            ? canSteer
              ? settings?.returnSends !== false
                ? t("Claude is working — type a message; ↩ sends it to Claude now, into this turn.")
                : t("Claude is working — type a message; ⌘↩ sends it to Claude now, into this turn.")
              : t("Claude is working — type the next message; it is queued and sent when the turn ends.")
            : state.session.externalTurn && reason
              ? reason
              : queueMode && reason
              ? t("{0} — you can type now; the message is queued.", reason)
              : (reason ?? t("Ask Claude to make a change."))
        }
        onChange={(e) => {
          // wave6 w6-terminal (§44.1): typing into a recalled prompt keeps browsing (the edit is kept at the next ↑ / ↓) —
          // the draft typed before ↑ is never dropped here.
          setDraft(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setPaletteDismissed(false);
          setPaletteIndex(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        onMouseUp={rememberDrag}
        data-testid="Composer input"
      />
      <ComposerModeLine /* MARK: wave6 w6-terminal — §44.1 "⏵⏵ 자동 모드 (shift+tab 전환)" */ />
      <div className="footer">
        <span className={`hint caption truncate ${hint ? "muted" : "faint"}`} title={hint ?? undefined} data-testid="Composer hint">{hint ?? (settings?.returnSends !== false ? t("↩ to send · ⇧↩ new line · ⌘/ commands") : t("⌘↩ to send · ⌘/ commands · ⌘⇧C focus"))}</span>
        <span className="caps" style={{ position: "relative", minWidth: 0 }}>
          <button
            type="button"
            className="caption-btn"
            // polish P4-composer-38: "(cached)" says what it means
            title={cached ? `${t("Skills, slash commands, plugins and MCP servers available in this session")}\n${t("From an earlier session — replaced once this session reports")}` : t("Skills, slash commands, plugins and MCP servers available in this session")}
            onClick={() => setShowCaps((v) => !v)}
            data-testid="Capabilities"
          >
            {state.session.extensions?.fallback ? "⚠ " : ""}
            {mcpWarn && (
              <span
                className={`status-dot ${mcpWarn} mcp-warn-dot`}
                title={mcpWarn === "red" ? t("An MCP server failed — open Applied extensions") : t("An MCP server needs you to sign in")}
                data-testid="MCP warning"
              />
            )}
            {capabilitiesCaption({ caps, cached, mcpCount: mcpList.length, starting: palette.starting, loadUserSettings: palette.loadUserSettings })}
          </button>
          {showCaps && <CapabilitiesPopover caps={caps} onClose={closeCaps} />}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="attach-btn plain"
          disabled={state.project === null || images.length >= 5}
          onClick={() => void pickImages()}
          title={state.project === null ? t("Open a project first (⌘O)") : images.length >= 5 ? t("Attach at most 5 images.") : t("Attach images (PNG, JPEG, GIF, WebP · up to 5 MB each) — you can also paste or drop them")}
          aria-label={t("Attach images")}
          data-testid="Attach images"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 4.5 5.8 9.2a1.5 1.5 0 0 0 2.1 2.1l5-5a3 3 0 0 0-4.2-4.2l-5.2 5.2a4.5 4.5 0 0 0 6.4 6.4L14 9.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {images.length > 0 && <span className="num">{images.length}</span>}
        </button>
        {runAsTask && (
          <button
            type="button"
            className="attach-btn plain"
            disabled={state.project === null || viewing !== null}
            onClick={() => openDialog({ kind: "newWorkbench", task: composerTaskText(draft, mentions) })}
            title={state.project === null ? t("Open a project first (⌘O)")
              : viewing !== null ? t("Go back to the running chat to run this as a task")
              : t("Run as Task — start this message in a new workbench (its own branch, window and chat); this chat is left as it is")}
            aria-label={t("Run as Task")}
            data-testid="Run as Task"
          >
            {/* §49: the Mac's arrow.triangle.branch */}
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 14V2M4 2 2 4M4 2l2 2M4 10c0-3 8-2.5 8-6.5V2m0 0-2 2m2-2 2 2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        )}
        <NextMessageModelMenu value={nextModel} onChange={setNextModel} models={state.session.availableModels ?? []} disabled={state.project === null} />
        <ModeMenu />
        {state.session.starting && <span className="caption muted" data-testid="Session starting">{t("Starting session…")}</span>}
        {!state.session.starting && state.project !== null && !state.session.open && (
          <>
            <button type="button" disabled={!state.session.canRestart} onClick={() => void restartSession()} title={t("Reconnects this chat")} data-testid="Restart session">
              {t("Session ended — Restart")}
            </button>
            <button type="button" disabled={switchRefusal !== null} onClick={() => void newChat()} title={switchRefusal ?? t("Starts a new chat — the old one stays in History")} data-testid="Session ended new chat">
              {t("New chat")}
            </button>
          </>
        )}
        {/* MARK: wave4 w4-safety — robustness-07: the stop did not stop within 10 s. */}
        {running && interruptStuck && (
          <button
            type="button"
            onClick={forceRestartStuckTurn}
            title={t("The turn did not stop. Ends the Claude process and continues the same conversation — the queue and the review stay.")}
            data-testid="Force restart"
          >
            ↻ {t("Force restart")}
          </button>
        )}
        {running && (
          // polish P4-composer-04: the key in its tooltip, a name for screen readers (not "black square Stop")
          <button type="button" onClick={interrupt} title={t("Stop Claude's turn (⌘. · esc)")} aria-label={t("Stop")} data-testid="Stop"><span aria-hidden="true">■</span> {t("Stop")}</button>
        )}
        {!viewing /* wave4b w4b-tabs: the running chat's review */ && (hasPendingReview(state) || noteCount > 0) && (
          <button type="button" disabled={!canRequest} onClick={doRequestChanges}
            title={canRequest ? t("Send your notes to Claude as requested changes on this turn's diff (⌘⇧C)")
              : noteCount === 0 ? t("No review notes to send yet — add a note in the diff first") : (reason ?? t("Send your notes to Claude as requested changes on this turn's diff (⌘⇧C)"))}
            data-testid="Request changes">
            {t("Request changes ({0})", noteCount)}
          </button>
        )}
        {acceptAndSend && (
          <Menu
            label={t("Accept {0} & Send", pending)}
            align="right"
            title={t("Accepts the {0} pending file(s), then sends this message (⌘⇧↩)", pending)}
            testId="Accept and send menu"
            items={[
              {
                kind: "item",
                label: t("Accept {0} & Send", pending),
                title: t("Accepts the {0} pending file(s), then sends this message (⌘⇧↩)", pending),
                disabled: draft.trim().length === 0,
                onClick: doAcceptAndSend,
                testId: "Accept and send",
              },
            ]}
          />
        )}
        {primary !== "send" ? (
          <div className="split-send" ref={splitRef} data-testid="Queue split">
            {primary === "deny" ? (
              // r2-chats-cards M24 (§33.10): the text answers the waiting card — denied with it as the instruction.
              <button
                type="button"
                className="primary split-main"
                disabled={!hasText}
                onClick={doDenyWithText}
                title={t("{0} ({1})", t("Deny the waiting card with your message as the instruction — Claude follows it in this turn"), sendKey)}
                data-testid="Deny with this"
              >
                {t("Deny with this")}
              </button>
            ) : primary === "answer" ? (
              // r1-composer M08: the message answers Claude's open question (⌘↩); an empty box sends the card as it is.
              <button
                type="button"
                className="primary split-main"
                disabled={!hasText && !questionReady}
                onClick={doAnswer}
                title={!hasText && !questionReady ? t("Type an answer or pick an option on the card")
                  : t("Answers Claude's question with your message ({0}) — with an empty box, sends the card as it is. The menu sends the message apart from the question (⌥↩).", sendKey)}
                data-testid="Send answer"
              >
                {t("Send answer")}
              </button>
            ) : primary === "steer" ? (
              // §50: as typing while Claude works in the terminal — the message goes into this turn (⌘↩).
              <button
                type="button"
                className="primary split-main"
                disabled={!hasText}
                onClick={doSteer}
                title={t("Sends your message to Claude now: it reads it as soon as the current step is done, and its changes join this turn's review ({0}). The menu queues it for after the turn or stops the turn first.", sendKey)}
                data-testid="Send now"
              >
                {t("Send now")}
              </button>
            ) : (
              <button
                type="button"
                className="primary split-main"
                disabled={!hasText}
                onClick={doQueue}
                title={t("Queues your message; it is sent when Claude is free. The menu has “Stop and send” (⌥⌘↩). ({0})", sendKey)}
                data-testid="Add to queue"
              >
                {t("Add to queue")}
              </button>
            )}
            <button
              ref={splitChevRef}
              type="button"
              className="primary split-chev"
              aria-label={t("More send options")}
              aria-haspopup="menu"
              aria-expanded={splitOpen}
              title={t("More send options")}
              onClick={() => setSplitOpen((o) => !o)}
              data-testid="Send options"
            >
              <span aria-hidden="true">▾</span>
            </button>
            {splitOpen && (
              // §50: with "Send now" first the menu offers the queue (after the turn) before stopping the turn, as on the Mac.
              <div className="menu right split-menu" role="menu" ref={splitMenuRef} onKeyDown={onSplitMenuKey} aria-label={t("More send options")}>
                {primary === "answer" && separateItem}
                {(primary === "steer" || primary === "answer" || primary === "deny") && queueItem}
                <div
                  role="menuitem"
                  tabIndex={-1}
                  aria-disabled={!running || !hasText}
                  className={`item ${!running || !hasText ? "disabled" : ""}`}
                  title={t("Stops Claude's current turn, waits for it to end, then sends this message first (⌥⌘↩)")}
                  onClick={() => (running && hasText ? doStopAndSend() : undefined)}
                  data-testid="Stop and send"
                >
                  <span className="col" style={{ gap: 1 }}>
                    <span>{t("Stop & send")}</span>
                    <span className="tiny faint">{running ? t("Interrupts the turn, then sends this first") : t("Only while Claude is working")}</span>
                  </span>
                </div>
                {primary === "queue" && queueItem}
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={!canSend || draft.trim().length === 0}
            onClick={doSend}
            aria-label={t("Send")}
            title={viewBlock ?? (viewWait !== null ? viewWaitKeyHint : !canSend && reason !== null ? reason : t("Sends your message. The review list is left exactly as it is ({0})", sendKey))}
            data-testid="Send"
          >
            {t("Send")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * MARK: r2-review-flow — M30 (§3): the turn's changes could not be collected — the input stays open (the next message collects
 * them with its own) and the retry is right here, not only in the Changes list a narrow window hides; the error's own words
 * can be copied (polish P2-review-41).
 */
function CollectFailedLine() {
  const error = useStore((s) => s.state.gate.collectError ?? null);
  const collecting = useStore((s) => s.state.gate.phase === "collecting");
  const retryCollect = useStore((s) => s.retryCollect);
  if (!error) return null;
  return (
    <div className="pending-banner collect-failed" role="status" data-testid="Collect failed notice">
      <div className="row" style={{ gap: 6 }}>
        <span className="grow truncate" title={error}>⚠ {collectFailedNotice(error)}</span>
        <CopyButton text={error} iconOnly title={t("Copy the error")} />
        <button type="button" className="small" disabled={collecting} onClick={retryCollect} title={t("Collect the turn's changes again")} data-testid="Retry collect from composer">
          {t("Retry")}
        </button>
      </div>
    </div>
  );
}

/** polish P4-composer-16: the message box's height the user dragged it to (kept per app, not per chat). */
const COMPOSER_HEIGHT_KEY = "rg.composerHeight";
const COMPOSER_MIN_HEIGHT = 60;

function readComposerHeight(): number {
  try {
    const v = Number(localStorage.getItem(COMPOSER_HEIGHT_KEY));
    return Number.isFinite(v) && v >= COMPOSER_MIN_HEIGHT ? v : COMPOSER_MIN_HEIGHT;
  } catch {
    return COMPOSER_MIN_HEIGHT;
  }
}

function writeComposerHeight(h: number): void {
  try {
    localStorage.setItem(COMPOSER_HEIGHT_KEY, String(Math.round(h)));
  } catch {
    // storage blocked: the height lasts for this window
  }
}

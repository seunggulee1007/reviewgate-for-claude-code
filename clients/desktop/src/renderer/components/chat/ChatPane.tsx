/** The chat column (the Mac app's `ChatView`): tab strip (M15), transcript, HUD strip, composer and the engine log. */
import { isDiffCollapsed } from "../../friction";
import { useStore } from "../../store";
import { ChatTabs } from "./ChatTabs";
import { Composer } from "./Composer";
import { ContextWarningBanner } from "./ContextWarningBanner";
import { HUDStrip } from "./HUDStrip";
import { PeerCard } from "./PeerCard";
import { PermissionNotices } from "./PermissionBits";
import { PlanCard } from "./PlanCard";
import { QuestionSlot } from "./QuestionCard"; // MARK: r1-composer M08
import { SidecarLog } from "./SidecarLog";
import { StatusLine } from "./StatusLine"; // MARK: wave6 w6-statusline (§44.2)
import { Transcript } from "./Transcript";
import { ImportedChatNotice } from "../OtherSessions"; // MARK: wave3 desktop-session
import { MovedChatBar } from "./ChatMoveViews"; // MARK: wave4b w4b-follow
import "./chat.css";
import "./composer.css";
import { useViewing } from "../../viewedChat"; // MARK: wave4b w4b-tabs

export default function ChatPane() {
  const width = useStore((s) => s.ui.chatWidth);
  // With the diff pane collapsed (M16) the chat takes the whole width regardless of the remembered split.
  const fullWidth = useStore((s) => isDiffCollapsed(s.state, s.ui, s.selectedPath));
  const viewing = useViewing(); // MARK: wave4b w4b-tabs — §39.2: the running chat's plan waits until it is shown
  return (
    <div className="pane chat" style={width && !fullWidth ? { flex: `0 1 ${width}px` } : undefined} data-testid="Chat pane">
      <ChatTabs />
      {/* wave3 desktop-session — §36.9 a chat imported from the terminal */}
      <ImportedChatNotice />
      <Transcript />
      <HUDStrip />
      <PermissionNotices />
      {/* r1-composer M08 — Claude's open question, the card the message box answers (none while another chat is shown) */}
      <QuestionSlot />
      {!viewing && <PlanCard />}
      <ContextWarningBanner />
      <PeerCard />
      {/* wave4b w4b-follow — §39.4 "옮김 → <worktree>" / why a move was refused */}
      <MovedChatBar />
      <Composer />
      {/* wave6 w6-statusline — §44.2 the user's Claude Code status line, under the input as in the terminal */}
      <StatusLine />
      <SidecarLog />
    </div>
  );
}

export { Composer, HUDStrip, PlanCard, SidecarLog, Transcript };

/**
 * MARK: wave5 w5-board — §43.1: an agent's round face (the Mac's `AgentAvatarView`): pastel ring and the type's icon, a mood
 * badge (working "…", a waving hand for a permission, a turning arrow while retrying, a check with a sparkle when done, a
 * red X with dizzy stars when it failed, "z" while it rests) and a little bounce while it works. Reduce Motion keeps it
 * still (board.css).
 */
import type { AgentAvatar, AgentMood } from "../../agentAvatar";
import { moodMoves, moodWords } from "../../agentAvatar";
import { t } from "../../i18n";
import { AvatarFace, MoodGlyph, SparkleGlyph, StarGlyph } from "./AvatarGlyphs";
import "./board.css";

/** `showsMood` false: the face alone, still (no mood badge, sparkle, dizzy stars or bounce) — the sub-brain's "who wrote it". */
export function Avatar({ avatar, mood, size = 46, label = true, showsMood = true }: { avatar: AgentAvatar; mood: AgentMood; size?: number; label?: boolean; showsMood?: boolean }) {
  const name = avatar.name || t("Main agent");
  if (!showsMood) {
    return (
      <span
        className={`av tone-av-${avatar.tone}`}
        style={{ width: size, height: size, ["--av-ring" as string]: `${Math.max(1.5, size * 0.055)}px` }}
        role={label ? "img" : undefined}
        aria-label={label ? name : undefined}
        aria-hidden={label ? undefined : true}
        data-testid="Agent avatar"
        data-icon={avatar.icon}
      >
        <AvatarFace icon={avatar.icon} dizzy={false} />
      </span>
    );
  }
  return (
    <span
      className={`av tone-av-${avatar.tone} ${mood} ${moodMoves(mood) ? "moving" : ""}`}
      style={{ width: size, height: size, ["--av-ring" as string]: `${Math.max(2, size * 0.055)}px` }}
      role={label ? "img" : undefined}
      aria-label={label ? `${name}, ${moodWords(mood)}` : undefined}
      aria-hidden={label ? undefined : true}
      data-testid="Agent avatar"
      data-icon={avatar.icon}
      data-mood={mood}
    >
      <AvatarFace icon={avatar.icon} dizzy={mood === "failed"} />
      {mood === "done" && <SparkleGlyph className="av-sparkle" />}
      {mood === "failed" && (
        <span className="av-dizzy">
          <StarGlyph />
          <StarGlyph />
          <StarGlyph />
        </span>
      )}
      <span className={`av-badge ${mood}`}>
        <MoodGlyph mood={mood} />
      </span>
    </span>
  );
}

/**
 * MARK: wave5 w5-board — §43.1: the agent board's pictures as inline SVG (no icon package): the avatar faces (the Mac's SF
 * Symbols, drawn here with the same meaning), the tool icons, the mood badges and the tab icons. 24 × 24, currentColor.
 */
import type { ReactNode } from "react";
import type { AgentMood, AvatarIcon, ToolIcon } from "../../agentAvatar";

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function Svg({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** A 4-point sparkle centred at (x, y). */
function sparkle(x: number, y: number, r: number): string {
  const k = r * 0.28;
  return `M${x} ${y - r}L${x + k} ${y - k}L${x + r} ${y}L${x + k} ${y + k}L${x} ${y + r}L${x - k} ${y + k}L${x - r} ${y}L${x - k} ${y - k}Z`;
}

/** The seal of the verifier: a 12-bump badge. */
function seal(): string {
  const pts: string[] = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 10 : 8.4;
    pts.push(`${(12 + Math.cos(a) * r).toFixed(2)} ${(12 + Math.sin(a) * r).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
}

/** Claude's star: rays of two lengths around the middle. */
function claudeRays(): string {
  let d = "";
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const outer = i % 2 === 0 ? 9.5 : 7;
    d += `M${(12 + Math.cos(a) * 2.2).toFixed(2)} ${(12 + Math.sin(a) * 2.2).toFixed(2)}L${(12 + Math.cos(a) * outer).toFixed(2)} ${(12 + Math.sin(a) * outer).toFixed(2)}`;
  }
  return d;
}
const CLAUDE_RAYS = claudeRays();
const SEAL = seal();

export function AvatarFace({ icon, dizzy = false }: { icon: AvatarIcon; dizzy?: boolean }) {
  const c = "av-face";
  switch (icon) {
    case "hammer":
      return (
        <Svg className={c}>
          <g transform="rotate(-45 12 12)" fill="currentColor">
            <rect x="10.7" y="9" width="2.6" height="13" rx="1.2" />
            <rect x="6" y="3.5" width="12" height="6" rx="1.6" />
          </g>
        </Svg>
      );
    case "compass":
      return (
        <Svg className={c}>
          <circle cx="12" cy="4.8" r="2.2" {...stroke} />
          <path d="M11 7 6 20.5M13 7l5 13.5M7.6 15.5c2.9 1.4 5.9 1.4 8.8 0" {...stroke} />
        </Svg>
      );
    case "binoculars":
      return (
        <Svg className={c}>
          <circle cx="6.8" cy="15.5" r="4" {...stroke} />
          <circle cx="17.2" cy="15.5" r="4" {...stroke} />
          <path d="M3 15V9.5L5 5h4v8M21 15V9.5L19 5h-4v8M9 9.5h6" {...stroke} />
        </Svg>
      );
    case "flask":
      return (
        <Svg className={c}>
          <path d="M9 3h6M10 3v6.2L4.6 18.4A1.7 1.7 0 0 0 6.1 21h11.8a1.7 1.7 0 0 0 1.5-2.6L14 9.2V3" {...stroke} />
          <path d="M6.6 15.5h10.8l1.7 2.9a1.7 1.7 0 0 1-1.5 2.6H6.1a1.7 1.7 0 0 1-1.5-2.6z" fill="currentColor" />
        </Svg>
      );
    case "brush":
      return (
        <Svg className={c}>
          <path d="M19.5 3.2 21 4.7l-8 8.4-1.9-1.7z" fill="currentColor" />
          <path d="M10.4 12.3c-2.3-.2-4 1.3-4.2 3.6-.1 1.4-1 2.4-3 3 3.3 2 7.6 1.4 8.9-1.5.7-1.6.2-3.2-1.7-5.1z" fill="currentColor" />
        </Svg>
      );
    case "pencil":
      return (
        <Svg className={c}>
          <path d="M4 20l1.1-4.4L16 4.7a2.1 2.1 0 0 1 3 3L8.4 18.9z" {...stroke} />
          <path d="M14 6.8l3.2 3.2" {...stroke} />
        </Svg>
      );
    case "glasses":
      return (
        <Svg className={c}>
          <circle cx="6.8" cy="14" r="3.8" {...stroke} />
          <circle cx="17.2" cy="14" r="3.8" {...stroke} />
          <path d="M10.6 13.4c.9-.9 1.9-.9 2.8 0M3 14l-1-5M21 14l1-5" {...stroke} />
        </Svg>
      );
    case "shield":
      return (
        <Svg className={c}>
          <path d="M12 2.8 19.5 6v6c0 4.7-3.1 7.9-7.5 9.4C7.6 19.9 4.5 16.7 4.5 12V6z" {...stroke} />
          <path d="M12 2.8V21.4C7.6 19.9 4.5 16.7 4.5 12V6z" fill="currentColor" />
        </Svg>
      );
    case "bug":
      return (
        <Svg className={c}>
          <ellipse cx="12" cy="14" rx="6" ry="7" fill="currentColor" />
          <circle cx="12" cy="5.8" r="2.6" fill="currentColor" />
          <path d="M12 7.5V21M6.2 11H3M6.2 15.5H3M17.8 11H21M17.8 15.5H21M10 3.8 8.8 2.4M14 3.8l1.2-1.4" {...stroke} />
          <circle cx="9.3" cy="12.4" r="1.1" fill="var(--bg)" />
          <circle cx="14.7" cy="16.2" r="1.1" fill="var(--bg)" />
        </Svg>
      );
    case "map":
      return (
        <Svg className={c}>
          <path d="M3 6.2 9 4l6 2.2L21 4v13.8L15 20l-6-2.2L3 20z" {...stroke} />
          <path d="M9 4v13.8M15 6.2V20" {...stroke} />
        </Svg>
      );
    case "scales":
      return (
        <Svg className={c}>
          <path d="M12 4v15.5M8 20h8M4.5 7h15M12 4.2V3" {...stroke} />
          <path d="M4.5 7 2 12.6a2.6 2.6 0 0 0 5 0zM19.5 7 17 12.6a2.6 2.6 0 0 0 5 0z" {...stroke} />
        </Svg>
      );
    case "atom":
      return (
        <Svg className={c}>
          <circle cx="12" cy="12" r="1.9" fill="currentColor" />
          <ellipse cx="12" cy="12" rx="9.4" ry="3.7" {...stroke} />
          <ellipse cx="12" cy="12" rx="9.4" ry="3.7" transform="rotate(60 12 12)" {...stroke} />
          <ellipse cx="12" cy="12" rx="9.4" ry="3.7" transform="rotate(120 12 12)" {...stroke} />
        </Svg>
      );
    case "stamp":
      return (
        <Svg className={c}>
          <path d={SEAL} fill="currentColor" />
          <path d="M8.3 12.3l2.6 2.6 4.8-5.2" fill="none" stroke="var(--bg)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      );
    case "book":
      return (
        <Svg className={c}>
          <path d="M5 4.5h11.5A2.5 2.5 0 0 1 19 7v13.5H7.5A2.5 2.5 0 0 1 5 18z" {...stroke} />
          <path d="M5 18a2.5 2.5 0 0 1 2.5-2.5H19M9 8h6" {...stroke} />
        </Svg>
      );
    case "branch":
      return (
        <Svg className={c}>
          <circle cx="6" cy="5" r="2.3" {...stroke} />
          <circle cx="6" cy="19" r="2.3" {...stroke} />
          <circle cx="18" cy="6.5" r="2.3" {...stroke} />
          <path d="M6 7.3v9.4M18 8.8v1.4a4 4 0 0 1-4 4H9.6A3.6 3.6 0 0 0 6 17.8" {...stroke} />
        </Svg>
      );
    case "footprints":
      return (
        <Svg className={c}>
          <g fill="currentColor">
            <ellipse cx="7.5" cy="16" rx="2.6" ry="3.8" transform="rotate(-10 7.5 16)" />
            <circle cx="5.9" cy="10.6" r="1.05" />
            <circle cx="8.4" cy="10.4" r="1.05" />
            <ellipse cx="16.5" cy="9" rx="2.6" ry="3.8" transform="rotate(10 16.5 9)" />
            <circle cx="15.6" cy="3.6" r="1.05" />
            <circle cx="18.1" cy="3.8" r="1.05" />
          </g>
        </Svg>
      );
    case "checklist":
      return (
        <Svg className={c}>
          <path d="M3.5 6.2 5.2 8 8 5M3.5 12.2 5.2 14 8 11M3.5 18.2 5.2 20 8 17M11 6.5h9.5M11 12.5h9.5M11 18.5h9.5" {...stroke} />
        </Svg>
      );
    case "robot":
      return (
        <Svg className={c}>
          <path d="M12 8.4V5.2" {...stroke} />
          <circle cx="12" cy="4" r="1.7" fill="currentColor" />
          <rect x="4.2" y="8.3" width="15.6" height="12" rx="4" fill="currentColor" />
          {dizzy ? (
            <path d="M7.7 12.3l2.4 2.4m0-2.4-2.4 2.4M13.9 12.3l2.4 2.4m0-2.4-2.4 2.4" fill="none" stroke="var(--bg)" strokeWidth="1.7" strokeLinecap="round" />
          ) : (
            <>
              <circle cx="8.9" cy="13.5" r="1.6" fill="var(--bg)" />
              <circle cx="15.1" cy="13.5" r="1.6" fill="var(--bg)" />
            </>
          )}
          <path d="M10 17.3h4" fill="none" stroke="var(--bg)" strokeWidth="1.6" strokeLinecap="round" />
          <path d={sparkle(20.4, 3.6, 3)} fill="currentColor" />
        </Svg>
      );
    case "claude":
      return (
        <Svg className={c}>
          <path d={CLAUDE_RAYS} fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
        </Svg>
      );
  }
}

export function ToolGlyph({ icon }: { icon: ToolIcon }) {
  switch (icon) {
    case "doc":
      return <Svg><path d="M7 3h7l4.5 4.5V21H7zM14 3v4.5h4.5M9.5 12.5h6.5M9.5 16.5h6.5" {...stroke} /></Svg>;
    case "pencil":
      return <Svg><path d="M4 20l1.1-4.4L16 4.7a2.1 2.1 0 0 1 3 3L8.4 18.9zM14 6.8l3.2 3.2" {...stroke} /></Svg>;
    case "terminal":
      return <Svg><rect x="3" y="4" width="18" height="16" rx="2.6" {...stroke} /><path d="M7 9.2l3 2.8-3 2.8M12.5 15h4.5" {...stroke} /></Svg>;
    case "magnifier":
      return <Svg><circle cx="10.5" cy="10.5" r="6" {...stroke} /><path d="M15 15l5.5 5.5" {...stroke} /></Svg>;
    case "globe":
      return <Svg><circle cx="12" cy="12" r="9" {...stroke} /><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" {...stroke} /></Svg>;
    case "sparkles":
      return <Svg><path d={sparkle(10.5, 11, 7.5)} fill="currentColor" /><path d={sparkle(19, 18.5, 3.2)} fill="currentColor" /></Svg>;
    case "agent":
      return <Svg><circle cx="9" cy="8" r="3" {...stroke} /><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0M15.5 5.5a2.6 2.6 0 1 1 0 5.2M17 14.2a4.6 4.6 0 0 1 4 4.8" {...stroke} /></Svg>;
    case "checklist":
      return <Svg><path d="M3.5 6.2 5.2 8 8 5M3.5 12.2 5.2 14 8 11M3.5 18.2 5.2 20 8 17M11 6.5h9.5M11 12.5h9.5M11 18.5h9.5" {...stroke} /></Svg>;
    case "plug":
      return <Svg><path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5V21" {...stroke} /></Svg>;
    case "dooray":
      return (
        <Svg>
          <rect x="3" y="3" width="18" height="18" rx="5" fill="currentColor" />
          <path d="M9 7.5h2.8a4.5 4.5 0 0 1 0 9H9z" fill="none" stroke="var(--bg)" strokeWidth="2" strokeLinejoin="round" />
        </Svg>
      );
    case "database":
      return <Svg><ellipse cx="12" cy="5.5" rx="7" ry="2.6" {...stroke} /><path d="M5 5.5v13c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-13M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6" {...stroke} /></Svg>;
    case "searchCluster":
      return <Svg><path d="M4 6h11M4 10h7M4 14h5" {...stroke} /><circle cx="16" cy="15" r="3.6" {...stroke} /><path d="M18.7 17.7 21 20" {...stroke} /></Svg>;
    case "browser":
      return <Svg><path d="M9.5 9.5l10.5 3.8-4.6 1.6-1.6 4.6z" fill="currentColor" /><path d="M5 5l2 2M9.5 3v2.6M3 9.5h2.6" {...stroke} /></Svg>;
    case "wrench":
      return <Svg><path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5L16 12l-2.6-.4L13 9z" {...stroke} /></Svg>;
  }
}

export function MoodGlyph({ mood }: { mood: AgentMood }) {
  switch (mood) {
    case "working":
      return <Svg><circle cx="6.5" cy="12" r="2" fill="currentColor" /><circle cx="12" cy="12" r="2" fill="currentColor" /><circle cx="17.5" cy="12" r="2" fill="currentColor" /></Svg>;
    case "waiting":
      return (
        <Svg>
          <path
            d="M8 13V6.6a1.3 1.3 0 0 1 2.6 0V11M10.6 11V4.9a1.3 1.3 0 0 1 2.6 0V11M13.2 11V5.9a1.3 1.3 0 0 1 2.6 0V12M15.8 12V8.6a1.3 1.3 0 0 1 2.6 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-4.8-2.4L4.6 16a1.4 1.4 0 0 1 2.2-1.7L8 16"
            {...stroke}
            strokeWidth={2.1}
          />
        </Svg>
      );
    case "retrying":
      return <Svg><path d="M20 12a8 8 0 0 1-13.6 5.7M4 12a8 8 0 0 1 13.6-5.7M17.6 2.8v3.6H14M6.4 21.2v-3.6H10" {...stroke} strokeWidth={2.4} /></Svg>;
    case "done":
      return <Svg><path d="M5 12.5l4.5 4.5L19 7.5" {...stroke} strokeWidth={3} /></Svg>;
    case "failed":
      return <Svg><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" {...stroke} strokeWidth={3} /></Svg>;
    case "stopped":
      return <Svg><rect x="6.5" y="6.5" width="11" height="11" rx="1.8" fill="currentColor" /></Svg>;
    case "idle":
      return <Svg><path d="M5 10h7l-7 8h7M14.5 4h5l-5 5.5h5" {...stroke} strokeWidth={2.4} /></Svg>;
  }
}

export function SparkleGlyph({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d={sparkle(12, 12, 10)} fill="currentColor" />
    </Svg>
  );
}

export function StarGlyph() {
  return (
    <Svg>
      <path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z" fill="currentColor" />
    </Svg>
  );
}

/** The board's tab icons and the summary's. */
export function BoardGlyph({ kind }: { kind: "agents" | "brain" | "graph" | "moon" | "hand" | "sparkles" | "clock" | "gauge" | "tools" }) {
  switch (kind) {
    case "agents":
      return <ToolGlyph icon="agent" />;
    case "brain":
      return (
        <Svg>
          <path d="M9 4.5a3 3 0 0 0-3 3 3 3 0 0 0-2 5.2A3 3 0 0 0 6 18a3 3 0 0 0 6 1V5.6A3 3 0 0 0 9 4.5zM15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 2 5.2A3 3 0 0 1 18 18a3 3 0 0 1-6 1" {...stroke} />
        </Svg>
      );
    case "graph":
      return <Svg><circle cx="6" cy="6" r="2.5" {...stroke} /><circle cx="18" cy="8" r="2.5" {...stroke} /><circle cx="10" cy="18" r="2.5" {...stroke} /><path d="M8.3 7l7.2.7M7 8.3l2.2 7.4M16.6 10.1l-4.9 6" {...stroke} /></Svg>;
    case "moon":
      return <Svg><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" fill="currentColor" /></Svg>;
    case "hand":
      return <MoodGlyph mood="waiting" />;
    case "sparkles":
      return <ToolGlyph icon="sparkles" />;
    case "clock":
      return <Svg><circle cx="12" cy="12" r="8.5" {...stroke} /><path d="M12 7.5V12l3 2" {...stroke} /></Svg>;
    case "gauge":
      return <Svg><path d="M4 17a8 8 0 1 1 16 0" {...stroke} /><path d="M12 17l3.5-5" {...stroke} /></Svg>;
    case "tools":
      return <ToolGlyph icon="wrench" />;
  }
}

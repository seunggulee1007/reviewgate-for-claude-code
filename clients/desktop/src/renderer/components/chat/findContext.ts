/** What the transcript find bar needs opened (src/renderer/transcriptFind.ts `planFind`): agent groups and tool results. */
import { createContext } from "react";

export type FindReveal = { expand: ReadonlySet<string>; openResults: ReadonlySet<string> };
export const FindContext = createContext<FindReveal>({ expand: new Set(), openResults: new Set() });

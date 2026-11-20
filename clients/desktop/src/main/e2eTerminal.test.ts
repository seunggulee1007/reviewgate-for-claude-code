// §57.10 `--e2e-terminal`: the scratch userData and report flags are honoured only in an e2e run.
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { exit: () => undefined } }));

import { e2eOutArg, e2eUserDataArg, plainTerminalText } from "./e2eTerminal";

describe("--e2e-terminal flags (§57.10)", () => {
  it("--rg-user-data only with --e2e or --e2e-terminal", () => {
    expect(e2eUserDataArg(["electron", ".", "--rg-user-data=C:\\Users\\dev\\AppData\\Local\\Temp\\rg-e2e\\user-data"])).toBeNull();
    expect(e2eUserDataArg(["electron", ".", "--e2e-terminal", "--rg-user-data=C:\\Users\\dev\\AppData\\Local\\Temp\\x"])).toBe("C:\\Users\\dev\\AppData\\Local\\Temp\\x");
    expect(e2eUserDataArg(["electron", ".", "--e2e", "--rg-user-data=/tmp/x"])).toBe("/tmp/x");
    expect(e2eUserDataArg(["electron", ".", "--e2e", "--rg-user-data="])).toBeNull();
    expect(e2eOutArg(["electron", ".", "--rg-e2e-out=/tmp/r.json"])).toBeNull();
    expect(e2eOutArg(["electron", ".", "--e2e-terminal", "--rg-e2e-out=/tmp/r.json"])).toBe("/tmp/r.json");
  });

  it("reads a terminal's text without escape sequences or wrap breaks", () => {
    expect(plainTerminalText("\x1b[?9001h\x1b]0;title\x07\x1b[1;1Hfake-claude ses\r\nsion=1 \x1b[32mok\x1b[0m")).toBe("fake-claude session=1 ok");
  });
});

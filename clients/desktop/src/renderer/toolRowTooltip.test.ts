import { describe, expect, it } from "vitest";
import { TOOLTIP_VALUE_LIMIT, toolRowTooltip } from "./toolRowTooltip";

// polish p-foundation — P3-transcript-07: a tool row's tooltip says what the call did, in words, and what a click does —
// not its input as raw JSON. The Mac's Core `ToolRowTooltipTests` hold the same keys.

const root = "/work/acme";
const tip = (name: string, input: Record<string, unknown>, linked = false) => toolRowTooltip(name, input, root, linked);

describe("tool row tooltip", () => {
  it("a command says what it runs and why; one that changed reviewed files says a click shows them", () => {
    expect(tip("Bash", { command: "npm test -- --watch=false" })).toBe("Runs: npm test -- --watch=false");
    expect(tip("Bash", { command: "git status", description: "Show the working tree" })).toBe("Runs: git status\nDescription: Show the working tree");
    expect(tip("Bash", { command: "./gradlew spotlessApply" }, true)).toBe("Runs: ./gradlew spotlessApply\nClick to show the diff of the files it changed");
  });

  it("files read relative to the project (Windows paths too); outside it they stay whole", () => {
    expect(tip("Read", { file_path: "/work/acme/src/main/Svc.java" })).toBe("Reads src/main/Svc.java");
    expect(toolRowTooltip("Read", { file_path: "C:/Work/Acme/src/Svc.java" }, "c:\\work\\acme", false)).toBe("Reads src/Svc.java");
    expect(tip("Read", { file_path: "/Users/dev/notes.md" })).toBe("Reads /Users/dev/notes.md");
  });

  it("an edit says a click shows its diff", () => {
    expect(tip("Edit", { file_path: "/work/acme/src/Svc.java", old_string: "a", new_string: "b" }, true)).toBe("Edits src/Svc.java — click to show its diff");
    expect(tip("Write", { file_path: "/work/acme/README.md", content: "# acme" })).toBe("Edits README.md");
    expect(tip("NotebookEdit", { notebook_path: "/work/acme/nb.ipynb", new_source: "x = 1" })).toBe("Edits nb.ipynb");
  });

  it("searches say what and where", () => {
    expect(tip("Grep", { pattern: "TODO", path: "/work/acme/src" })).toBe("Searches for TODO in src");
    expect(tip("Grep", { pattern: "TODO", glob: "*.ts" })).toBe("Searches for TODO in *.ts");
    expect(tip("Grep", { pattern: "TODO" })).toBe("Searches for TODO");
    expect(tip("Glob", { pattern: "**/*.swift" })).toBe("Finds files: **/*.swift");
    expect(tip("Glob", { pattern: "*.md", path: "/work/acme/docs" })).toBe("Finds files: *.md in docs");
  });

  it("the web, agents, the to-do list, skills and MCP calls say their own words", () => {
    expect(tip("WebFetch", { url: "https://tasks.example.com/acme/42", prompt: "summary" })).toBe("Reads the web page https://tasks.example.com/acme/42");
    expect(tip("WebSearch", { query: "swift testing" })).toBe("Searches the web for swift testing");
    expect(tip("Task", { description: "Review the mapper", subagent_type: "reviewer" })).toBe("Starts an agent: Review the mapper");
    expect(tip("TodoWrite", { todos: [] })).toBe("Updates the to-do list");
    expect(tip("Skill", { skill: "acme-tools:smoke", args: "--fast" })).toBe("Skill: acme-tools:smoke --fast");
    expect(tip("mcp__tracker__get_task", { issueNumber: 42 })).toBe("tracker · get task\n42");
  });

  it("anything else shows its input as JSON, as before", () => {
    expect(tip("SomeFutureTool", { answer: "yes" })).toBe('{\n  "answer": "yes"\n}');
    // A call missing the field its words need falls back too.
    expect(tip("Bash", { description: "no command" })).toBe('{\n  "description": "no command"\n}');
  });

  it("a long command is cut", () => {
    expect(tip("Bash", { command: "x".repeat(2000) })).toBe(`Runs: ${"x".repeat(TOOLTIP_VALUE_LIMIT)}…`);
  });
});

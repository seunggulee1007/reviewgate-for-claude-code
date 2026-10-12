/**
 * wave3 check-clients — Settings › General › "테스트 명령 패턴" (`settings.testCommandPatterns`, docs/PROTOCOL.md §34.9),
 * as on the Mac (TestCommandSettingsSection): the user's own test commands, one glob per line, saved when the box loses
 * the focus (a half-typed `*` never counts every command as a test run), with the commands the engine already knows.
 */
import { useEffect, useState } from "react";
import type { AppSettings } from "../../../shared/ipc";
import { BUILT_IN_TEST_COMMANDS } from "../../../shared/testCommands";
import { t } from "../../i18n";
import { useStore } from "../../store";

export function TestCommandPatternsSection({ settings }: { settings: AppSettings }) {
  const save = useStore((s) => s.saveSettings);
  const value = settings.testCommandPatterns ?? "";
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <section data-testid="Test command patterns section">
      <h4 id="test-command-patterns">{t("Test command patterns")}</h4>
      <textarea
        className="mono"
        rows={3}
        value={draft}
        placeholder="./run-tests.sh*"
        spellCheck={false}
        aria-labelledby="test-command-patterns"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && void save({ testCommandPatterns: draft })}
        data-testid="Test command patterns"
      />
      <div className="note">
        {t("One per line, matched against each command of a Bash call as typed — * is any run of characters, ? one character. A matching command counts as a test run in the turn summary. Applied when you leave this box.")}
      </div>
      <div className="note" data-testid="Built-in test commands">
        {t("Recognized without a pattern: {0}", BUILT_IN_TEST_COMMANDS)}
      </div>
      <div className="note">{t("Maven and Gradle count when the goal or task runs tests (test, verify, check, …Test).")}</div>
    </section>
  );
}

/**
 * Settings › Accounts (the Mac app's `AccountsSettingsView`): `gh auth status` per host — who is
 * logged in where — Refresh, "Log in…" per row and for a new host (`login_in_terminal`).
 */
import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { isEnter } from "../../ime";

const HOST_RE = /^[A-Za-z0-9.-]+(:\d+)?$/;

export function AccountsTab() {
  const accounts = useStore((s) => s.state.pr.accounts);
  const loading = useStore((s) => s.state.pr.isLoading);
  const prRefreshAccounts = useStore((s) => s.prRefreshAccounts);
  const loginInTerminal = useStore((s) => s.loginInTerminal);
  const [newHost, setNewHost] = useState("");
  const host = newHost.trim();
  const valid = HOST_RE.test(host);
  const firstFailure = accounts.find((a) => !a.ok)?.detail ?? "";

  useEffect(() => {
    if (accounts.length === 0) void prRefreshAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = () => {
    if (valid) loginInTerminal(host);
  };

  return (
    <div className="body">
      <section>
        <div className="row">
          <h4 className="grow">{t("GitHub accounts")}</h4>
          {loading && <span className="spinner" />}
          <button type="button" className="small" disabled={loading} onClick={() => void prRefreshAccounts()} data-testid="Refresh accounts">↻ {t("Refresh")}</button>
        </div>
        {accounts.length === 0 ? (
          <div className="note">{t("No GitHub accounts found. Log in to a host below.")}</div>
        ) : (
          <table data-testid="Accounts table">
            <thead>
              <tr>
                <th>{t("Host")}</th>
                <th>{t("Login")}</th>
                <th>{t("Status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.host} data-testid={`Account ${a.host}`}>
                  <td className="truncate" title={a.host}>{a.host}</td>
                  <td className={a.login ? "" : "muted"}>{a.login ?? "—"}</td>
                  <td className={`status ${a.ok ? "ok" : "bad"}`} title={a.detail}>{a.ok ? `✓ ${t("OK")}` : `✗ ${t("Not logged in")}`}</td>
                  <td>
                    <button type="button" className="small" onClick={() => loginInTerminal(a.host)} data-testid="Log in">{t("Log in…")}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {firstFailure && <div className="detail">{firstFailure}</div>}
      </section>
      <section>
        <h4>{t("Add a host")}</h4>
        <div className="row">
          <input type="text" value={newHost} placeholder="github.example.com" onChange={(e) => setNewHost(e.target.value)} onKeyDown={(e) => isEnter(e) && login()} data-testid="New host" />
          <button type="button" disabled={!valid} onClick={login} data-testid="Log in new host">{t("Log in…")}</button>
        </div>
        <div className="note">
          {valid || host.length === 0
            ? t("Opens a terminal with `{0}`. Press Refresh once the browser flow completes.", `gh auth login --hostname ${host || "HOST"} --web`)
            : t("Enter a valid host (letters, digits, `.`, `-`, optional `:port`).")}
        </div>
      </section>
    </div>
  );
}

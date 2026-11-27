import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §72.3 on the Mac: `/plugin` through `claude plugin … --json`, and `/reload-plugins`.
@Suite struct PluginManagerTests {
    @Test func theListOnTheWire() throws {
        let json = #"{"type":"plugins_list","installed":[{"id":"fmt@acme-market","name":"fmt","marketplace":"acme-market","version":"1.2.0","scope":"user","enabled":true,"appOff":true},{"id":"lint@acme-market","name":"lint","marketplace":"acme-market","version":"abc","scope":"managed","enabled":false,"errors":["not cached"]},{"name":"no id"}],"available":[{"id":"deploy@acme-market","name":"deploy","marketplace":"acme-market","description":"Deploy helpers","installCount":12}],"marketplaces":[{"name":"acme-market","source":"github","repo":"acme/plugins","ref":"v1"},{"name":"local-dev","source":"directory","path":"/work/acme/market"}]}"#
        let event = try NDJSON.decode(EngineEvent.self, from: json)
        guard case let .pluginsList(list) = event else { Issue.record("not plugins_list: \(event)"); return }
        #expect(list.installed.map(\.id) == ["fmt@acme-market", "lint@acme-market"])   // one without an id is skipped
        #expect(list.installed[0].appOff && list.installed[0].manageBlocker == nil)
        #expect(list.installed[1].errors == ["not cached"] && list.installed[1].manageBlocker == PluginText.managedBlocker)
        #expect(list.available == [PluginAvailable(id: "deploy@acme-market", name: "deploy", marketplace: "acme-market", description: "Deploy helpers", installCount: 12)])
        #expect(list.marketplaces.map(\.location) == ["acme/plugins#v1", "/work/acme/market"])
        #expect(list.error == nil)
    }

    @Test func theResultAndTheReloadOnTheWire() throws {
        let result = try NDJSON.decode(EngineEvent.self, from: #"{"type":"plugin_result","action":"install","target":"deploy@acme-market","ok":false,"message":"The command was only displayed","output":"Run this command now? [y/N]"}"#)
        #expect(result == .pluginResult(PluginResult(action: .install, target: "deploy@acme-market", ok: false, message: "The command was only displayed", output: "Run this command now? [y/N]")))
        let held = try NDJSON.decode(EngineEvent.self, from: #"{"type":"plugins_reloaded","applied":false,"held":true,"cacheImpact":{"mcpServersAdded":["plugin:fmt:srv"],"mcpServersRemoved":[],"lspToolChange":null},"plugins":1,"skills":2,"agents":3,"hooks":0,"mcpServers":0,"errors":0}"#)
        guard case let .pluginsReloaded(r) = held else { Issue.record("not plugins_reloaded"); return }
        #expect(r.held && r.mcpServersAdded == ["plugin:fmt:srv"])
        #expect(PluginText.reloaded(r).contains("plugin:fmt:srv"))
        let done = PluginsReloaded(applied: true, plugins: 2, skills: 5, agents: 4, hooks: 3, mcpServers: 1, errors: 1)
        #expect(PluginText.reloaded(done).hasPrefix(String(localized: "Reloaded: \(2) plugins · \(5) skills · \(4) agents · \(3) hooks · \(1) plugin MCP servers", bundle: .module)))
        #expect(PluginText.reloaded(done).contains(String(localized: "\(1) errors during load — see /plugin", bundle: .module)))
    }

    @Test func theCommandsOnTheWire() throws {
        func encoded(_ c: EngineCommand) throws -> [String: String] {
            let o = try JSONSerialization.jsonObject(with: try JSONEncoder().encode(c)) as? [String: Any] ?? [:]
            return o.mapValues { "\($0)" }
        }
        #expect(try encoded(.pluginRun(action: .marketplaceAdd, target: "acme/plugins", scope: "user")) == ["type": "plugin_run", "action": "marketplace_add", "target": "acme/plugins", "scope": "user"])
        #expect(try encoded(.pluginRun(action: .enable, target: "fmt", scope: nil)) == ["type": "plugin_run", "action": "enable", "target": "fmt"])
        #expect(try encoded(.pluginsReload(force: true)) == ["type": "plugins_reload", "force": "1"])
        #expect(try encoded(.pluginsReload(force: false)) == ["type": "plugins_reload"])
        #expect(try encoded(.pluginsList) == ["type": "plugins_list"])
    }

    @Test func aTypedSlashPluginAsTheTerminalsSessionForms() {
        #expect(PluginRequest.parse("") == PluginRequest(tab: .discover))
        #expect(PluginRequest.parse("install deploy@acme-market") == PluginRequest(tab: .discover, action: .install, target: "deploy@acme-market"))
        #expect(PluginRequest.parse("install") == PluginRequest(tab: .discover))
        #expect(PluginRequest.parse("manage") == PluginRequest(tab: .installed))
        #expect(PluginRequest.parse("list") == PluginRequest(tab: .installed))
        #expect(PluginRequest.parse("enable fmt") == PluginRequest(tab: .installed, action: .enable, target: "fmt"))
        #expect(PluginRequest.parse("disable fmt") == PluginRequest(tab: .installed, action: .disable, target: "fmt"))
        #expect(PluginRequest.parse("uninstall fmt@acme-market") == PluginRequest(tab: .installed, action: .uninstall, target: "fmt@acme-market"))
        #expect(PluginRequest.parse("marketplace") == PluginRequest(tab: .marketplaces))
        #expect(PluginRequest.parse("market add acme/plugins") == PluginRequest(tab: .marketplaces, action: .marketplaceAdd, target: "acme/plugins"))
        #expect(PluginRequest.parse("marketplace rm acme-market") == PluginRequest(tab: .marketplaces, action: .marketplaceRemove, target: "acme-market"))
        #expect(PluginRequest.parse("marketplace update acme-market") == PluginRequest(tab: .marketplaces, action: .marketplaceUpdate, target: "acme-market"))
        #expect(PluginRequest.parse("validate ./x").unknown == "validate")
        #expect(PluginAction.install.confirms && PluginAction.marketplaceRemove.confirms && !PluginAction.enable.confirms && !PluginAction.update.confirms)
        #expect(PluginAction.marketplaceAdd.cliWords == "marketplace add")
    }

    @Test func slashPluginAndReloadPlugins() {
        #expect(SlashAppCommand.parse("/plugin", entries: []) == .plugin(""))
        #expect(SlashAppCommand.parse("/plugins install fmt", entries: []) == .plugin("install fmt"))
        #expect(SlashAppCommand.parse("/marketplace add acme/plugins", entries: []) == .plugin("marketplace add acme/plugins"))
        #expect(SlashAppCommand.parse("/marketplace", entries: []) == .plugin("marketplace"))
        #expect(SlashAppCommand.parse("/reload-plugins", entries: []) == .reloadPlugins(force: false))
        #expect(SlashAppCommand.parse("/reload-plugins --force", entries: []) == .reloadPlugins(force: true))
        #expect(SlashAppCommand.parse("/reload-plugins force", entries: []) == .reloadPlugins(force: true))
        #expect(!SlashAppCommand.terminalOnly.contains("plugin"))
        #expect(SlashAppCommand.description("reload-plugins") == PluginText.reloadDescription)
        #expect(EngineMessages.refusal(error: "plugins_turn_running") == PluginText.refusal(code: "plugins_turn_running", detail: ""))
    }
}

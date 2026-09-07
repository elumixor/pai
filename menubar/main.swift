// pai menu bar: shows what the assistant is doing, polled from the local daemon.
// Build: swiftc -O -o pai-menubar main.swift  (see scripts/install-daemon.ts)
import AppKit
import Foundation

struct Task: Decodable {
    let shortId: String
    let kind: String
    let title: String
    let state: String
    let waiting: Bool?
    let costUsd: Double?
    let lastTool: String?
    let project: String?
}
struct Tasks: Decodable { let live: [Task]; let recent: [Task] }
struct Health: Decodable { let ok: Bool; let dashboardUrl: String?; let dashboardKey: String? }

let base = "http://127.0.0.1:8787"

final class App: NSObject, NSApplicationDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    var dashboard = ""
    var key = ""
    var up = false

    func applicationDidFinishLaunching(_ n: Notification) {
        item.menu = menu
        render(live: [], recent: [])
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in self.poll() }
        poll()
    }

    func get<T: Decodable>(_ path: String, _ type: T.Type, _ done: @escaping (T?) -> Void) {
        var req = URLRequest(url: URL(string: base + path)!)
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { data, _, _ in
            let value = data.flatMap { try? JSONDecoder().decode(T.self, from: $0) }
            DispatchQueue.main.async { done(value) }
        }.resume()
    }

    func poll() {
        get("/health", Health.self) { h in
            self.up = h?.ok ?? false
            if let d = h?.dashboardUrl { self.dashboard = d }
            if let k = h?.dashboardKey { self.key = k }
            if !self.up { self.render(live: [], recent: []); return }
            self.get("/tasks", Tasks.self) { t in self.render(live: t?.live ?? [], recent: t?.recent ?? []) }
        }
    }

    func dot(_ t: Task) -> String {
        if t.waiting == true { return "🟡" }
        switch t.state { case "busy", "starting": return "🔵"; case "idle": return "🟢"; case "dead": return "⚪"; default: return "⚪" }
    }

    func render(live: [Task], recent: [Task]) {
        let tasks = live.filter { $0.kind != "main" }
        let busy = tasks.filter { $0.state == "busy" || $0.state == "starting" }.count
        let waiting = tasks.filter { $0.waiting == true }.count
        let main = live.first { $0.kind == "main" }
        var title = "π"
        if !up { title = "π ✕" }
        else if waiting > 0 { title = "π 🟡\(waiting)" }
        else if busy > 0 { title = "π \(busy)" }
        else if main?.state == "busy" { title = "π …" }
        item.button?.title = title

        menu.removeAllItems()
        if !up {
            menu.addItem(withTitle: "daemon not running", action: nil, keyEquivalent: "")
        } else {
            if let m = main {
                menu.addItem(withTitle: "\(dot(m)) main · \(m.state)\(m.lastTool.map { $0.isEmpty ? "" : " · " + $0 } ?? "")", action: nil, keyEquivalent: "")
            }
            let shown = tasks.isEmpty ? Array(recent.prefix(6)) : tasks
            if shown.isEmpty { menu.addItem(withTitle: "no tasks", action: nil, keyEquivalent: "") }
            for t in shown {
                var line = "\(dot(t)) \(t.title) · \(t.waiting == true ? "waiting" : t.state)"
                if let c = t.costUsd, c > 0 { line += String(format: " · $%.2f", c) }
                if let tool = t.lastTool, !tool.isEmpty, t.state == "busy" { line += "\n      ⚙ \(tool.prefix(60))" }
                let mi = NSMenuItem(title: line, action: #selector(openTask(_:)), keyEquivalent: "")
                mi.target = self
                mi.representedObject = t.shortId
                menu.addItem(mi)
            }
        }
        menu.addItem(.separator())
        let d = NSMenuItem(title: "Open dashboard", action: #selector(openDashboard), keyEquivalent: "d"); d.target = self
        menu.addItem(d)
        let r = NSMenuItem(title: "Restart daemon", action: #selector(restart), keyEquivalent: "r"); r.target = self
        menu.addItem(r)
        let l = NSMenuItem(title: "Show log", action: #selector(showLog), keyEquivalent: "l"); l.target = self
        menu.addItem(l)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    }

    /// The page remembers the key from the fragment, so every link carries it; the fragment never leaves the browser.
    func url(_ query: String) -> URL? {
        guard !dashboard.isEmpty else { return nil }
        let k = key.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? key
        return URL(string: "\(dashboard)/\(query)\(key.isEmpty ? "" : "#k=\(k)")")
    }
    @objc func openTask(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let u = url("?s=\(id)") else { return }
        NSWorkspace.shared.open(u)
    }
    @objc func openDashboard() { if let u = url("") { NSWorkspace.shared.open(u) } }
    @objc func restart() {
        let p = Process(); p.launchPath = "/bin/launchctl"
        p.arguments = ["kickstart", "-k", "gui/\(getuid())/dev.elumixor.pai"]; try? p.run()
    }
    @objc func showLog() {
        let log = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("dev/pai/data/daemon.log")
        NSWorkspace.shared.open(log)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = App()
app.delegate = delegate
app.run()

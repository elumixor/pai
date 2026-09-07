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
struct Health: Decodable { let ok: Bool; let dashboardUrl: String? }

let base = "http://127.0.0.1:8787"

/// lucide.dev cake-slice (ISC), drawn as a template image so the menu bar tints it.
let cakeSVG = """
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" \
stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
<path d="M16 13H3" />
<path d="M16 17H3" />
<path d="m7.2 7.9-3.388 2.5A2 2 0 0 0 3 12.01V20a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-8.654c0-2-2.44-6.026-6.44-8.026a1 1 0 0 0-1.082.057L10.4 5.6" />
<circle cx="9" cy="7" r="2" />
</svg>
"""

func cakeIcon(_ size: CGFloat = 16) -> NSImage {
    guard let image = NSImage(data: Data(cakeSVG.utf8)) else { fatalError("cake-slice icon failed to decode") }
    image.size = NSSize(width: size, height: size)
    image.isTemplate = true
    return image
}

final class App: NSObject, NSApplicationDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    var dashboard = ""
    var up = false
    let icon = cakeIcon()

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
            if !self.up { self.render(live: [], recent: []); return }
            self.get("/tasks", Tasks.self) { t in self.render(live: t?.live ?? [], recent: t?.recent ?? []) }
        }
    }

    func dot(_ t: Task) -> String {
        if t.waiting == true { return "🟡" }
        switch t.state { case "busy", "starting": return "🔵"; case "idle": return "🟢"; case "dead": return "⚪"; default: return "⚪" }
    }

    /// The menu bar line: how many tasks run, how many want an answer, what it has cost so far.
    /// Nothing at all when the daemon is up and idle — an unadorned icon is the resting state.
    func status(live: [Task], tasks: [Task], busy: Int, waiting: Int, main: Task?) -> NSAttributedString {
        var parts: [String] = []
        if !up {
            parts.append("✕")
        } else {
            if waiting > 0 { parts.append("?\(waiting)") }
            if busy > 0 { parts.append("\(busy)") } else if main?.state == "busy" { parts.append("…") }
            let spent = live.reduce(0.0) { $0 + ($1.costUsd ?? 0) }
            if spent >= 0.01 { parts.append(String(format: "$%.2f", spent)) }
        }
        let text = parts.isEmpty ? "" : " " + parts.joined(separator: " ")
        return NSAttributedString(
            string: text,
            attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)],
        )
    }

    func render(live: [Task], recent: [Task]) {
        let tasks = live.filter { $0.kind != "main" }
        let busy = tasks.filter { $0.state == "busy" || $0.state == "starting" }.count
        let waiting = tasks.filter { $0.waiting == true }.count
        let main = live.first { $0.kind == "main" }
        item.button?.image = icon
        item.button?.imagePosition = .imageLeading
        item.button?.attributedTitle = status(live: live, tasks: tasks, busy: busy, waiting: waiting, main: main)

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

    @objc func openTask(_ sender: NSMenuItem) {
        guard !dashboard.isEmpty, let id = sender.representedObject as? String else { return }
        NSWorkspace.shared.open(URL(string: "\(dashboard)/?s=\(id)")!)
    }
    @objc func openDashboard() { if !dashboard.isEmpty { NSWorkspace.shared.open(URL(string: dashboard)!) } }
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

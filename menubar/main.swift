// pai menu bar: shows what the assistant is doing, polled from the box, and the
// Claude subscription quota as two rings: the five-hour session window and the model-scoped
// weekly limit. Each ring is one element for one window: a thin outer arc for the time still
// left, a coloured inner arc for the share used, the percentage in the middle.
// Build: swiftc -O -o pai-menubar main.swift  (see scripts/install-daemon.ts)
import AppKit
import Foundation

struct Task: Decodable {
    let shortId: String
    let kind: String
    let title: String
    let state: String
    let waiting: Bool?
    let lastTool: String?
    let project: String?
}
struct Tasks: Decodable { let live: [Task]; let recent: [Task] }
struct HealthHost: Decodable { let hostname: String; let baseUrl: String? }
struct Health: Decodable { let ok: Bool; let version: String?; let host: HealthHost? }

/// The daemon may run on this Mac or on a host elsewhere. `~/.config/pai/menubar` holds the
/// base URL on its first line when it is the latter, and the token on a second line when the
/// daemon asks for one; without the file, the local daemon is assumed.
let configured: [String] = {
    let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/pai/menubar")
    let text = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
    return text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
}()
let base: String = configured.first.map { $0.hasSuffix("/") ? String($0.dropLast()) : $0 } ?? "http://127.0.0.1:8787"
let token: String = configured.count > 1 ? configured[1] : ""

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


// MARK: - Claude quota

struct QuotaWindow {
    let name: String
    let percent: Int
    let resetsAt: Date?
    let length: TimeInterval

    /// Share of the window still ahead, 1 at the start and 0 at the reset.
    var fractionRemaining: Double {
        guard let resetsAt else { return 0 }
        return min(1, max(0, resetsAt.timeIntervalSinceNow / length))
    }

    /// "4.8h" above an hour, "59m" below it, "3d" at a day or more.
    var resetText: String? {
        guard let resetsAt else { return nil }
        let s = resetsAt.timeIntervalSinceNow
        guard s > 0 else { return nil }
        if s >= 86_400 { return "\(Int((s / 86_400).rounded()))d" }
        if s >= 3600 {
            let tenths = (s / 360).rounded() / 10
            return tenths == tenths.rounded() ? "\(Int(tenths))h" : String(format: "%.1fh", tenths)
        }
        return "\(max(1, Int((s / 60).rounded())))m"
    }
}

struct UsagePeriod: Decodable { let utilization: Double; let resetsAt: String? }
struct UsageLimit: Decodable {
    struct Scope: Decodable { struct Model: Decodable { let displayName: String? }; let model: Model? }
    let kind: String
    let percent: Double
    let resetsAt: String?
    let scope: Scope?
}
struct Usage: Decodable { let fiveHour: UsagePeriod?; let limits: [UsageLimit]? }
/// The box's own reading of the limits (`/usage`), for a Mac without a Claude login.
struct BoxWindow: Decodable { let name: String; let percent: Int; let resetsAt: String?; let length: Double }
struct BoxUsage: Decodable { let windows: [BoxWindow] }

let isoFractional: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()
let isoPlain = ISO8601DateFormatter()
func isoDate(_ text: String?) -> Date? {
    guard let text else { return nil }
    return isoFractional.date(from: text) ?? isoPlain.date(from: text)
}

/// Claude Code keeps its OAuth token in the login keychain; the security CLI reads it without
/// an access-control dialog, which a direct Security.framework call would raise for a new binary.
func claudeAccessToken() -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
    process.arguments = ["find-generic-password", "-s", "Claude Code-credentials", "-w"]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return nil }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    return (json?["claudeAiOauth"] as? [String: Any])?["accessToken"] as? String
}

let sessionWindow: TimeInterval = 5 * 3600
let weeklyWindow: TimeInterval = 7 * 24 * 3600

func quotaWindows(_ usage: Usage) -> [QuotaWindow] {
    var windows: [QuotaWindow] = []
    if let session = usage.fiveHour {
        windows.append(QuotaWindow(name: "Session", percent: Int(session.utilization.rounded()),
                                   resetsAt: isoDate(session.resetsAt), length: sessionWindow))
    }
    if let model = usage.limits?.first(where: { $0.kind == "weekly_scoped" && $0.scope?.model != nil }) {
        windows.append(QuotaWindow(name: model.scope?.model?.displayName ?? "Model", percent: Int(model.percent.rounded()),
                                   resetsAt: isoDate(model.resetsAt), length: weeklyWindow))
    }
    return windows
}

func usageColor(_ percent: Int) -> NSColor {
    switch percent {
    case ..<50: return NSColor(red: 0.4, green: 0.75, blue: 0.45, alpha: 1)
    case ..<80: return NSColor(red: 1.0, green: 0.7, blue: 0.0, alpha: 1)
    default: return NSColor(red: 1.0, green: 0.3, blue: 0.3, alpha: 1)
    }
}

func arc(center: NSPoint, radius: CGFloat, fraction: Double, clockwise: Bool = true) -> NSBezierPath {
    let path = NSBezierPath()
    let sweep = 360 * CGFloat(min(1, max(0, fraction)))
    // Start at the top; a clockwise arc runs right, an anticlockwise one runs left.
    if clockwise {
        path.appendArc(withCenter: center, radius: radius, startAngle: 90, endAngle: 90 - sweep, clockwise: true)
    } else {
        path.appendArc(withCenter: center, radius: radius, startAngle: 90, endAngle: 90 + sweep, clockwise: false)
    }
    return path
}

/// The ring, drawn when the button paints so the label colours follow the menu bar appearance.
func ringImage(_ w: QuotaWindow, diameter: CGFloat = 18, stale: Bool = false) -> NSImage {
    let outerWidth: CGFloat = 1.5, innerWidth: CGFloat = 2.5, gap: CGFloat = 1.5
    let image = NSImage(size: NSSize(width: diameter, height: diameter), flipped: false) { rect in
        let center = NSPoint(x: rect.midX, y: rect.midY)
        let outerRadius = diameter / 2 - outerWidth / 2
        let innerRadius = outerRadius - outerWidth / 2 - gap - innerWidth / 2
        let color = stale ? usageColor(w.percent).withAlphaComponent(0.5) : usageColor(w.percent)

        NSColor.labelColor.withAlphaComponent(0.18).setStroke()
        let track = arc(center: center, radius: outerRadius, fraction: 1); track.lineWidth = outerWidth; track.stroke()
        // The lit arc is the time still left; it ends at the top and shrinks back towards it.
        NSColor.labelColor.withAlphaComponent(0.75).setStroke()
        let left = arc(center: center, radius: outerRadius, fraction: w.fractionRemaining, clockwise: false)
        left.lineWidth = outerWidth; left.lineCapStyle = .round; left.stroke()

        color.withAlphaComponent(0.28).setStroke()
        let innerTrack = arc(center: center, radius: innerRadius, fraction: 1); innerTrack.lineWidth = innerWidth; innerTrack.stroke()
        color.setStroke()
        let used = arc(center: center, radius: innerRadius, fraction: Double(w.percent) / 100)
        used.lineWidth = innerWidth; used.lineCapStyle = .round; used.stroke()

        // A dark outline behind the digits keeps them readable over the arcs in either appearance.
        let label = String(min(99, w.percent))
        let font = NSFont.monospacedDigitSystemFont(ofSize: diameter * 0.36, weight: .heavy)
        let size = NSAttributedString(string: label, attributes: [.font: font]).size()
        let origin = NSPoint(x: center.x - size.width / 2, y: center.y - size.height / 2)
        NSAttributedString(string: label, attributes: [
            .font: font, .strokeColor: NSColor.black.withAlphaComponent(0.85), .strokeWidth: 40,
        ]).draw(at: origin)
        NSAttributedString(string: label, attributes: [.font: font, .foregroundColor: color]).draw(at: origin)
        return true
    }
    return image
}

final class App: NSObject, NSApplicationDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    var dashboard = ""
    var version = ""
    var up = false
    let icon = cakeIcon()
    var live: [Task] = []
    var recent: [Task] = []
    var windows: [QuotaWindow] = []
    var usageFetchedAt: Date?
    var usageStale: Bool { usageFetchedAt.map { Date().timeIntervalSince($0) > 10 * 60 } ?? true }
    var claudeToken: String?

    func applicationDidFinishLaunching(_ n: Notification) {
        item.menu = menu
        render()
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in self.poll() }
        // The rings move with the clock as well as with the quota, so redraw between fetches.
        Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in self.pollUsage(); self.render() }
        poll()
        pollUsage()
    }

    func pollUsage() {
        if claudeToken == nil { claudeToken = claudeAccessToken() }
        guard let claudeToken else {
            get("/usage", BoxUsage.self) { u in
                guard let u, !u.windows.isEmpty else { return }
                self.windows = u.windows.map { QuotaWindow(name: $0.name, percent: $0.percent, resetsAt: isoDate($0.resetsAt), length: $0.length) }
                self.usageFetchedAt = Date()
                self.render()
            }
            return
        }
        var req = URLRequest(url: URL(string: "https://api.anthropic.com/api/oauth/usage")!)
        req.timeoutInterval = 10
        req.setValue("Bearer " + claudeToken, forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        URLSession.shared.dataTask(with: req) { data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            let usage = data.flatMap { try? decoder.decode(Usage.self, from: $0) }
            DispatchQueue.main.async {
                // A refused token is re-read next time: Claude Code refreshes it in the keychain.
                if status == 401 || status == 403 { self.claudeToken = nil }
                if let usage {
                    self.windows = quotaWindows(usage)
                    self.usageFetchedAt = Date()
                }
                self.render()
            }
        }.resume()
    }

    func get<T: Decodable>(_ path: String, _ type: T.Type, _ done: @escaping (T?) -> Void) {
        var req = URLRequest(url: URL(string: base + path)!)
        req.timeoutInterval = 2
        if !token.isEmpty { req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        URLSession.shared.dataTask(with: req) { data, _, _ in
            let value = data.flatMap { try? JSONDecoder().decode(T.self, from: $0) }
            DispatchQueue.main.async { done(value) }
        }.resume()
    }

    func poll() {
        get("/health", Health.self) { h in
            self.up = h?.ok ?? false
            self.dashboard = (h?.host?.baseUrl ?? base) + "/ui/"
            self.version = h?.version ?? ""
            if !self.up { self.live = []; self.recent = []; self.render(); return }
            self.get("/tasks", Tasks.self) { t in self.live = t?.live ?? []; self.recent = t?.recent ?? []; self.render() }
        }
    }

    func dot(_ t: Task) -> String {
        if t.waiting == true { return "🟡" }
        switch t.state { case "busy", "starting": return "🔵"; case "idle": return "🟢"; case "dead": return "⚪"; default: return "⚪" }
    }

    /// The menu bar line: how many tasks run and how many want an answer.
    /// Nothing at all when the daemon is up and idle — an unadorned icon is the resting state.
    func status(busy: Int, waiting: Int, main: Task?) -> NSAttributedString {
        var parts: [String] = []
        if !up {
            parts.append("✕")
        } else {
            if waiting > 0 { parts.append("?\(waiting)") }
            if busy > 0 { parts.append("\(busy)") } else if main?.state == "busy" { parts.append("…") }
        }
        let text = parts.isEmpty ? "" : " " + parts.joined(separator: " ")
        return NSAttributedString(
            string: text,
            attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)],
        )
    }

    /// Icon, pai status, then a ring per quota window, all in one attributed title.
    func title(busy: Int, waiting: Int, main: Task?) -> NSAttributedString {
        let result = NSMutableAttributedString(attributedString: status(busy: busy, waiting: waiting, main: main))
        for w in windows {
            let attachment = NSTextAttachment()
            let image = ringImage(w, stale: usageStale)
            attachment.image = image
            // Centre the ring on the text line rather than sitting it on the baseline.
            attachment.bounds = NSRect(x: 0, y: -5, width: image.size.width, height: image.size.height)
            result.append(NSAttributedString(string: " "))
            result.append(NSAttributedString(attachment: attachment))
        }
        return result
    }

    func render() {
        let tasks = live.filter { $0.kind != "main" }
        let busy = tasks.filter { $0.state == "busy" || $0.state == "starting" }.count
        let waiting = tasks.filter { $0.waiting == true }.count
        let main = live.first { $0.kind == "main" }
        item.button?.image = icon
        item.button?.imagePosition = .imageLeading
        item.button?.attributedTitle = title(busy: busy, waiting: waiting, main: main)

        menu.removeAllItems()
        if windows.isEmpty {
            menu.addItem(withTitle: claudeToken == nil ? "no Claude login here or on the box" : "no Claude usage yet", action: nil, keyEquivalent: "")
        }
        for w in windows {
            let reset = w.resetText.map { " · resets in \($0)" } ?? ""
            let mi = NSMenuItem(title: "\(w.name) \(w.percent)%\(reset)", action: #selector(openUsage), keyEquivalent: "")
            mi.target = self
            mi.image = ringImage(w, diameter: 16, stale: usageStale)
            menu.addItem(mi)
        }
        menu.addItem(.separator())
        if !up {
            menu.addItem(withTitle: "box not reachable (\(base))", action: nil, keyEquivalent: "")
        } else {
            if !version.isEmpty { menu.addItem(withTitle: version, action: nil, keyEquivalent: "") }
            if let m = main {
                menu.addItem(withTitle: "\(dot(m)) main · \(m.state)\(m.lastTool.map { $0.isEmpty ? "" : " · " + $0 } ?? "")", action: nil, keyEquivalent: "")
            }
            let shown = tasks.isEmpty ? Array(recent.prefix(6)) : tasks
            if shown.isEmpty { menu.addItem(withTitle: "no tasks", action: nil, keyEquivalent: "") }
            for t in shown {
                var line = "\(dot(t)) \(t.title) · \(t.waiting == true ? "waiting" : t.state)"
                if let tool = t.lastTool, !tool.isEmpty, t.state == "busy" { line += "\n      ⚙ \(tool.prefix(60))" }
                let mi = NSMenuItem(title: line, action: #selector(openTask(_:)), keyEquivalent: "")
                mi.target = self
                mi.representedObject = t.shortId
                menu.addItem(mi)
            }
        }
        menu.addItem(.separator())
        let c = NSMenuItem(title: "Claude in Terminal", action: #selector(openClaude), keyEquivalent: "c"); c.target = self
        menu.addItem(c)
        let d = NSMenuItem(title: "Open dashboard", action: #selector(openDashboard), keyEquivalent: "d"); d.target = self
        menu.addItem(d)
        let e = NSMenuItem(title: "Open editor", action: #selector(openEditor), keyEquivalent: "e"); e.target = self
        menu.addItem(e)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    }

    @objc func openTask(_ sender: NSMenuItem) {
        guard !dashboard.isEmpty, let id = sender.representedObject as? String else { return }
        NSWorkspace.shared.open(URL(string: "\(dashboard)?s=\(id)")!)
    }
    @objc func openDashboard() { if !dashboard.isEmpty { NSWorkspace.shared.open(URL(string: dashboard)!) } }
    @objc func openEditor() { NSWorkspace.shared.open(URL(string: (dashboard.isEmpty ? base : String(dashboard.dropLast(4))) + "/editor/")!) }
    /// `pai claude` in a new Terminal window: the main conversation, on the box.
    @objc func openClaude() {
        let script = "tell application \"Terminal\"\nactivate\ndo script \"pai claude\"\nend tell"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        try? process.run()
    }
    @objc func openUsage() { NSWorkspace.shared.open(URL(string: "https://claude.ai/settings/usage")!) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = App()
app.delegate = delegate
app.run()

import AppKit
import Foundation

struct Window {
    let label: String
    let group: String
    let percent: Double?
    let resetsAt: Date?
    let severity: String?
}

/// The two subscriptions the CLI tracks. Each is told apart by a glyph, a name and a
/// colour — Claude's spark in its terracotta, a hexagon in OpenAI's green for Codex.
enum Provider: String, CaseIterable {
    case claude, codex

    var name: String { self == .claude ? "Claude" : "Codex" }
    /// The CLI whose login this is — "active in Claude Code" / "active in Codex".
    var client: String { self == .claude ? "Claude Code" : "Codex" }
    var glyph: String { self == .claude ? "✳" : "⬢" }
    var color: NSColor {
        self == .claude
            ? NSColor(srgbRed: 0.85, green: 0.47, blue: 0.34, alpha: 1)
            : NSColor(srgbRed: 0.06, green: 0.64, blue: 0.50, alpha: 1)
    }
    /// Extra arguments that point a CLI command at this provider.
    var flag: [String] { self == .codex ? ["--provider", "codex"] : [] }
    /// A `remove`/`switch` target that cannot be confused with the other provider's account.
    func target(_ label: String) -> String { "\(rawValue):\(label)" }
}

struct Account {
    let provider: Provider
    let label: String
    let email: String
    let active: Bool
    let tier: String?
    let windows: [Window]
    let loginState: String
    let loginMessage: String
    let stale: String?
    let error: String?
    let readOnly: Bool

    var session: Double { windows.first { $0.group == "session" }?.percent ?? 0 }
    var weekly: Double { windows.filter { $0.group == "weekly" }.compactMap(\.percent).max() ?? 0 }
    var worst: Double { max(session, weekly) }
    var needsLogin: Bool { loginState == "expired" || loginState == "missing" }
    var nextSessionReset: Date? { windows.first { $0.group == "session" }?.resetsAt }
}

enum CLI {
    static let searchPaths = [
        "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
        "\(NSHomeDirectory())/.local/bin",
        "\(NSHomeDirectory())/.local/share/fnm/aliases/default/bin",
        "\(NSHomeDirectory())/.volta/bin",
        "\(NSHomeDirectory())/Library/pnpm",
        "\(NSHomeDirectory())/.nvm/versions/node",
    ]

    private static func firstExecutable(named name: String, in directories: [String]) -> String? {
        let fm = FileManager.default
        for directory in directories {
            let candidate = "\(directory)/\(name)"
            if fm.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    /// The bundled JS entry point, so the .app works without a separately installed CLI.
    static func bundledScript() -> String? {
        guard let resource = Bundle.main.resourceURL?.appendingPathComponent("cli.mjs").path,
              FileManager.default.isReadableFile(atPath: resource) else { return nil }
        return resource
    }

    static func locateNode() -> String? {
        let env = ProcessInfo.processInfo.environment
        if let override = env["USAGE_BAR_NODE"] ?? env["CLAUDE_USAGE_NODE"] { return override }
        var directories = searchPaths
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            directories += path.split(separator: ":").map(String.init)
        }
        if let found = firstExecutable(named: "node", in: directories) { return found }
        // nvm keeps versioned directories; take the newest.
        let nvm = "\(NSHomeDirectory())/.nvm/versions/node"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvm) {
            for version in versions.sorted(by: >) {
                let candidate = "\(nvm)/\(version)/bin/node"
                if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
            }
        }
        return nil
    }

    static func locateInstalledCLI() -> String? {
        let env = ProcessInfo.processInfo.environment
        if let override = env["USAGE_BAR_BIN"] ?? env["CLAUDE_USAGE_BIN"] { return override }
        var directories = searchPaths
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            directories += path.split(separator: ":").map(String.init)
        }
        return firstExecutable(named: "usage-bar", in: directories)
    }

    /// Runs the CLI and returns stdout, or throws with stderr as the message.
    @discardableResult
    static func run(_ arguments: [String], timeout: TimeInterval = 45) throws -> Data {
        let process = Process()
        if let script = bundledScript(), let node = locateNode() {
            process.executableURL = URL(fileURLWithPath: node)
            process.arguments = [script] + arguments
        } else if let binary = locateInstalledCLI() {
            process.executableURL = URL(fileURLWithPath: binary)
            process.arguments = arguments
        } else if bundledScript() != nil {
            throw AppError.message("Node.js 18+ was not found.\nInstall it (brew install node) and reopen Multi-Account Usage Bar.")
        } else {
            throw AppError.message("`usage-bar` was not found.\nInstall it, or set USAGE_BAR_BIN.")
        }
        var environment = ProcessInfo.processInfo.environment
        environment["NO_COLOR"] = "1"
        // Node lives outside the sandboxed app's default PATH.
        let extraPaths = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        environment["PATH"] = (extraPaths + [environment["PATH"] ?? ""]).joined(separator: ":")
        process.environment = environment

        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        try process.run()

        let deadline = Date().addingTimeInterval(timeout)
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        let errData = err.fileHandleForReading.readDataToEndOfFile()
        while process.isRunning && Date() < deadline { usleep(50_000) }
        if process.isRunning {
            process.terminate()
            throw AppError.message("`usage-bar \(arguments.joined(separator: " "))` timed out.")
        }
        process.waitUntilExit()

        if process.terminationStatus != 0 {
            let message = String(data: errData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            throw AppError.message(message.isEmpty ? "usage-bar exited with status \(process.terminationStatus)" : message)
        }
        return outData
    }
}

enum AppError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        if case let .message(text) = self { return text }
        return nil
    }
}

enum Format {
    static func relative(_ interval: TimeInterval) -> String {
        if interval <= 0 { return "now" }
        let minutes = Int((interval / 60).rounded())
        let days = minutes / 1440
        let hours = (minutes % 1440) / 60
        let mins = minutes % 60
        if days > 0 { return "\(days)d \(hours)h" }
        if hours > 0 { return String(format: "%dh %02dm", hours, mins) }
        return "\(mins)m"
    }

    static func clock(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm" : "EEE HH:mm"
        return formatter.string(from: date)
    }
}

final class UsageStore {
    private(set) var accounts: [Account] = []
    private(set) var lastError: String?
    /// When this app last ran the CLI.
    private(set) var updatedAt: Date?
    /// When the numbers on screen were actually read from Anthropic — the CLI spaces
    /// requests out machine-wide, so most runs answer from its cache.
    private(set) var fetchedAt: Date?

    private let iso = ISO8601DateFormatter()

    init() {
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    }

    private func parseDate(_ value: Any?) -> Date? {
        guard let text = value as? String else { return nil }
        if let date = iso.date(from: text) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: text)
    }

    func reload() {
        do {
            let data = try CLI.run(["--json"])
            guard let raw = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
                throw AppError.message("Unexpected output from usage-bar --json")
            }
            accounts = raw.map { item in
                let login = item["login"] as? [String: Any] ?? [:]
                let windows = (item["windows"] as? [[String: Any]] ?? []).map { w in
                    Window(
                        label: w["label"] as? String ?? "?",
                        group: w["group"] as? String ?? "weekly",
                        percent: w["percent"] as? Double,
                        resetsAt: parseDate(w["resetsAt"]),
                        severity: w["severity"] as? String
                    )
                }
                return Account(
                    provider: Provider(rawValue: item["provider"] as? String ?? "claude") ?? .claude,
                    label: item["label"] as? String ?? "?",
                    email: item["email"] as? String ?? "",
                    active: item["active"] as? Bool ?? false,
                    tier: item["tier"] as? String,
                    windows: windows,
                    loginState: login["state"] as? String ?? "unknown",
                    loginMessage: login["message"] as? String ?? "",
                    stale: item["stale"] as? String,
                    error: item["error"] as? String,
                    readOnly: item["readOnly"] as? Bool ?? false
                )
            }
            lastError = nil
            updatedAt = Date()
            fetchedAt = raw.compactMap { parseDate($0["fetchedAt"]) }.max()
        } catch {
            lastError = error.localizedDescription
        }
    }
}

enum Prefs {
    private static let defaults = UserDefaults.standard

    static var refreshInterval: TimeInterval {
        get {
            let stored = defaults.double(forKey: "refreshSeconds")
            return stored >= 300 ? stored : 300
        }
        set { defaults.set(newValue, forKey: "refreshSeconds") }
    }

    /// "active" | "mostUsed" | "mostHeadroom"
    static var titleAccount: String {
        get { defaults.string(forKey: "titleAccount") ?? "active" }
        set { defaults.set(newValue, forKey: "titleAccount") }
    }

    /// Which providers the menu bar title covers: "both" | "claude" | "codex".
    static var titleProviders: String {
        get { defaults.string(forKey: "titleProviders") ?? "both" }
        set { defaults.set(newValue, forKey: "titleProviders") }
    }

    static var warnPercent: Double {
        get {
            let stored = defaults.double(forKey: "warnPercent")
            return stored > 0 ? stored : 60
        }
        set { defaults.set(newValue, forKey: "warnPercent") }
    }

    static var criticalPercent: Double {
        get {
            let stored = defaults.double(forKey: "criticalPercent")
            return stored > 0 ? stored : 80
        }
        set { defaults.set(newValue, forKey: "criticalPercent") }
    }

    static var launchAtLogin: Bool {
        get { defaults.bool(forKey: "launchAtLogin") }
        set { defaults.set(newValue, forKey: "launchAtLogin") }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let store = UsageStore()
    private var timer: Timer?
    private var isRefreshing = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem.button?.title = "Usage …"
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        refresh()
        rescheduleTimer()
    }

    private func rescheduleTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: Prefs.refreshInterval, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        // Draw what we already have so the menu opens instantly, then re-run the CLI
        // if that was a while ago. This never costs a network request on its own: the
        // CLI sends at most one per account every five minutes, machine-wide, and
        // answers from its cache otherwise.
        rebuild(menu)
        let age = store.updatedAt.map { Date().timeIntervalSince($0) } ?? .greatestFiniteMagnitude
        if age > 60 { refresh() }
    }

    private func refresh() {
        if isRefreshing { return }
        isRefreshing = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            self.store.reload()
            DispatchQueue.main.async {
                self.isRefreshing = false
                self.updateTitle()
                if let menu = self.statusItem.menu { self.rebuild(menu) }
            }
        }
    }

    /// Mirrors severityFor() in src/core.mjs: green under 60, yellow to 80, red above.
    private func color(for percent: Double) -> NSColor {
        if percent >= Prefs.criticalPercent { return .systemRed }
        if percent >= Prefs.warnPercent { return .systemYellow }
        return .systemGreen
    }

    /// The providers with at least one tracked account, Claude first.
    private var providersPresent: [Provider] {
        Provider.allCases.filter { p in store.accounts.contains { $0.provider == p } }
    }

    /// The providers the title covers, per the setting, narrowed to those present.
    private var titleProviders: [Provider] {
        let present = providersPresent
        switch Prefs.titleProviders {
        case "claude": return present.filter { $0 == .claude }
        case "codex": return present.filter { $0 == .codex }
        default: return present
        }
    }

    /// The account the title shows for one provider, per the "Menu Bar Shows" setting.
    private func headline(for provider: Provider) -> Account? {
        let usable = store.accounts.filter { $0.provider == provider && $0.error == nil }
        switch Prefs.titleAccount {
        case "mostUsed":
            return usable.max { $0.worst < $1.worst }
        case "mostHeadroom":
            return usable.min { $0.worst < $1.worst }
        default:
            return usable.first(where: \.active) ?? usable.min { $0.worst < $1.worst }
        }
    }

    private func updateTitle() {
        guard let button = statusItem.button else { return }
        if store.lastError != nil && store.accounts.isEmpty {
            button.attributedTitle = NSAttributedString(
                string: "Usage ⚠",
                attributes: [.foregroundColor: NSColor.systemRed]
            )
            return
        }
        let providers = titleProviders.isEmpty ? providersPresent : titleProviders
        let usable = store.accounts.filter { $0.error == nil }
        let needsAttention = store.accounts.contains(where: \.needsLogin)
        let worstAll = usable.map(\.worst).max() ?? 0
        let font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        let title = NSMutableAttributedString()
        for provider in providers {
            guard let account = headline(for: provider) else { continue }
            if title.length > 0 { title.append(NSAttributedString(string: "   ", attributes: [.font: font])) }
            // Each provider is introduced by its glyph, in its colour; the label is only
            // spelled out when that provider has more than one account to tell apart.
            title.append(NSAttributedString(string: provider.glyph, attributes: [.font: font, .foregroundColor: provider.color]))
            let several = store.accounts.filter { $0.provider == provider }.count > 1
            // Every window in order: session, weekly all, per-model weekly.
            let percents = account.windows.map { "\(Int(($0.percent ?? 0).rounded()))%" }.joined(separator: " ")
            let text = "\(several ? " \(account.label)" : "") \(percents.isEmpty ? "–" : percents)"
            title.append(NSAttributedString(
                string: text,
                attributes: [
                    .font: font,
                    .foregroundColor: max(worstAll, account.worst) >= Prefs.criticalPercent ? NSColor.systemRed : NSColor.labelColor,
                ]
            ))
        }
        if title.length == 0 {
            button.title = "Usage –"
            return
        }
        if needsAttention { title.append(NSAttributedString(string: " ⚠", attributes: [.font: font, .foregroundColor: NSColor.systemRed])) }
        button.attributedTitle = title
    }

    private func meter(_ percent: Double?, width: Int = 14) -> String {
        guard let percent else { return String(repeating: "·", count: width) }
        let filled = min(width, max(0, Int((percent / 100 * Double(width)).rounded())))
        return String(repeating: "█", count: filled) + String(repeating: "▁", count: width - filled)
    }

    /// A non-interactive row. AppKit dims any item without an action, and an item
    /// with one highlights on hover as if it were a button — neither is right for a
    /// readout, so draw the text in the item's own view instead.
    private func textItem(_ attributed: NSAttributedString, indent: Int = 0) -> NSMenuItem {
        let item = NSMenuItem()
        item.isEnabled = false
        let label = NSTextField(labelWithAttributedString: attributed)
        label.translatesAutoresizingMaskIntoConstraints = false
        label.lineBreakMode = .byClipping
        let leading: CGFloat = 14 + CGFloat(indent) * 18
        let container = NSView(frame: NSRect(x: 0, y: 0, width: label.intrinsicContentSize.width + leading + 18, height: 20))
        container.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: leading),
            label.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            label.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -12),
        ])
        item.view = container
        return item
    }

    private func rebuild(_ menu: NSMenu) {
        menu.removeAllItems()

        if let error = store.lastError, store.accounts.isEmpty {
            menu.addItem(textItem(NSAttributedString(
                string: error,
                attributes: [.foregroundColor: NSColor.systemRed, .font: NSFont.systemFont(ofSize: 12)]
            )))
            menu.addItem(.separator())
        }

        for provider in providersPresent {
            // One block per provider, headed by its glyph and name in its colour.
            let heading = NSMutableAttributedString(
                string: "\(provider.glyph) \(provider.name)",
                attributes: [
                    .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
                    .foregroundColor: provider.color,
                ]
            )
            if let tier = store.accounts.first(where: { $0.provider == provider && $0.tier != nil })?.tier,
               store.accounts.filter({ $0.provider == provider }).count == 1 {
                heading.append(NSAttributedString(
                    string: "   \(tier)",
                    attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.tertiaryLabelColor]
                ))
            }
            menu.addItem(textItem(heading))
            for account in store.accounts where account.provider == provider {
                addAccount(account, to: menu)
            }
            menu.addItem(.separator())
        }

        if let updated = store.fetchedAt ?? store.updatedAt {
            menu.addItem(textItem(NSAttributedString(
                string: "Updated \(Format.clock(updated))",
                attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.tertiaryLabelColor]
            )))
        }

        let refreshItem = NSMenuItem(title: "Refresh Now", action: #selector(refreshNow), keyEquivalent: "r")
        refreshItem.target = self
        menu.addItem(refreshItem)

        menu.addItem(addMenuItem())
        menu.addItem(manageMenuItem())
        menu.addItem(settingsMenuItem())

        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
    }

    private func addAccount(_ account: Account, to menu: NSMenu) {
        let provider = account.provider
        let dot = account.active ? "●" : "○"
        let header = NSMutableAttributedString(
            string: "\(dot) \(account.label)   ",
            attributes: [
                .font: NSFont.systemFont(ofSize: 13, weight: .bold),
                .foregroundColor: account.active ? NSColor.systemGreen : NSColor.labelColor,
            ]
        )
        header.append(NSAttributedString(
            string: account.email,
            attributes: [
                .font: NSFont.systemFont(ofSize: 11),
                .foregroundColor: NSColor.tertiaryLabelColor,
            ]
        ))
        if let tier = account.tier, store.accounts.filter({ $0.provider == provider }).count > 1 {
            header.append(NSAttributedString(
                string: "   \(tier)",
                attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.tertiaryLabelColor]
            ))
        }
        menu.addItem(textItem(header, indent: 1))

        if let error = account.error {
            if account.needsLogin {
                let item = NSMenuItem(title: "Sign in again", action: #selector(signIn(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = account
                item.indentationLevel = 2
                item.attributedTitle = NSAttributedString(
                    string: "⚠  Sign in again",
                    attributes: [.foregroundColor: NSColor.systemRed, .font: NSFont.systemFont(ofSize: 12, weight: .semibold)]
                )
                menu.addItem(item)
            }
            menu.addItem(textItem(
                NSAttributedString(
                    string: error,
                    attributes: [
                        .font: NSFont.systemFont(ofSize: 11),
                        .foregroundColor: NSColor.systemOrange,
                    ]
                ),
                indent: 2
            ))
            return
        }

        if let stale = account.stale {
            menu.addItem(textItem(
                NSAttributedString(
                    string: "⟳  \(stale)",
                    attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.systemOrange]
                ),
                indent: 2
            ))
        }
        let labelWidth = max(10, account.windows.map(\.label.count).max() ?? 10)
        for window in account.windows {
            let percent = window.percent ?? 0
            let tint = window.severity == "locked" ? NSColor.systemRed : color(for: percent)
            let line = NSMutableAttributedString(
                string: meter(window.percent) + "  ",
                attributes: [
                    .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .bold),
                    .foregroundColor: tint,
                ]
            )
            line.append(NSAttributedString(
                string: String(format: "%3d%%  ", Int(percent.rounded())),
                attributes: [
                    .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .bold),
                    .foregroundColor: tint,
                ]
            ))
            line.append(NSAttributedString(
                string: window.label.padding(toLength: labelWidth, withPad: " ", startingAt: 0),
                attributes: [
                    .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .medium),
                    .foregroundColor: NSColor.labelColor,
                ]
            ))
            if let reset = window.resetsAt {
                line.append(NSAttributedString(
                    string: "   resets in \(Format.relative(reset.timeIntervalSinceNow))  (\(Format.clock(reset)))",
                    attributes: [
                        .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
                        .foregroundColor: NSColor.secondaryLabelColor,
                    ]
                ))
            }
            if window.severity == "locked" {
                line.append(NSAttributedString(
                    string: "  locked",
                    attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11, weight: .bold), .foregroundColor: NSColor.systemRed]
                ))
            }
            menu.addItem(textItem(line, indent: 2))
        }
        menu.addItem(textItem(
            NSAttributedString(
                string: account.loginMessage,
                attributes: [
                    .font: NSFont.systemFont(ofSize: 11),
                    .foregroundColor: account.loginState == "expiring" ? NSColor.systemOrange : NSColor.tertiaryLabelColor,
                ]
            ),
            indent: 2
        ))

        if account.readOnly {
            menu.addItem(textItem(
                NSAttributedString(
                    string: "Read-only login — sign in again for full access to switch to it",
                    attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.systemOrange]
                ),
                indent: 2
            ))
        } else if !account.active {
            let use = NSMenuItem(title: "Switch \(provider.client) to this account…", action: #selector(switchTo(_:)), keyEquivalent: "")
            use.target = self
            use.representedObject = account
            use.indentationLevel = 2
            menu.addItem(use)
        }
    }

    /// "Add Account" — a browser sign-in or a capture of the running CLI's login, per provider.
    private func addMenuItem() -> NSMenuItem {
        let parent = NSMenuItem(title: "Add Account", action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        for provider in Provider.allCases {
            let login = NSMenuItem(title: "\(provider.glyph) \(provider.name) — Browser Sign-in…", action: #selector(addAccount(_:)), keyEquivalent: provider == .claude ? "n" : "")
            login.target = self
            login.representedObject = provider.rawValue
            submenu.addItem(login)
            let capture = NSMenuItem(title: "\(provider.glyph) \(provider.name) — Capture \(provider.client)'s Account", action: #selector(captureAccount(_:)), keyEquivalent: "")
            capture.target = self
            capture.representedObject = provider.rawValue
            submenu.addItem(capture)
            if provider != Provider.allCases.last { submenu.addItem(.separator()) }
        }
        parent.submenu = submenu
        return parent
    }

    private func manageMenuItem() -> NSMenuItem {
        let parent = NSMenuItem(title: "Remove Account", action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        if store.accounts.isEmpty {
            let none = NSMenuItem(title: "No accounts", action: nil, keyEquivalent: "")
            none.isEnabled = false
            submenu.addItem(none)
        }
        for account in store.accounts {
            let item = NSMenuItem(title: "\(account.provider.glyph) \(account.label) — \(account.email)", action: #selector(removeAccount(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = account
            submenu.addItem(item)
        }
        parent.submenu = submenu
        return parent
    }

    private func settingsMenuItem() -> NSMenuItem {
        let parent = NSMenuItem(title: "Settings", action: nil, keyEquivalent: "")
        let submenu = NSMenu()

        let intervalParent = NSMenuItem(title: "Refresh Every", action: nil, keyEquivalent: "")
        let intervalMenu = NSMenu()
        for minutes in [5, 10, 15, 30] {
            let item = NSMenuItem(title: "\(minutes) min", action: #selector(setInterval(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = minutes
            item.state = Int(Prefs.refreshInterval / 60) == minutes ? .on : .off
            intervalMenu.addItem(item)
        }
        intervalParent.submenu = intervalMenu
        submenu.addItem(intervalParent)

        let titleParent = NSMenuItem(title: "Menu Bar Shows", action: nil, keyEquivalent: "")
        let titleMenu = NSMenu()
        for (key, label) in [("active", "Active account"), ("mostUsed", "Busiest account"), ("mostHeadroom", "Freest account")] {
            let item = NSMenuItem(title: label, action: #selector(setTitleAccount(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = key
            item.state = Prefs.titleAccount == key ? .on : .off
            titleMenu.addItem(item)
        }
        titleParent.submenu = titleMenu
        submenu.addItem(titleParent)

        let coverParent = NSMenuItem(title: "Menu Bar Covers", action: nil, keyEquivalent: "")
        let coverMenu = NSMenu()
        for (key, label) in [("both", "Claude and Codex"), ("claude", "Claude only"), ("codex", "Codex only")] {
            let item = NSMenuItem(title: label, action: #selector(setTitleProviders(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = key
            item.state = Prefs.titleProviders == key ? .on : .off
            coverMenu.addItem(item)
        }
        coverParent.submenu = coverMenu
        submenu.addItem(coverParent)

        let warnParent = NSMenuItem(title: "Warn Above", action: nil, keyEquivalent: "")
        let warnMenu = NSMenu()
        for percent in [40, 50, 60, 70] {
            let item = NSMenuItem(title: "\(percent)%", action: #selector(setWarnPercent(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = percent
            item.state = Int(Prefs.warnPercent) == percent ? .on : .off
            warnMenu.addItem(item)
        }
        warnParent.submenu = warnMenu
        submenu.addItem(warnParent)

        parent.submenu = submenu
        return parent
    }

    @objc private func refreshNow() {
        refresh()
    }

    @objc private func switchTo(_ sender: NSMenuItem) {
        guard let account = sender.representedObject as? Account else { return }
        let provider = account.provider
        let cli = provider == .claude ? "claude" : "codex"
        let alert = NSAlert()
        alert.messageText = "Point \(provider.client) at \(account.label)?"
        alert.informativeText = "This rewrites the login \(provider.client) has stored.\n\nSessions that are already running keep the account they started with — quit and start `\(cli)` again to use \(account.label)."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Switch")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        runInBackground(["switch", provider.target(account.label)], successMessage: "\(provider.client) now uses \(account.label). Start a new `\(cli)` session to pick it up.")
    }

    @objc private func signIn(_ sender: NSMenuItem) {
        guard let account = sender.representedObject as? Account else { return }
        // The browser flow can take a while: the CLI itself waits up to five minutes.
        runInBackground(["login", "--label", account.label] + account.provider.flag, successMessage: "\(account.label) signed in.", timeout: 320)
    }

    @objc private func addAccount(_ sender: NSMenuItem) {
        let provider = Provider(rawValue: sender.representedObject as? String ?? "claude") ?? .claude
        runInBackground(["login"] + provider.flag, successMessage: "\(provider.name) account added.", timeout: 320)
    }

    @objc private func captureAccount(_ sender: NSMenuItem) {
        let provider = Provider(rawValue: sender.representedObject as? String ?? "claude") ?? .claude
        runInBackground(["add"] + provider.flag, successMessage: "Captured the account \(provider.client) is signed in as.")
    }

    @objc private func removeAccount(_ sender: NSMenuItem) {
        guard let account = sender.representedObject as? Account else { return }
        let alert = NSAlert()
        alert.messageText = "Stop tracking \(account.provider.name) account \(account.label)?"
        alert.informativeText = "Its stored tokens are deleted from this Mac. \(account.provider.client) itself is not affected."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Remove")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        runInBackground(["remove", account.provider.target(account.label)], successMessage: "Removed \(account.label).")
    }

    @objc private func setInterval(_ sender: NSMenuItem) {
        guard let minutes = sender.representedObject as? Int else { return }
        Prefs.refreshInterval = TimeInterval(minutes * 60)
        rescheduleTimer()
    }

    @objc private func setTitleAccount(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        Prefs.titleAccount = key
        updateTitle()
    }

    @objc private func setTitleProviders(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        Prefs.titleProviders = key
        updateTitle()
    }

    @objc private func setWarnPercent(_ sender: NSMenuItem) {
        guard let percent = sender.representedObject as? Int else { return }
        Prefs.warnPercent = Double(percent)
        updateTitle()
    }

    private func runInBackground(_ arguments: [String], successMessage: String, timeout: TimeInterval = 60) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var failure: String?
            do {
                try CLI.run(arguments, timeout: timeout)
            } catch {
                failure = error.localizedDescription
            }
            DispatchQueue.main.async {
                let alert = NSAlert()
                alert.messageText = failure == nil ? "Usage Bar" : "Usage Bar failed"
                alert.informativeText = failure ?? successMessage
                alert.alertStyle = failure == nil ? .informational : .warning
                NSApp.activate(ignoringOtherApps: true)
                alert.runModal()
                self?.refresh()
            }
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()

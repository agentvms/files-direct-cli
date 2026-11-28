// Files Direct: the menu-bar program of the Mac app (files-direct-34).
// It shows a menu and starts the program's own engine (files-direct.mjs, run by the Node that is inside this app). It holds no transfer rule and no update rule:
// every file the person chooses is handed to the engine as a separate argument, after "--", and never pasted into a command line.
// Since files-direct-60 it also shows the engine's page in a window of its own (WKWebView): the engine serves the page on 127.0.0.1 and prints its address, and this program opens that
// address and nothing else. No second copy of the page, nothing else listening.
import AppKit
import Foundation
import WebKit

let resources = Bundle.main.resourcePath ?? ""
let nodePath = resources + "/node"
let enginePath = resources + "/files-direct.mjs"
let versionText = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0"

struct Outcome {
    let status: Int32
    let output: String
}

/// Runs the engine and waits for it. Output and errors are collected.
func runEngine(_ args: [String]) -> Outcome {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: nodePath)
    p.arguments = [enginePath] + args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    p.standardInput = FileHandle.nullDevice
    do { try p.run() } catch { return Outcome(status: 127, output: "\(error)") }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return Outcome(status: p.terminationStatus, output: String(data: data, encoding: .utf8) ?? "")
}

/// Reads a pipe line by line, whatever the chunks it arrives in. Each line goes to `onLine` on the main queue.
func readLines(_ pipe: Pipe, _ onLine: @escaping (String) -> Void) {
    let pending = LineBuffer()
    pipe.fileHandleForReading.readabilityHandler = { handle in
        let chunk = handle.availableData
        if chunk.isEmpty {
            handle.readabilityHandler = nil
            return
        }
        for text in pending.take(chunk) { DispatchQueue.main.async { onLine(text) } }
    }
}

/// What has been read of a pipe and is not a whole line yet. A class, so the handler that reads the pipe changes it without capturing a variable.
final class LineBuffer {
    private var data = Data()

    /// Adds what was read and gives back the lines that are whole now.
    func take(_ chunk: Data) -> [String] {
        data.append(chunk)
        var lines: [String] = []
        while let newline = data.firstIndex(of: 10) {
            let line = data.subdata(in: data.startIndex..<newline)
            data.removeSubrange(data.startIndex...newline)
            if let text = String(data: line, encoding: .utf8) { lines.append(text) }
        }
        return lines
    }
}

/// One run of the engine whose page this program shows in a window. The engine prints `{"event":"window","url":...}` when its page is ready and `{"event":"closed",...}` when the person's
/// meeting is over; it prints nothing else and is given no input.
final class Run {
    let process = Process()
    /// The window that shows this run's page, once there is one.
    var window: AppWindow?

    /// Starts the engine with these fixed words (and the person's files after "--"). False when it could not be started.
    func start(_ args: [String], onLine: @escaping ([String: Any]) -> Void, onExit: @escaping () -> Void) -> Bool {
        let out = Pipe()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [enginePath] + args
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        readLines(out) { line in
            if let d = line.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { onLine(o) }
        }
        process.terminationHandler = { _ in DispatchQueue.main.async { onExit() } }
        do { try process.run() } catch { return false }
        return true
    }

    /// The window was closed and the page was told to close (which ends the engine's run): if the engine is still there three seconds later, it is told to stop.
    func stopSoon() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { if self.process.isRunning { self.process.terminate() } }
    }

    func stop() {
        if process.isRunning { process.terminate() }
    }
}

/// The Files Direct window (files-direct-60): a window of this app with a web view that shows one address, the one the engine printed, and nothing the page links to. The web view keeps
/// nothing (a data store that lives in memory only), like the thrown-away browser profile of the window before it.
final class AppWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    let url: URL
    let window: NSWindow
    let web: WKWebView
    /// The window is over (the page ended it, or the person closed it and the page was told).
    var finished = false
    var closing = false
    /// The person closed the window: what runs behind it is told to end.
    var onClose: (() -> Void)?
    /// The window has gone.
    var onGone: (() -> Void)?

    init(url: URL) {
        self.url = url
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore.nonPersistent()
        web = WKWebView(frame: .zero, configuration: config)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 760), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = "Files Direct"
        window.isReleasedWhenClosed = false
        window.contentView = web
        window.delegate = self
        web.navigationDelegate = self
        web.uiDelegate = self
        window.center()
    }

    /// Opens the window on the address it was made for. While a window is open the app has a Dock icon (and a menu with Edit, for copy and paste); when the last one closes it goes back to the menu bar only.
    func show() {
        NSApp.setActivationPolicy(.regular)
        web.load(URLRequest(url: url))
        bringForward()
    }

    func bringForward() {
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(web)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// The only addresses the window itself shows: the page's own address and what is below it. The check is on the whole text, so another port, another host or another word cannot pass.
    func isInside(_ target: URL) -> Bool {
        return target.absoluteString.hasPrefix(url.absoluteString)
    }

    /// Anything else the page links to (a page of the site, a report) goes to the person's own browser. Only web addresses: nothing else is opened from here.
    func openOutside(_ target: URL) {
        if target.scheme == "https" || target.scheme == "http" { NSWorkspace.shared.open(target) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let target = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if navigationAction.targetFrame != nil && isInside(target) {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        openOutside(target)
    }

    /// A link that asks for a window of its own (target=_blank, window.open): never a second window of ours; the person's browser opens it.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let target = navigationAction.request.url { openOutside(target) }
        return nil
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if finished { return true }
        askToClose()
        return false
    }

    /// The person closed the window: the page's own Close is pressed (what its Close button does), which cancels what is running and ends the engine's run, and then the window closes. If the page does not
    /// answer within two seconds, the window closes anyway and the engine's own watch on the page ends the run.
    func askToClose() {
        if closing { return }
        closing = true
        web.callAsyncJavaScript("await fetch('act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ do: 'close' }) }); return true", arguments: [:], in: nil, in: .page) { _ in DispatchQueue.main.async { self.finishByPerson() } }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.finishByPerson() }
    }

    /// The page has been told (or did not answer in time): the run behind the window is told to end, and the window goes. Once.
    func finishByPerson() {
        if finished { return }
        finished = true
        onClose?()
        window.close()
    }

    /// The engine says the meeting is over (the page's Close was pressed, or the engine ended): the window closes with it.
    func endedByEngine() {
        if finished { return }
        finished = true
        window.close()
    }

    func windowWillClose(_ notification: Notification) {
        web.navigationDelegate = nil
        web.uiDelegate = nil
        onGone?()
    }
}

/// The last line of the engine's output that is a JSON object.
func lastJSON(_ text: String) -> [String: Any]? {
    for line in text.split(separator: "\n").reversed() {
        if let d = line.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { return o }
    }
    return nil
}

@discardableResult
func alert(_ title: String, _ info: String, _ buttons: [String] = ["OK"]) -> Int {
    NSApp.activate(ignoringOtherApps: true)
    let a = NSAlert()
    a.messageText = title
    a.informativeText = info
    for b in buttons { a.addButton(withTitle: b) }
    let r = a.runModal()
    return r.rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
}

/// For an app that macOS runs from a temporary copy of a download (App Translocation): where the person's own copy really is. The system is asked the way other Mac apps ask it (there is
/// no public header for the call), and nil comes back when it is not known; the engine then copies from the temporary copy and leaves the person's file where it is.
func originalPathIfTranslocated() -> String? {
    if !Bundle.main.bundlePath.contains("/AppTranslocation/") { return nil }
    guard let handle = dlopen("/System/Library/Frameworks/Security.framework/Security", RTLD_LAZY) else { return nil }
    defer { dlclose(handle) }
    guard let symbol = dlsym(handle, "SecTranslocateCreateOriginalPathForURL") else { return nil }
    typealias CreateOriginal = @convention(c) (CFURL, UnsafeMutablePointer<Unmanaged<CFError>?>?) -> Unmanaged<CFURL>?
    let create = unsafeBitCast(symbol, to: CreateOriginal.self)
    var error: Unmanaged<CFError>? = nil
    let here = unsafeBitCast(Bundle.main.bundleURL as NSURL, to: CFURL.self)
    guard let result = create(here, &error) else { return nil }
    let original = unsafeBitCast(result.takeRetainedValue(), to: NSURL.self)
    return original.path
}

final class Delegate: NSObject, NSApplicationDelegate {
    var item: NSStatusItem?
    /// The engine's listener (files-direct-40): it holds the connection to every device this computer remembers while the app runs, and prints the address of a page when one asks to send. It ends by itself
    /// within seconds of this program going away.
    var listener: Run?
    /// The engine run of the menu's Send, Ask and Receive (and of the right-click entry) while its window is open or still opening: a second choice brings this window forward and starts no second run.
    var userRun: Run?
    /// The windows that are open, by the address of their page.
    var windows: [String: AppWindow] = [:]
    /// Files chosen in Finder before the app was ready to show a window (the app was started by the right-click entry): they are handed on once it is.
    var waiting: [String] = []
    var ready = false
    /// The menu's own way to do the move, shown (by the engine's say-so) while the app runs from a place it should not stay in.
    let moveItem = NSMenuItem(title: "Move to Applications", action: nil, keyEquivalent: "")
    var original: [String] = []

    func applicationWillTerminate(_ note: Notification) {
        listener?.stop()
        userRun?.stop()
    }

    /// Closing the last window leaves the menu-bar program (and the listener) running.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    /// The right-click entry in Finder (the Quick Action) hands the chosen files and folders to this app, which shows them in its own window. Each one is its own argument to the engine after "--".
    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        if ready { openFromMenu(["--"] + filenames) } else { waiting += filenames }
        sender.reply(toOpenOrPrint: .success)
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        // one menu-bar program at a time
        let mine = Bundle.main.bundleIdentifier ?? ""
        if NSRunningApplication.runningApplications(withBundleIdentifier: mine).count > 1 {
            NSApp.terminate(nil)
            return
        }
        installMainMenu()
        let bar = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = bar.button {
            if let image = NSImage(systemSymbolName: "square.and.arrow.up", accessibilityDescription: "Files Direct") {
                image.isTemplate = true
                button.image = image
            } else {
                button.title = "Files Direct"
            }
        }
        let menu = NSMenu()
        let head = NSMenuItem(title: "Files Direct " + versionText, action: nil, keyEquivalent: "")
        head.isEnabled = false
        menu.addItem(head)
        moveItem.target = self
        moveItem.action = #selector(moveFromMenu)
        moveItem.isHidden = true
        menu.addItem(moveItem)
        menu.addItem(NSMenuItem.separator())
        add(menu, "Send…", #selector(send))
        add(menu, "Ask for files", #selector(openWindow))
        add(menu, "Receive by link or code", #selector(openWindow))
        menu.addItem(NSMenuItem.separator())
        add(menu, "Check for updates…", #selector(checkForUpdates))
        add(menu, "Remove Files Direct…", #selector(removeApp))
        menu.addItem(NSMenuItem.separator())
        add(menu, "Quit Files Direct", #selector(quit))
        bar.menu = menu
        item = bar
        // a check on a build machine runs the app with no one to answer a question
        if CommandLine.arguments.contains("--update-now") {
            start()
        } else {
            offerToMove { self.start() }
        }
    }

    /// What the app does once it knows it is staying where it is.
    func start() {
        installEntry()
        startListener()
        ready = true
        if !waiting.isEmpty {
            let files = waiting
            waiting = []
            openFromMenu(["--"] + files)
        }
        if CommandLine.arguments.contains("--update-now") { updateNow() }
    }

    /// The menu this app shows while a window is open. The page needs Edit (paste a link or a code, copy a link) and the person expects Close and Quit: a web view has no keyboard shortcuts of its own.
    func installMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "Hide Files Direct", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let quitItem = NSMenuItem(title: "Quit Files Direct", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        appMenu.addItem(quitItem)
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        editItem.submenu = edit
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(NSMenuItem.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let windowMenu = NSMenu(title: "Window")
        windowItem.submenu = windowMenu
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        NSApp.mainMenu = main
    }

    /// Starts the engine's listener. A device that asks to send comes back as the address of a page, which is shown in a window of its own.
    func startListener() {
        let run = Run()
        let started = run.start(["listen", "--app", "--shell-window"], onLine: { line in self.heard(line, run: nil) }, onExit: {})
        if started { listener = run }
    }

    /// What an engine says. A page that is ready is shown; a meeting that is over closes its window.
    func heard(_ line: [String: Any], run: Run?) {
        guard let address = line["url"] as? String else { return }
        switch line["event"] as? String {
        case "window": showWindow(address, run: run)
        case "closed": windows[address]?.endedByEngine()
        default: break
        }
    }

    /// Shows the engine's page in a window. Only an address on this computer's own loopback, under /w/, is ever shown: anything else the engine might print is ignored.
    func showWindow(_ address: String, run: Run?) {
        guard windows[address] == nil, let page = URL(string: address), page.scheme == "http", page.host == "127.0.0.1", page.path.hasPrefix("/w/") else { return }
        let w = AppWindow(url: page)
        windows[address] = w
        run?.window = w
        w.onClose = { run?.stopSoon() }
        w.onGone = { [weak self] in
            self?.windows[address] = nil
            run?.window = nil
            if self?.windows.isEmpty == true { NSApp.setActivationPolicy(.accessory) }
        }
        w.show()
    }

    /// A window is open (or opening): it is brought forward and true is returned, so no file picker is shown and nothing new is started.
    func focusOpenWindow() -> Bool {
        guard let current = userRun else { return false }
        if let w = current.window { w.bringForward() } else { NSApp.activate(ignoringOtherApps: true) }
        return true
    }

    /// Send, Ask and Receive, from the menu or from Finder: one window at a time. With a window open (or opening), that window is brought forward and no second run is started.
    func openFromMenu(_ args: [String]) {
        if focusOpenWindow() { return }
        let run = Run()
        userRun = run
        let started = run.start(["open", "--app", "--shell-window"] + args, onLine: { line in self.heard(line, run: run) }, onExit: {
            run.window?.endedByEngine()
            if self.userRun === run { self.userRun = nil }
        })
        if !started { userRun = nil }
    }

    /// Opened from a disk image, from Downloads or from a temporary copy of a download: asks the engine (the rules are in its place.ts) whether to offer to move to Applications, and does what the person
    /// answers. "Move to Applications" copies the app, quits, and the engine's script opens the copy and ejects the disk image; "Not now" is remembered for this place, so it is asked once.
    /// `proceed` runs when the app stays here.
    func offerToMove(_ proceed: @escaping () -> Void) {
        let original = originalPathIfTranslocated()
        let extra: [String] = original.map { ["--original", $0] } ?? []
        self.original = extra
        DispatchQueue.global().async {
            let r = runEngine(["app", "place", "--json"] + extra)
            let j = lastJSON(r.output)
            DispatchQueue.main.async {
                if let title = j?["menuItem"] as? String {
                    self.moveItem.title = title
                    self.moveItem.isHidden = false
                }
                guard r.status == 0, (j?["ask"] as? Bool) == true, let target = j?["target"] as? String else {
                    proceed()
                    return
                }
                let folder = target.hasPrefix("/Applications/") ? "your Applications folder" : "the Applications folder in your own folder"
                var text = "Files Direct stays in " + folder + " and opens again from there. That is where updates can be installed."
                if j?["eject"] != nil { text += " The disk image is ejected." }
                if alert("Move Files Direct to Applications?", text, ["Move to Applications", "Not now"]) == 0 {
                    self.move(extra, proceed)
                } else {
                    DispatchQueue.global().async { _ = runEngine(["app", "decline", "--json"] + extra) }
                    proceed()
                }
            }
        }
    }

    @objc func moveFromMenu() {
        move(original) {}
    }

    func move(_ extra: [String], _ proceed: @escaping () -> Void) {
        let pid = String(ProcessInfo.processInfo.processIdentifier)
        DispatchQueue.global().async {
            let r = runEngine(["app", "move", "--json", "--wait-for", pid] + extra)
            let j = lastJSON(r.output)
            DispatchQueue.main.async {
                if r.status == 0 {
                    NSApp.terminate(nil)
                } else {
                    alert("Files Direct was not moved", (j?["message"] as? String) ?? "Something went wrong. Nothing was changed, and Files Direct keeps running here.")
                    proceed()
                }
            }
        }
    }

    func add(_ menu: NSMenu, _ title: String, _ action: Selector) {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: "")
        i.target = self
        menu.addItem(i)
    }

    /// The right-click entry (the Finder Quick Action) is written, or written again, each time the app starts: it points at this app's own Node and engine.
    func installEntry() {
        // an app run straight from a download or a disk image is not where it will stay: the entry would point at a place that goes away
        let here = Bundle.main.bundlePath
        // (no alert: the menu says so all the time, with an item that moves the app; a relaunch from Applications comes through here and writes the entry)
        if here.contains("/AppTranslocation/") || here.hasPrefix("/Volumes/") { return }
        DispatchQueue.global().async { _ = runEngine(["menu", "install", "--app"]) }
    }

    @objc func send() {
        if focusOpenWindow() { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.prompt = "Send"
        panel.message = "Choose the files or folders to send"
        NSApp.activate(ignoringOtherApps: true)
        if panel.runModal() == .OK {
            openFromMenu(["--"] + panel.urls.map { $0.path })
        }
    }

    @objc func openWindow() {
        openFromMenu([])
    }

    @objc func checkForUpdates() {
        DispatchQueue.global().async {
            let r = runEngine(["update", "check", "--json"])
            let j = lastJSON(r.output)
            DispatchQueue.main.async {
                let state = j?["state"] as? String
                if state == "available", let v = j?["version"] as? String {
                    if alert("Files Direct " + v + " is ready", "Install it now? Files Direct closes and opens again.", ["Install", "Not now"]) == 0 { self.install() }
                } else if state == "current" {
                    alert("Files Direct is up to date", "You have the newest version (" + versionText + ").")
                } else {
                    alert("No update", (j?["message"] as? String) ?? "Files Direct could not look for an update.")
                }
            }
        }
    }

    func install() {
        let pid = String(ProcessInfo.processInfo.processIdentifier)
        DispatchQueue.global().async {
            let r = runEngine(["update", "install", "--json", "--wait-for", pid])
            let j = lastJSON(r.output)
            DispatchQueue.main.async {
                if r.status == 0 {
                    NSApp.terminate(nil)
                } else {
                    alert("The update was not installed", (j?["message"] as? String) ?? "Something went wrong. Nothing was changed.")
                }
            }
        }
    }

    /// For a script or a check on a build machine: look for an update and install it, with no questions.
    func updateNow() {
        DispatchQueue.global().async {
            let pid = String(ProcessInfo.processInfo.processIdentifier)
            let r = runEngine(["update", "install", "--json", "--wait-for", pid])
            DispatchQueue.main.async {
                if r.status == 0, let j = lastJSON(r.output), (j["state"] as? String) == "restarting" { NSApp.terminate(nil) }
            }
        }
    }

    @objc func removeApp() {
        let choice = alert("Remove Files Direct?", "This takes \"Send with Files Direct\" out of Finder, deletes what Files Direct made in your Library folder, and moves this app to the Trash. Files you sent or received stay where they are.", ["Remove", "Cancel"])
        if choice != 0 { return }
        DispatchQueue.global().async {
            _ = runEngine(["app", "remove"])
            DispatchQueue.main.async {
                do {
                    try FileManager.default.trashItem(at: Bundle.main.bundleURL, resultingItemURL: nil)
                    alert("Files Direct is removed", "Its menu entry and its folders are gone, and the app is in the Trash.")
                } catch {
                    alert("Almost done", "The menu entry and the folders are gone. To finish, drag Files Direct from " + Bundle.main.bundlePath + " to the Trash.")
                }
                NSApp.terminate(nil)
            }
        }
    }

    @objc func quit() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()

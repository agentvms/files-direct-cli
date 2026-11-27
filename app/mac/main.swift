// Files Direct: the menu-bar program of the Mac app (files-direct-34).
// It shows a menu and starts the program's own engine (files-direct.mjs, run by the Node that is inside this app). It holds no transfer rule and no update rule:
// every file the person chooses is handed to the engine as a separate argument, after "--", and never pasted into a command line.
import AppKit
import Foundation

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

/// Starts the engine and does not wait (the Files Direct window it opens ends the run).
func startEngine(_ args: [String]) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: nodePath)
    p.arguments = [enginePath] + args
    p.standardInput = FileHandle.nullDevice
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try? p.run()
}

/// Starts the engine's listener (files-direct-40) and gives it back, so the app can end it when it quits. It holds the connection to every device this computer remembers while the app runs,
/// and opens the Files Direct window when one asks to send. It also ends by itself within seconds of this program going away.
func startListener() -> Process? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: nodePath)
    p.arguments = [enginePath, "listen", "--app"]
    p.standardInput = FileHandle.nullDevice
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return nil }
    return p
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
    var listener: Process?
    /// The menu's own way to do the move, shown (by the engine's say-so) while the app runs from a place it should not stay in.
    let moveItem = NSMenuItem(title: "Move to Applications", action: nil, keyEquivalent: "")
    var original: [String] = []

    func applicationWillTerminate(_ note: Notification) {
        listener?.terminate()
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        // one menu-bar program at a time
        let mine = Bundle.main.bundleIdentifier ?? ""
        if NSRunningApplication.runningApplications(withBundleIdentifier: mine).count > 1 {
            NSApp.terminate(nil)
            return
        }
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
        listener = startListener()
        if CommandLine.arguments.contains("--update-now") { updateNow() }
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
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.prompt = "Send"
        panel.message = "Choose the files or folders to send"
        NSApp.activate(ignoringOtherApps: true)
        if panel.runModal() == .OK {
            startEngine(["open", "--app", "--"] + panel.urls.map { $0.path })
        }
    }

    @objc func openWindow() {
        startEngine(["open", "--app"])
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

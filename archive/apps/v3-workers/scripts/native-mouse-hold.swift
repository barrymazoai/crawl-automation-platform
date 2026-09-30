// Explicitly requested native input helper. Initial scope: our own pointer lab only.
// No CAPTCHA logic, randomized motion, event-source disguising, or permission changes.
import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

struct HoldFailure: Error { let code: String }
func fail(_ code: String) throws -> Never { throw HoldFailure(code: code) }
func output(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
       let line = String(data: data, encoding: .utf8) { print(line); fflush(stdout) }
}
let labTitle = "CUA Pointer Lab — 本机鼠标测试"
var cancelled: Int32 = 0
func signalCancelled(_ value: Int32) { cancelled = value }
let now = { ProcessInfo.processInfo.systemUptime }

struct HoldRequest: Codable {
    let pid: Int32
    let windowId: UInt32
    let bounds: [Double]
    let xRatio: Double
    let yRatio: Double
    let moveMs: Int
    let settleMs: Int
    let holdMs: Int
    var expectedTitle: String? = nil
    var expectedUrl: String? = nil
    // Explicit, observed waypoints before pressing; not randomized human impersonation.
    var movePath: [[Double]]? = nil
    var windowTitle: String { expectedTitle ?? labTitle }
    func validate() throws {
        guard pid > 0, windowId > 0, bounds.count == 4,
              bounds.allSatisfy({ $0.isFinite }), bounds[2] > 0, bounds[3] > 0,
              xRatio.isFinite, yRatio.isFinite,
              (0.05...0.95).contains(xRatio), (0.15...0.9).contains(yRatio),
              (200...3000).contains(moveMs), (0...1000).contains(settleMs),
              (100...15000).contains(holdMs) else { try fail("INVALID_REQUEST") }
        guard (movePath ?? []).count <= 6,
              (movePath ?? []).allSatisfy({ point in
                  point.count == 2 && point.allSatisfy { $0.isFinite } &&
                  (0.05...0.95).contains(point[0]) && (0.15...0.9).contains(point[1])
              }) else { try fail("INVALID_MOVE_PATH") }
        if windowTitle != labTitle {
            guard windowTitle == "Access to this page has been denied",
                  expectedUrl == "https://www.gnc.com/energy/613701.html", holdMs <= 10000 else {
                try fail("TARGET_NOT_ALLOWED")
            }
        }
    }
}
struct WindowInfo {
    let id: UInt32
    let pid: Int32
    let title: String
    let bounds: CGRect
    var json: [String: Any] {
        ["windowId": id, "pid": pid, "title": title,
         "bounds": [bounds.minX, bounds.minY, bounds.width, bounds.height]]
    }
}
func windows() -> [WindowInfo] {
    let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return rows.compactMap { row in
        guard (row[kCGWindowLayer as String] as? Int) == 0,
              let id = row[kCGWindowNumber as String] as? UInt32,
              let pid = row[kCGWindowOwnerPID as String] as? Int32,
              let rect = row[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: rect as CFDictionary) else { return nil }
        return WindowInfo(id: id, pid: pid, title: row[kCGWindowName as String] as? String ?? "", bounds: bounds)
    }
}
func isChrome(_ pid: Int32) -> Bool {
    NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == "com.google.Chrome"
}
func target(_ request: HoldRequest, requireFront: Bool) throws -> WindowInfo {
    let all = windows()
    guard let window = all.first(where: { $0.id == request.windowId && $0.pid == request.pid }),
          isChrome(window.pid), window.title == request.windowTitle else { try fail("TARGET_WINDOW_NOT_FOUND") }
    let b = request.bounds
    guard abs(window.bounds.minX-b[0]) < 1, abs(window.bounds.minY-b[1]) < 1,
          abs(window.bounds.width-b[2]) < 1, abs(window.bounds.height-b[3]) < 1 else { try fail("WINDOW_MOVED") }
    if requireFront {
        let point = CGPoint(x:window.bounds.minX+window.bounds.width*request.xRatio,
                            y:window.bounds.minY+window.bounds.height*request.yRatio)
        let topAtTarget = all.first(where: { $0.bounds.contains(point) })
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == request.pid,
              topAtTarget?.id == request.windowId else {
            output(["event":"FOREGROUND_GUARD", "expectedPid":request.pid,
                    "frontmostPid":NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,
                    "expectedWindowId":request.windowId,"topWindowId":topAtTarget?.id ?? 0])
            try fail("TARGET_NOT_FOREGROUND")
        }
    }
    return window
}
func ease(_ t: Double) -> Double { let v = min(1, max(0, t)); return v*v*(3-2*v) }
// Distance-weighted segments, fixed total moveMs. All points use window coordinates.
func movementPoint(_ points: [CGPoint], fraction: Double) -> CGPoint {
    guard let first = points.first else { return .zero }
    let lengths = zip(points,points.dropFirst()).map { hypot($1.x-$0.x,$1.y-$0.y) }
    let total = lengths.reduce(0,+)
    guard total > 0 else { return first }
    var distance = min(1,max(0,fraction))*total
    for (index,length) in lengths.enumerated() where length > 0 {
        if distance <= length {
            let weight = ease(distance/length), a = points[index], b = points[index+1]
            return CGPoint(x:a.x+(b.x-a.x)*weight,y:a.y+(b.y-a.y)*weight)
        }
        distance -= length
    }
    return points.last!
}
func post(_ kind: CGEventType, at point: CGPoint) throws {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: kind, mouseCursorPosition: point, mouseButton: .left) else {
        try fail("EVENT_CREATION_FAILED")
    }
    event.post(tap: .cghidEventTap)
}
func mousePosition() throws -> CGPoint {
    guard let event = CGEvent(source: nil) else { try fail("POINTER_UNAVAILABLE") }
    return event.location
}
func checkCancelled() throws { if cancelled != 0 { try fail("CANCELLED") } }

func verifyAddress(_ window: AXUIElement, _ expected: String?) throws {
    guard let expected = expected else { return }
    var remaining = 500
    func find(_ element:AXUIElement, _ depth:Int) -> Bool {
        guard remaining > 0, depth < 15 else { return false }; remaining -= 1
        var description:CFTypeRef?, value:CFTypeRef?, children:CFTypeRef?
        _ = AXUIElementCopyAttributeValue(element,kAXDescriptionAttribute as CFString,&description)
        if let description = description as? String,
           ["地址和搜索栏","Address and search bar"].contains(description) {
            _ = AXUIElementCopyAttributeValue(element,kAXValueAttribute as CFString,&value)
            guard let address = value as? String else { return false }
            return [expected,"www.gnc.com/energy/613701.html","gnc.com/energy/613701.html"].contains(address)
        }
        _ = AXUIElementCopyAttributeValue(element,kAXChildrenAttribute as CFString,&children)
        return (children as? [AXUIElement] ?? []).contains { find($0,depth+1) }
    }
    guard find(window,0) else { try fail("TARGET_URL_MISMATCH") }
}

func sameBounds(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
    abs(lhs.minX-rhs.minX) < 2 && abs(lhs.minY-rhs.minY) < 2 &&
    abs(lhs.width-rhs.width) < 2 && abs(lhs.height-rhs.height) < 2
}
func axBounds(_ element: AXUIElement) -> CGRect? {
    var position: CFTypeRef?, size: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element,kAXPositionAttribute as CFString,&position) == .success,
          AXUIElementCopyAttributeValue(element,kAXSizeAttribute as CFString,&size) == .success,
          let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var p=CGPoint.zero, s=CGSize.zero
    guard AXValueGetValue(position as! AXValue,.cgPoint,&p), AXValueGetValue(size as! AXValue,.cgSize,&s),
          p.x.isFinite, p.y.isFinite, s.width.isFinite, s.height.isFinite, s.width > 0, s.height > 0 else { return nil }
    return CGRect(origin:p,size:s)
}

func runHold(_ request: HoldRequest) throws {
    try request.validate()
    guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { try fail("ACCESSIBILITY_PERMISSION_REQUIRED") }
    // POSIX advisory lock: no stale lease after exit. Only this helper's instances share it.
    let lockPath = "/tmp/crawlv3-native-mouse-\(getuid()).lock"
    let fd = open(lockPath, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { try fail("LOCK_OPEN_FAILED") }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_uid == getuid(), (info.st_mode & S_IFMT) == S_IFREG,
          (info.st_mode & 0o077) == 0 else { try fail("UNSAFE_LOCK_FILE") }
    guard lockf(fd, F_TLOCK, 0) == 0 else { try fail("MOUSE_BUSY") }
    defer { _ = lockf(fd, F_ULOCK, 0) }
    signal(SIGINT, signalCancelled); signal(SIGTERM, signalCancelled); signal(SIGHUP, signalCancelled)
    signal(SIGPIPE, SIG_IGN)
    let window = try target(request, requireFront: false)
    guard !CGEventSource.buttonState(.combinedSessionState, button: .left),
          !CGEventSource.buttonState(.combinedSessionState, button: .right),
          !CGEventSource.buttonState(.combinedSessionState, button: .center) else { try fail("MOUSE_ALREADY_DOWN") }
    // Activate only the already-observed, exactly matched lab window.
    let axApp = AXUIElementCreateApplication(request.pid)
    var axWindows: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &axWindows) == .success,
          let list = axWindows as? [AXUIElement] else { try fail("AX_WINDOWS_UNAVAILABLE") }
    // WindowServer already matched exact PID + window ID + title + bounds. AX titles
    // may be localized or shared by several Chrome windows; bind AX by geometry,
    // then independently verify its address bar before sending any input.
    let matching = list.filter { element in
        guard let bounds=axBounds(element) else { return false }
        return sameBounds(bounds,window.bounds)
    }
    output(["event":"AX_WINDOW_MATCH","axWindowCount":list.count,"boundsMatches":matching.count,
            "expectedWindowId":request.windowId])
    guard matching.count > 0 else { try fail("AX_TARGET_WINDOW_NOT_FOUND") }
    guard matching.count == 1 else { try fail("AX_TARGET_WINDOW_AMBIGUOUS") }
    guard AXUIElementPerformAction(matching[0], kAXRaiseAction as CFString) == .success else { try fail("WINDOW_RAISE_FAILED") }
    NSRunningApplication(processIdentifier: request.pid)?.activate(options: [])
    guard AXUIElementSetAttributeValue(axApp, kAXFrontmostAttribute as CFString, kCFBooleanTrue) == .success else {
        try fail("WINDOW_ACTIVATE_FAILED")
    }
    let foregroundDeadline = now()+2
    while NSWorkspace.shared.frontmostApplication?.processIdentifier != request.pid && now()<foregroundDeadline {
        try checkCancelled(); RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
    }
    _ = try target(request, requireFront: true)
    try verifyAddress(matching[0],request.expectedUrl)
    let start = try mousePosition()
    let destination = CGPoint(x: window.bounds.minX+window.bounds.width*request.xRatio,
                              y: window.bounds.minY+window.bounds.height*request.yRatio)
    let route = [start] + (request.movePath ?? []).map {
        CGPoint(x:window.bounds.minX+window.bounds.width*$0[0],
                y:window.bounds.minY+window.bounds.height*$0[1])
    } + [destination]
    output(["event": "MOVING", "from": [start.x,start.y], "to": [destination.x,destination.y],
            "moveMs": request.moveMs,"path":route.map { [$0.x,$0.y] }])
    let moveStart = now()
    var previous = start
    var postedMoves = 0, postedDistancePx = 0.0
    repeat {
        try checkCancelled()
        _ = try target(request, requireFront: true)
        let actual = try mousePosition()
        guard hypot(actual.x-previous.x, actual.y-previous.y)<8 else { try fail("POINTER_TAKEN_OVER") }
        let fraction = min(1, (now()-moveStart)*1000/Double(request.moveMs))
        let point = movementPoint(route,fraction:fraction)
        let delta = hypot(point.x-previous.x,point.y-previous.y)
        if delta > 0 {
            try post(.mouseMoved, at: point)
            postedMoves += 1; postedDistancePx += delta; previous = point
        }
        if fraction == 1 { break }
        Thread.sleep(forTimeInterval: 1/60)
    } while true
    output(["event":"MOVE_COMPLETED","postedMoves":postedMoves,"postedDistancePx":postedDistancePx,
            "elapsedMs":(now()-moveStart)*1000,"note":"Posted path only; page events are independent evidence."])
    func guardedWait(_ seconds: Double) throws {
        let deadline = now()+seconds
        while now()<deadline {
            try checkCancelled(); _ = try target(request, requireFront: true)
            let actual = try mousePosition()
            guard hypot(actual.x-destination.x, actual.y-destination.y)<8 else { try fail("POINTER_TAKEN_OVER") }
            Thread.sleep(forTimeInterval: min(0.05, max(0,deadline-now())))
        }
    }
    try guardedWait(Double(request.settleMs)/1000)
    try checkCancelled()
    _ = try target(request, requireFront: true)
    try verifyAddress(matching[0],request.expectedUrl)
    guard !CGEventSource.buttonState(.combinedSessionState, button: .left) else { try fail("MOUSE_ALREADY_DOWN") }
    var pressed = false
    defer {
        if pressed {
            let position = (try? mousePosition()) ?? destination
            try? post(.leftMouseUp, at: position)
            output(["event":"EMERGENCY_RELEASE_POSTED"])
        }
    }
    try post(.leftMouseDown, at: destination); pressed = true
    let holdStart = now()
    output(["event":"DOWN_POSTED", "holdMs":request.holdMs])
    try guardedWait(Double(request.holdMs)/1000)
    try post(.leftMouseUp, at: destination); pressed = false
    output(["event":"UP_POSTED", "elapsedMs":(now()-holdStart)*1000,
            "note":"OS events posted; verify actual page evidence separately."])
}

// LaunchServices opens the .app with no arguments into this permission-only UI.
// Merely opening the app never sends input or requests a permission automatically.
final class PermissionGuide: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var status: NSTextField!
    var timer: Timer?
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect:NSRect(x:0,y:0,width:620,height:390),
                          styleMask:[.titled,.closable,.miniaturizable],backing:.buffered,defer:false)
        window.title = "Crawler Mouse · 权限设置"
        window.center()
        let stack = NSStackView()
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        let title = NSTextField(labelWithString:"Crawler Mouse")
        title.font = .boldSystemFont(ofSize:25)
        stack.addArrangedSubview(title)
        let explanation = NSTextField(wrappingLabelWithString:
            "独立的本机鼠标工具。辅助功能用于移动和按住鼠标；屏幕录制用于核对目标窗口。\n只有你点击下面的申请按钮，才会发起系统授权请求。当前窗口不会操作浏览器或验证码。")
        explanation.font = .systemFont(ofSize:14)
        stack.addArrangedSubview(explanation)
        status = NSTextField(wrappingLabelWithString:"")
        status.font = .monospacedSystemFont(ofSize:14,weight:.regular)
        stack.addArrangedSubview(status)
        let row = NSStackView(); row.orientation = .horizontal; row.spacing = 12
        row.addArrangedSubview(NSButton(title:"1. 申请辅助功能",target:self,action:#selector(requestAccessibility)))
        row.addArrangedSubview(NSButton(title:"2. 申请屏幕录制",target:self,action:#selector(requestScreen)))
        row.addArrangedSubview(NSButton(title:"刷新状态",target:self,action:#selector(refresh)))
        stack.addArrangedSubview(row)
        let note = NSTextField(wrappingLabelWithString:
            "在系统设置中开启 Crawler Mouse。若系统要求退出并重新打开，请按提示操作。\n不需要授予完全磁盘访问权限。关闭此窗口会退出工具。")
        note.font = .systemFont(ofSize:12); note.textColor = .secondaryLabelColor
        stack.addArrangedSubview(note)
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo:window.contentView!.leadingAnchor,constant:28),
            stack.trailingAnchor.constraint(equalTo:window.contentView!.trailingAnchor,constant:-28),
            stack.topAnchor.constraint(equalTo:window.contentView!.topAnchor,constant:26)
        ])
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps:true)
        refresh()
        timer = Timer.scheduledTimer(timeInterval:2,target:self,selector:#selector(refresh),userInfo:nil,repeats:true)
    }
    @objc func requestAccessibility() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        refresh()
    }
    @objc func requestScreen() { _ = CGRequestScreenCaptureAccess(); refresh() }
    @objc func refresh() {
        let accessibility = AXIsProcessTrusted()
        let posting = CGPreflightPostEventAccess()
        let screen = CGPreflightScreenCaptureAccess()
        status.stringValue = "辅助功能：\(accessibility ? "已授权" : "未授权")\n鼠标事件：\(posting ? "已授权" : "未授权")\n屏幕录制：\(screen ? "已授权" : "未授权")"
        // Private status-only evidence, read back from SSH without inheriting SSH's TCC identity.
        do {
            let directory = FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0]
                .appendingPathComponent("Crawler Mouse",isDirectory:true)
            try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
            let file = directory.appendingPathComponent("permissions.json")
            let data = try JSONSerialization.data(withJSONObject:["accessibility":accessibility,"postEventAccess":posting,
                "screenRecording":screen,"bundleIdentifier":Bundle.main.bundleIdentifier ?? "",
                "appPath":Bundle.main.bundlePath,"pid":ProcessInfo.processInfo.processIdentifier,
                "updatedAt":ISO8601DateFormatter().string(from:Date()),"mode":"permission-guide","inputEvents":0],options:[.sortedKeys])
            try data.write(to:file,options:.atomic)
            try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
        } catch { /* UI remains usable if private evidence cannot be written. */ }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication) -> Bool { true }
}

do {
    let args = Array(CommandLine.arguments.dropFirst())
    if args.isEmpty && Bundle.main.bundleURL.pathExtension == "app" {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let guide = PermissionGuide()
        app.delegate = guide
        withExtendedLifetime(guide) { app.run() }
    } else if args == ["--inspect"] || args == ["--inspect-gnc"] {
        output(["accessibility":AXIsProcessTrusted(), "postEventAccess":CGPreflightPostEventAccess(),
                "screenRecording":CGPreflightScreenCaptureAccess(),
                "frontmostPid":NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,
                "topWindowId":windows().first?.id ?? 0,
                "windows":windows().filter { isChrome($0.pid) && $0.title == (args == ["--inspect-gnc"] ? "Access to this page has been denied" : labTitle) }.map(\.json)])
    } else if args == ["--self-test"] {
        guard ease(0)==0, ease(1)==1, ease(0.5)==0.5, ease(-1)==0, ease(2)==1 else { try fail("EASE_TEST_FAILED") }
        let good = HoldRequest(pid:1,windowId:1,bounds:[0,0,1000,800],xRatio:0.5,yRatio:0.4,moveMs:1200,settleMs:300,holdMs:10000)
        try good.validate()
        guard sameBounds(CGRect(x:22,y:52,width:1200,height:785),CGRect(x:22,y:52,width:1200,height:785)),
              !sameBounds(CGRect(x:22,y:52,width:1200,height:785),CGRect(x:0,y:30,width:800,height:600)),
              !sameBounds(CGRect(x:22,y:52,width:1200,height:785),CGRect(x:25,y:52,width:1200,height:785)) else {
            try fail("AX_GEOMETRY_TEST_FAILED")
        }
        let bad = HoldRequest(pid:1,windowId:1,bounds:[0,0,1000,800],xRatio:0.5,yRatio:0.4,moveMs:1200,settleMs:300,holdMs:15001)
        do { try bad.validate(); try fail("VALIDATION_TEST_FAILED") } catch let error as HoldFailure {
            guard error.code == "INVALID_REQUEST" else { throw error }
        }
        let a = CGPoint(x:10,y:10), b = CGPoint(x:110,y:10), c = CGPoint(x:110,y:110)
        guard movementPoint([a,b,c],fraction:0)==a,
              movementPoint([a,b,c],fraction:0.5)==b,
              movementPoint([a,b,c],fraction:1)==c,
              movementPoint([a,a],fraction:0.5)==a,
              movementPoint([a,b,a],fraction:0.5)==b else { try fail("PATH_TEST_FAILED") }
        var pathRequest = good
        pathRequest.movePath = [[0.3,0.4],[0.4,0.5]]
        try pathRequest.validate()
        for badPath in [[[0.3]], [[1.0,0.4]], [[0.3,Double.nan]], Array(repeating:[0.3,0.4],count:7)] {
            pathRequest.movePath = badPath
            do { try pathRequest.validate(); try fail("PATH_VALIDATION_TEST_FAILED") }
            catch let error as HoldFailure { guard error.code == "INVALID_MOVE_PATH" else { throw error } }
        }
        output(["ok":true,"checks":["ease endpoints","ease bounds","ease midpoint","valid request","duration upper bound",
            "path endpoints","path waypoint","zero distance","same endpoint with excursion","valid path","invalid path shape/bounds/NaN/count",
            "AX geometry exact match","AX geometry different window rejected","AX geometry moved window rejected"],"inputEvents":0])
    } else if args.count == 2 && args[0] == "--hold" {
        try runHold(JSONDecoder().decode(HoldRequest.self, from: Data(args[1].utf8)))
    } else { try fail("USAGE: --inspect | --self-test | --hold JSON") }
} catch {
    output(["ok":false,"error":(error as? HoldFailure)?.code ?? String(describing:error)])
    exit(1)
}

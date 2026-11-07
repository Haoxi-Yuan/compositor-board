// Camera Raw Filter for the board: a develop session kept open in compositor-engine for as long as the panel is, so
// the native-resolution source, the measured brightness, the grain seed and the last preview are the ones OK applies,
// as in the app (Document/Filters.swift beginFilter … commitFilter, Document/CameraRaw.swift). The board coalesces its
// changes (one request in flight, latest state wins) and receives view-sized raw RGBA tiles and the scope as JSON.
// Specification: docs/port-specs/camera-raw.md, sections 17, 18 and 20.
import AppKit
import CoreGraphics
import Foundation

/// A Camera Raw panel open on a board: the session holding its filter edit, and the project as it was on disk when it
/// opened (an OK on a project changed since is refused rather than written over it).
final class CameraRawSession {
    let session: EditorSession
    let url: URL
    let edit: FilterEdit
    let stamp: DiskStamp?

    init(session: EditorSession, url: URL, edit: FilterEdit, stamp: DiskStamp?) {
        self.session = session
        self.url = url
        self.edit = edit
        self.stamp = stamp
    }
}

/// Open panels by session id: one per board at a time (Camera Raw is modal), several boards at once.
enum CameraRawSessions {
    static var open: [String: CameraRawSession] = [:]
}

extension EngineOperations {
    func cameraRawOperation(_ op: String, _ args: [String: Any]) async throws -> Any? {
        switch op {
        case "filter.session.open": return try await cameraRawOpen(args)
        case "filter.session.update": return try await cameraRawUpdate(args)
        case "filter.session.sample": return try cameraRawSample(args)
        case "filter.session.fetch": return try cameraRawFetch(args)
        case "filter.session.commit": return try await cameraRawCommit(args)
        case "filter.session.close": return cameraRawClose(args)
        case "filter.session.repeat": return try await cameraRawRepeat(args)
        // The engine's own normalization of a settings object, for the board's conformance checks (section 23.2).
        case "cameraRaw.normalize": return cameraRawJSON(try cameraRawSettings(from: args["settings"]).normalized)
        default: return nil
        }
    }

    // MARK: Operations (section 18.3)

    /// Begins Camera Raw on the active layer as Filter › Camera Raw Filter… does, with the board's remembered settings,
    /// and keeps the edit open until commit or close.
    func cameraRawOpen(_ args: [String: Any]) async throws -> Any {
        let (session, url) = try await session(args)
        let stamp = DiskStamp(url)
        configure(session, args)
        if let given = args["settings"], !(given is NSNull) { session.filterSettings.cameraRaw = try cameraRawSettings(from: given) }
        // One panel per project: a new one replaces any left open.
        for (id, open) in CameraRawSessions.open where open.url.path == url.path {
            open.session.cancelFilter()
            CameraRawSessions.open[id] = nil
        }
        session.beginFilter(.cameraRaw)
        guard let edit = session.filterEdit, edit.kind == .cameraRaw else {
            return ["error": session.brushError ?? "Camera Raw Filter can't be applied to this layer."]
        }
        // Eyes or overlays other than the defaults re-render the preview beginFilter started.
        if cameraRawState(edit, args) { session.updateFilter(edit.settings, preview: edit.preview) }
        await cameraRawSettle(edit)
        let id = UUID().uuidString
        CameraRawSessions.open[id] = CameraRawSession(session: session, url: url, edit: edit, stamp: stamp)
        var result = try cameraRawAnswer(edit, session: session, args: args, render: 0)
        result["session"] = id
        result["layerID"] = edit.layerID.uuidString
        result["size"] = [edit.previewSource.width, edit.previewSource.height]
        result["transform"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(edit.preparedTransform ?? edit.transform))
        result["limitedToSelection"] = edit.selection != nil
        return result
    }

    /// The board's whole current state, rendered: settings, eyes, preview and overlays, plus at most one eyedropper
    /// action, which runs the app's own sampling code and comes back as `patch`.
    func cameraRawUpdate(_ args: [String: Any]) async throws -> Any {
        guard let open = openCameraRaw(args) else { return Self.unknownCameraRawSession }
        let session = open.session, edit = open.edit
        let started = Date()
        _ = cameraRawState(edit, args)
        var settings = edit.settings
        settings.cameraRaw = try cameraRawSettings(from: args["settings"] ?? [String: Any]())
        edit.settings = settings.normalized
        let before = cameraRawJSON(edit.settings.cameraRaw)
        session.brushError = nil
        var solved: Any = NSNull()
        var acted = false
        if let action = args["action"] as? [String: Any] {
            acted = true
            switch action["kind"] as? String ?? "" {
            case "whiteBalance":
                edit.samplesWhiteBalance = true
                session.sampleCameraRawWhiteBalance(at: try point(action))
                edit.samplesWhiteBalance = false
            case "defringe":
                edit.samplesDefringe = true
                session.sampleCameraRawDefringe(at: try point(action))
                edit.samplesDefringe = false
            case "pointColor":
                edit.samplesPointColor = true
                session.sampleCameraRawPointColor(at: try point(action))
                edit.samplesPointColor = false
            case "autoWhiteBalance":
                // applyCameraRawAutoWhiteBalance (Document/CameraRaw.swift:425-439): the mode first, then the
                // gray-world average of the original layer, applied while Auto is still chosen. The engine is serial,
                // so the average is awaited here.
                guard !edit.committing else { break }
                var auto = edit.settings
                auto.cameraRaw.whiteBalance = .auto
                session.updateFilter(auto, preview: edit.preview)
                let image = edit.original.image
                let result = await Task.detached(priority: .userInitiated) { CameraRawSettings.autoBalance(of: image) }.value
                if let result {
                    solved = ["temperature": result.temperature, "tint": result.tint]
                    if session.filterEdit === edit, !edit.committing, edit.settings.cameraRaw.whiteBalance == .auto {
                        var balanced = edit.settings
                        balanced.cameraRaw.temperature = result.temperature
                        balanced.cameraRaw.tint = result.tint
                        session.updateFilter(balanced, preview: edit.preview)
                    }
                }
            default:
                throw EngineError.bad("unknown camera raw action \(action["kind"] ?? "")")
            }
        }
        // No render was started (no action, or one that hit a clear pixel or missed the layer).
        if edit.previewTask == nil { session.updateFilter(edit.settings, preview: edit.preview) }
        await cameraRawSettle(edit)
        let render = Date().timeIntervalSince(started) * 1000
        var result = try cameraRawAnswer(edit, session: session, args: args, render: render)
        result["patch"] = acted ? (cameraRawDifference(before, cameraRawJSON(edit.settings.cameraRaw)) ?? NSNull()) : NSNull()
        result["solved"] = solved
        return result
    }

    /// RGB under the pointer (updateCameraRawReadout) and what a targeted adjustment reads there (cameraRawSample).
    func cameraRawSample(_ args: [String: Any]) throws -> Any {
        guard let open = openCameraRaw(args) else { return Self.unknownCameraRawSession }
        let session = open.session, edit = open.edit
        let at = try point(args)
        session.updateCameraRawReadout(at: at)
        let readout: Any = edit.cameraRawReadout.map { [$0.red, $0.green, $0.blue] } ?? NSNull()
        return ["readout": readout, "sample": cameraRawPixel(edit, at: at) ?? NSNull()]
    }

    /// The last preview again, for another part of the layer after a pan or zoom; nothing is rendered.
    func cameraRawFetch(_ args: [String: Any]) throws -> Any {
        guard let open = openCameraRaw(args) else { return Self.unknownCameraRawSession }
        let edit = open.edit
        var result: [String: Any] = ["serial": args["serial"] ?? NSNull(), "tile": NSNull()]
        if edit.preview, let image = edit.preparedPreview, let out = args["out"] as? String {
            result["tile"] = try cameraRawTile(image, view: args["view"] as? [String: Any], to: out) ?? NSNull()
        }
        return result
    }

    /// OK: the full-size result from the layer's own pixels, one undo step "Camera Raw Filter" (commitFilter). An
    /// identity grade closes as Cancel does; the rendered settings come back either way, for the next open.
    func cameraRawCommit(_ args: [String: Any]) async throws -> Any {
        guard let open = openCameraRaw(args) else { return Self.unknownCameraRawSession }
        let id = args["session"] as? String ?? ""
        let session = open.session, edit = open.edit
        _ = cameraRawState(edit, args)
        if let given = args["settings"] {
            var settings = edit.settings
            settings.cameraRaw = try cameraRawSettings(from: given)
            edit.settings = settings.normalized
        }
        // Overlays never reach the layer.
        edit.cameraRawClipping = nil
        edit.cameraRawSharpenMask = false
        edit.showsShadowClipping = false
        edit.showsHighlightClipping = false
        // The project changed on disk while the panel was open (the app, Claude, another board): applying this
        // session's copy would write over that (section 18.7).
        if DiskStamp(open.url) != open.stamp {
            session.cancelFilter()
            CameraRawSessions.open[id] = nil
            return ["saved": false, "stale": true, "error": "The project changed on disk while Camera Raw was open."]
        }
        let before = session.document
        session.brushError = nil
        await session.commitFilter()
        CameraRawSessions.open[id] = nil
        if session.filterEdit === edit { session.cancelFilter() }
        let saved = try await saveIfChanged(session, from: before, to: open.url)
        var result: [String: Any] = [
            "saved": saved, "rendered": cameraRawJSON(session.filterSettings.cameraRaw),
            "lastFilter": saved && session.lastFilter == .cameraRaw ? FilterKind.cameraRaw.rawValue : NSNull(),
        ]
        if saved {
            if !session.history.undoName.isEmpty { result["editName"] = session.history.undoName }
            result["changedFiles"] = changedFiles(session, from: before)
        }
        if let error = session.brushError { result["error"] = error }
        return result
    }

    /// Cancel: the edit goes, nothing is remembered. Idempotent.
    func cameraRawClose(_ args: [String: Any]) -> Any {
        if let id = args["session"] as? String, let open = CameraRawSessions.open[id] {
            open.session.cancelFilter()
            CameraRawSessions.open[id] = nil
        }
        return ["closed": true]
    }

    /// Filter › Last Filter after Camera Raw: the remembered grade again, without a panel or a preview
    /// (repeatLastFilter); an identity grade closes silently.
    func cameraRawRepeat(_ args: [String: Any]) async throws -> Any {
        let settings = try cameraRawSettings(from: args["settings"] ?? [String: Any]())
        return try await withSession(args) { session in
            session.filterSettings.cameraRaw = settings
            session.lastFilter = .cameraRaw
            guard session.canRepeatLastFilter else {
                session.brushError = "Last Filter can't be applied to this layer."
                return
            }
            await session.repeatLastFilter()
        }
    }

    // MARK: Session plumbing

    static let unknownCameraRawSession: [String: Any] = ["error": "unknown session", "unknownSession": true]

    func openCameraRaw(_ args: [String: Any]) -> CameraRawSession? {
        guard let id = args["session"] as? String, let open = CameraRawSessions.open[id],
              open.session.filterEdit === open.edit else { return nil }
        return open
    }

    /// Each finished render starts the newest pending one, so wait until none is left.
    func cameraRawSettle(_ edit: FilterEdit) async {
        while let task = edit.previewTask { await task.value }
    }

    private static let eyes: [(String, ReferenceWritableKeyPath<FilterEdit, Bool>)] = [
        ("light", \.showsCameraRawLight), ("color", \.showsCameraRawColor), ("colorGrading", \.showsCameraRawGrading),
        ("effects", \.showsCameraRawEffects), ("curve", \.showsCameraRawCurve), ("colorMixer", \.showsCameraRawMixer),
        ("detail", \.showsCameraRawDetail), ("optics", \.showsCameraRawOptics), ("geometry", \.showsCameraRawGeometry),
        ("calibration", \.showsCameraRawCalibration),
    ]

    /// The panel state a request carries besides the settings: the section eyes, Preview, the overlays the engine
    /// paints into the preview, and the selected point color. True when any of it differs from a fresh edit's.
    func cameraRawState(_ edit: FilterEdit, _ args: [String: Any]) -> Bool {
        var differs = false
        if let preview = args["preview"] as? Bool {
            edit.preview = preview
            if !preview { differs = true }
        }
        if let eyes = args["eyes"] as? [String: Any] {
            for (key, path) in Self.eyes {
                guard let shown = eyes[key] as? Bool else { continue }
                edit[keyPath: path] = shown
                if !shown { differs = true }
            }
        }
        if let overlay = args["overlay"] as? [String: Any] {
            switch overlay["clipping"] as? String {
            case "highlights": edit.cameraRawClipping = .highlights
            case "shadows": edit.cameraRawClipping = .shadows
            default: edit.cameraRawClipping = nil
            }
            edit.cameraRawSharpenMask = overlay["sharpenMask"] as? Bool ?? false
            edit.showsShadowClipping = overlay["shadowClipping"] as? Bool ?? false
            edit.showsHighlightClipping = overlay["highlightClipping"] as? Bool ?? false
            if let index = int(overlay["pointIndex"]) { edit.cameraRawPointIndex = max(0, index) }
            if edit.cameraRawClipping != nil || edit.cameraRawSharpenMask || edit.showsShadowClipping || edit.showsHighlightClipping {
                differs = true
            }
        }
        return differs
    }

    /// What an update answers: the rendered settings, the preview tile for the board's view, the scope and the error.
    func cameraRawAnswer(_ edit: FilterEdit, session: EditorSession, args: [String: Any], render: Double) throws -> [String: Any] {
        let started = Date()
        var result: [String: Any] = [
            "serial": args["serial"] ?? NSNull(), "settings": cameraRawJSON(edit.settings.cameraRaw),
            "pointIndex": edit.cameraRawPointIndex, "rendered": false, "tile": NSNull(),
            "scope": cameraRawScopeJSON(edit.cameraRawScope), "error": edit.previewError ?? NSNull(),
        ]
        if edit.preview, let image = edit.preparedPreview, let out = args["out"] as? String {
            result["rendered"] = true
            result["tile"] = try cameraRawTile(image, view: args["view"] as? [String: Any], to: out) ?? NSNull()
        }
        if let alert = session.brushError { result["alert"] = alert }
        result["ms"] = ["render": render.rounded(), "tile": (Date().timeIntervalSince(started) * 1000).rounded()]
        return result
    }

    /// The part of the preview the board shows, at the board's display resolution, as straight RGBA bytes with
    /// upstream's rounding (section 18.5). Nil when the view misses the layer.
    func cameraRawTile(_ image: CGImage, view: [String: Any]?, to path: String) throws -> [String: Any]? {
        let w = image.width, h = image.height
        var rect = CGRect(x: 0, y: 0, width: w, height: h)
        var scale = 1.0
        if let view {
            let x = (double(view["x"]) ?? 0).rounded(.down), y = (double(view["y"]) ?? 0).rounded(.down)
            let right = (x + (double(view["width"]) ?? Double(w))).rounded(.up), bottom = (y + (double(view["height"]) ?? Double(h))).rounded(.up)
            rect = CGRect(x: x, y: y, width: right - x, height: bottom - y).intersection(CGRect(x: 0, y: 0, width: w, height: h))
            scale = min(1, max(1e-4, double(view["scale"]) ?? 1))
        }
        guard !rect.isNull, rect.width >= 1, rect.height >= 1, let piece = image.cropping(to: rect) else { return nil }
        let pw = max(1, Int((rect.width * scale).rounded(.up))), ph = max(1, Int((rect.height * scale).rounded(.up)))
        guard let context = CGContext(data: nil, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: pw * 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue), let data = context.data else {
            throw EngineError.bad("cannot render the preview tile")
        }
        context.interpolationQuality = pw == Int(rect.width) && ph == Int(rect.height) ? .none : .high
        context.setBlendMode(.copy)
        context.draw(piece, in: CGRect(x: 0, y: 0, width: pw, height: ph))
        let bytes = data.assumingMemoryBound(to: UInt8.self)
        let count = pw * ph
        for i in 0..<count {
            let a = Int(bytes[i * 4 + 3])
            for c in 0..<3 {
                let value = Int(bytes[i * 4 + c])
                bytes[i * 4 + c] = a == 0 ? 0 : UInt8(min(255, (value * 255 + a / 2) / a))
            }
        }
        try Data(bytes: data, count: count * 4).write(to: URL(fileURLWithPath: path))
        return ["x": Int(rect.minX), "y": Int(rect.minY), "width": Int(rect.width), "height": Int(rect.height),
                "pixelWidth": pw, "pixelHeight": ph]
    }

    /// CameraRawScope as the panel draws it: the doubles rounded to 4 decimals, with the shared histogram peak
    /// (LevelsHistogramDisplay.scale) and the vectorscope's maximum.
    func cameraRawScopeJSON(_ scope: CameraRawScope?) -> Any {
        guard let scope else { return NSNull() }
        func rounded(_ values: [Double]) -> [Double] { values.map { ($0 * 10000).rounded() / 10000 } }
        return ["red": rounded(scope.red), "green": rounded(scope.green), "blue": rounded(scope.blue),
                "vectorscope": rounded(scope.vectorscope), "peak": scope.peak, "vectorPeak": scope.vectorscope.max() ?? 0]
    }

    /// cameraRawSample (Document/CameraRaw.swift:607-635): tone (Rec. 709 luma), HSV hue in degrees, chroma over max
    /// and HSL lightness of the preview pixel under the point; nil on a clear pixel or off the layer.
    func cameraRawPixel(_ edit: FilterEdit, at point: CGPoint) -> [String: Double]? {
        let image = edit.preparedPreview ?? edit.previewSource
        let pixel = point.applying(edit.previewMapping.inverted())
        let rect = CGRect(x: floor(pixel.x), y: floor(pixel.y), width: 1, height: 1)
        guard pixel.x >= 0, pixel.y >= 0, pixel.x < CGFloat(image.width), pixel.y < CGFloat(image.height),
              let sample = image.cropping(to: rect),
              let context = try? BrushRaster.context(width: 1, height: 1, mask: false) else { return nil }
        BrushRaster.draw(sample, in: CGRect(x: 0, y: 0, width: 1, height: 1), mask: false, context: context)
        guard let data = context.data else { return nil }
        let bytes = data.assumingMemoryBound(to: UInt8.self)
        guard bytes[3] > 0 else { return nil }
        let red = min(1, Double(bytes[0]) / Double(bytes[3]))
        let green = min(1, Double(bytes[1]) / Double(bytes[3]))
        let blue = min(1, Double(bytes[2]) / Double(bytes[3]))
        let maxChannel = max(red, green, blue), minChannel = min(red, green, blue)
        let chroma = maxChannel - minChannel
        var hue = 0.0
        if chroma > 1e-6 {
            if maxChannel == red { hue = (green - blue) / chroma }
            else if maxChannel == green { hue = 2 + (blue - red) / chroma }
            else { hue = 4 + (red - green) / chroma }
            hue /= 6
            if hue < 0 { hue += 1 }
        }
        let tone = 0.2126 * red + 0.7152 * green + 0.0722 * blue
        let saturation = maxChannel == 0 ? 0 : chroma / maxChannel
        return ["tone": tone, "hue": hue * 360, "saturation": saturation, "luminance": (maxChannel + minChannel) / 2]
    }

    /// The leaves of `after` that differ from `before` (objects compared key by key, arrays as wholes), or nil.
    func cameraRawDifference(_ before: [String: Any], _ after: [String: Any]) -> [String: Any]? {
        var patch: [String: Any] = [:]
        for (key, value) in after {
            if let inner = value as? [String: Any], let old = before[key] as? [String: Any] {
                if let changed = cameraRawDifference(old, inner) { patch[key] = changed }
            } else if !(before[key].map { NSDictionary(dictionary: ["v": $0]).isEqual(to: ["v": value]) } ?? false) {
                patch[key] = value
            }
        }
        return patch.isEmpty ? nil : patch
    }

    // MARK: Settings JSON (section 17)

    private static let crNumbers: [(String, WritableKeyPath<CameraRawSettings, Double>)] = [
        ("temperature", \.temperature), ("tint", \.tint), ("exposure", \.exposure), ("contrast", \.contrast),
        ("highlights", \.highlights), ("shadows", \.shadows), ("whites", \.whites), ("blacks", \.blacks),
        ("vibrance", \.vibrance), ("saturation", \.saturation), ("texture", \.texture), ("clarity", \.clarity),
        ("dehaze", \.dehaze), ("glow", \.glow), ("glowRange", \.glowRange), ("glowSpread", \.glowSpread),
        ("glowWarmth", \.glowWarmth), ("vignetteAmount", \.vignetteAmount), ("vignetteMidpoint", \.vignetteMidpoint),
        ("vignetteRoundness", \.vignetteRoundness), ("vignetteFeather", \.vignetteFeather),
        ("vignetteHighlights", \.vignetteHighlights), ("grainAmount", \.grainAmount), ("grainSize", \.grainSize),
        ("grainRoughness", \.grainRoughness),
    ]
    private static let curveNumbers: [(String, WritableKeyPath<CameraRawCurveSettings, Double>)] = [
        ("shadows", \.shadows), ("darks", \.darks), ("lights", \.lights), ("highlights", \.highlights),
        ("shadowSplit", \.shadowSplit), ("darkSplit", \.darkSplit), ("lightSplit", \.lightSplit),
        ("refineSaturation", \.refineSaturation),
    ]
    private static let curvePoints: [(String, WritableKeyPath<CameraRawCurveSettings, [CurvePoint]>)] = [
        ("rgb", \.rgb), ("red", \.red), ("green", \.green), ("blue", \.blue),
    ]
    private static let mixerArrays: [(String, WritableKeyPath<CameraRawMixerSettings, [Double]>)] = [
        ("hue", \.hue), ("saturation", \.saturation), ("luminance", \.luminance),
    ]
    private static let pointNumbers: [(String, WritableKeyPath<CameraRawPointColor, Double>)] = [
        ("hue", \.hue), ("saturation", \.saturation), ("luminance", \.luminance), ("hueShift", \.hueShift),
        ("saturationShift", \.saturationShift), ("luminanceShift", \.luminanceShift), ("hueRange", \.hueRange),
        ("saturationRange", \.saturationRange), ("luminanceRange", \.luminanceRange),
    ]
    private static let wheels: [(String, WritableKeyPath<CameraRawGradingSettings, CameraRawGradeWheel>)] = [
        ("shadows", \.shadows), ("midtones", \.midtones), ("highlights", \.highlights), ("global", \.global),
    ]
    private static let detailNumbers: [(String, WritableKeyPath<CameraRawDetailSettings, Double>)] = [
        ("sharpenAmount", \.sharpenAmount), ("sharpenRadius", \.sharpenRadius), ("sharpenDetail", \.sharpenDetail),
        ("sharpenMasking", \.sharpenMasking), ("noiseLuminance", \.noiseLuminance),
        ("noiseLuminanceDetail", \.noiseLuminanceDetail), ("noiseLuminanceContrast", \.noiseLuminanceContrast),
        ("noiseColor", \.noiseColor), ("noiseColorDetail", \.noiseColorDetail), ("noiseColorSmoothness", \.noiseColorSmoothness),
    ]
    private static let opticsFlags: [(String, WritableKeyPath<CameraRawOpticsSettings, Bool>)] = [
        ("removeChromaticAberration", \.removeChromaticAberration), ("enableLensProfile", \.enableLensProfile),
    ]
    private static let opticsNumbers: [(String, WritableKeyPath<CameraRawOpticsSettings, Double>)] = [
        ("profileDistortion", \.profileDistortion), ("profileVignetting", \.profileVignetting), ("distortion", \.distortion),
        ("purpleAmount", \.purpleAmount), ("purpleHueLow", \.purpleHueLow), ("purpleHueHigh", \.purpleHueHigh),
        ("greenAmount", \.greenAmount), ("greenHueLow", \.greenHueLow), ("greenHueHigh", \.greenHueHigh),
        ("vignetteAmount", \.vignetteAmount), ("vignetteMidpoint", \.vignetteMidpoint),
    ]
    private static let geometryNumbers: [(String, WritableKeyPath<CameraRawGeometrySettings, Double>)] = [
        ("vertical", \.vertical), ("horizontal", \.horizontal), ("rotate", \.rotate), ("aspect", \.aspect),
        ("scale", \.scale), ("offsetX", \.offsetX), ("offsetY", \.offsetY),
    ]
    private static let calibrationNumbers: [(String, WritableKeyPath<CameraRawCalibrationSettings, Double>)] = [
        ("shadowTint", \.shadowTint), ("redHue", \.redHue), ("redSaturation", \.redSaturation), ("greenHue", \.greenHue),
        ("greenSaturation", \.greenSaturation), ("blueHue", \.blueHue), ("blueSaturation", \.blueSaturation),
    ]

    /// Section 17.1: defaults with the given keys laid over them; wrong types and unknown enum strings are errors,
    /// unknown keys are ignored. Not normalized here (updateFilter normalizes).
    func cameraRawSettings(from json: Any?) throws -> CameraRawSettings {
        var s = CameraRawSettings()
        guard let json, !(json is NSNull) else { return s }
        let o = try crObject(json, "")
        for (key, path) in Self.crNumbers where o[key] != nil { s[keyPath: path] = try crNumber(o[key]!, key) }
        if let v = o["whiteBalance"] { s.whiteBalance = try crEnum(v, "whiteBalance") }
        if let v = o["glowStyle"] { s.glowStyle = try crEnum(v, "glowStyle") }
        if let v = o["vignetteStyle"] { s.vignetteStyle = try crEnum(v, "vignetteStyle") }
        if let v = o["curve"] {
            let c = try crObject(v, "curve")
            for (key, path) in Self.curveNumbers where c[key] != nil { s.curve[keyPath: path] = try crNumber(c[key]!, "curve.\(key)") }
            for (key, path) in Self.curvePoints where c[key] != nil {
                guard let list = c[key] as? [Any] else { throw crBad("curve.\(key)") }
                s.curve[keyPath: path] = try list.enumerated().map { index, item in
                    let p = try crObject(item, "curve.\(key)[\(index)]")
                    guard let x = p["x"], let y = p["y"] else { throw crBad("curve.\(key)[\(index)]") }
                    return CurvePoint(x: try crNumber(x, "curve.\(key)[\(index)].x"), y: try crNumber(y, "curve.\(key)[\(index)].y"))
                }
            }
        }
        if let v = o["mixer"] {
            let m = try crObject(v, "mixer")
            for (key, path) in Self.mixerArrays where m[key] != nil {
                guard let list = m[key] as? [Any], list.count == 8 else { throw crBad("mixer.\(key)") }
                s.mixer[keyPath: path] = try list.enumerated().map { try crNumber($1, "mixer.\(key)[\($0)]") }
            }
            if let list = m["points"] {
                guard let points = list as? [Any] else { throw crBad("mixer.points") }
                s.mixer.points = try points.enumerated().map { index, item in
                    let p = try crObject(item, "mixer.points[\(index)]")
                    var color = CameraRawPointColor()
                    for (key, path) in Self.pointNumbers where p[key] != nil {
                        color[keyPath: path] = try crNumber(p[key]!, "mixer.points[\(index)].\(key)")
                    }
                    if let flag = p["visualize"] { color.visualize = try crFlag(flag, "mixer.points[\(index)].visualize") }
                    return color
                }
            }
        }
        if let v = o["grading"] {
            let g = try crObject(v, "grading")
            for (key, path) in Self.wheels where g[key] != nil {
                let w = try crObject(g[key]!, "grading.\(key)")
                if let x = w["hue"] { s.grading[keyPath: path].hue = try crNumber(x, "grading.\(key).hue") }
                if let x = w["saturation"] { s.grading[keyPath: path].saturation = try crNumber(x, "grading.\(key).saturation") }
                if let x = w["luminance"] { s.grading[keyPath: path].luminance = try crNumber(x, "grading.\(key).luminance") }
            }
            if let x = g["blending"] { s.grading.blending = try crNumber(x, "grading.blending") }
            if let x = g["balance"] { s.grading.balance = try crNumber(x, "grading.balance") }
        }
        if let v = o["detail"] {
            let d = try crObject(v, "detail")
            for (key, path) in Self.detailNumbers where d[key] != nil { s.detail[keyPath: path] = try crNumber(d[key]!, "detail.\(key)") }
        }
        if let v = o["optics"] {
            let p = try crObject(v, "optics")
            for (key, path) in Self.opticsFlags where p[key] != nil { s.optics[keyPath: path] = try crFlag(p[key]!, "optics.\(key)") }
            for (key, path) in Self.opticsNumbers where p[key] != nil { s.optics[keyPath: path] = try crNumber(p[key]!, "optics.\(key)") }
        }
        if let v = o["geometry"] {
            let g = try crObject(v, "geometry")
            if let x = g["upright"] { s.geometry.upright = try crEnum(x, "geometry.upright") }
            if let x = g["projection"] { s.geometry.projection = try crEnum(x, "geometry.projection") }
            for (key, path) in Self.geometryNumbers where g[key] != nil { s.geometry[keyPath: path] = try crNumber(g[key]!, "geometry.\(key)") }
            if let x = g["constrainCrop"] { s.geometry.constrainCrop = try crFlag(x, "geometry.constrainCrop") }
            if let list = g["guides"] {
                guard let guides = list as? [Any] else { throw crBad("geometry.guides") }
                s.geometry.guides = try guides.enumerated().map { index, item in
                    let p = try crObject(item, "geometry.guides[\(index)]")
                    func value(_ key: String) throws -> Double {
                        guard let x = p[key] else { throw crBad("geometry.guides[\(index)].\(key)") }
                        return try crNumber(x, "geometry.guides[\(index)].\(key)")
                    }
                    return CameraRawGeometryGuide(startX: try value("startX"), startY: try value("startY"),
                                                  endX: try value("endX"), endY: try value("endY"))
                }
            }
        }
        if let v = o["calibration"] {
            let c = try crObject(v, "calibration")
            if let x = c["process"] { s.calibration.process = try crEnum(x, "calibration.process") }
            for (key, path) in Self.calibrationNumbers where c[key] != nil {
                s.calibration[keyPath: path] = try crNumber(c[key]!, "calibration.\(key)")
            }
        }
        return s
    }

    /// Every field (section 17.4), the same shape the decoder reads.
    func cameraRawJSON(_ s: CameraRawSettings) -> [String: Any] {
        var json: [String: Any] = [:]
        for (key, path) in Self.crNumbers { json[key] = s[keyPath: path] }
        json["whiteBalance"] = s.whiteBalance.rawValue
        json["glowStyle"] = s.glowStyle.rawValue
        json["vignetteStyle"] = s.vignetteStyle.rawValue
        var curve: [String: Any] = [:]
        for (key, path) in Self.curveNumbers { curve[key] = s.curve[keyPath: path] }
        for (key, path) in Self.curvePoints { curve[key] = s.curve[keyPath: path].map { ["x": $0.x, "y": $0.y] } }
        json["curve"] = curve
        var mixer: [String: Any] = [:]
        for (key, path) in Self.mixerArrays { mixer[key] = s.mixer[keyPath: path] }
        mixer["points"] = s.mixer.points.map { color -> [String: Any] in
            var point: [String: Any] = [:]
            for (key, path) in Self.pointNumbers { point[key] = color[keyPath: path] }
            point["visualize"] = color.visualize
            return point
        }
        json["mixer"] = mixer
        var grading: [String: Any] = ["blending": s.grading.blending, "balance": s.grading.balance]
        for (key, path) in Self.wheels {
            let wheel = s.grading[keyPath: path]
            grading[key] = ["hue": wheel.hue, "saturation": wheel.saturation, "luminance": wheel.luminance]
        }
        json["grading"] = grading
        var detail: [String: Any] = [:]
        for (key, path) in Self.detailNumbers { detail[key] = s.detail[keyPath: path] }
        json["detail"] = detail
        var optics: [String: Any] = [:]
        for (key, path) in Self.opticsFlags { optics[key] = s.optics[keyPath: path] }
        for (key, path) in Self.opticsNumbers { optics[key] = s.optics[keyPath: path] }
        json["optics"] = optics
        var geometry: [String: Any] = [
            "upright": s.geometry.upright.rawValue, "projection": s.geometry.projection.rawValue, "constrainCrop": s.geometry.constrainCrop,
            "guides": s.geometry.guides.map { ["startX": $0.startX, "startY": $0.startY, "endX": $0.endX, "endY": $0.endY] },
        ]
        for (key, path) in Self.geometryNumbers { geometry[key] = s.geometry[keyPath: path] }
        json["geometry"] = geometry
        var calibration: [String: Any] = ["process": s.calibration.process.rawValue]
        for (key, path) in Self.calibrationNumbers { calibration[key] = s.calibration[keyPath: path] }
        json["calibration"] = calibration
        return json
    }

    private func crBad(_ path: String) -> EngineError { EngineError.bad("bad camera raw setting \(path)") }

    private func crObject(_ value: Any, _ path: String) throws -> [String: Any] {
        guard let object = value as? [String: Any] else { throw crBad(path.isEmpty ? "settings" : path) }
        return object
    }

    /// A JSON number, not a boolean (JSONSerialization bridges both to NSNumber).
    private func crNumber(_ value: Any, _ path: String) throws -> Double {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { throw crBad(path) }
        return n.doubleValue
    }

    private func crFlag(_ value: Any, _ path: String) throws -> Bool {
        guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { throw crBad(path) }
        return n.boolValue
    }

    private func crEnum<E: RawRepresentable>(_ value: Any, _ path: String) throws -> E where E.RawValue == String {
        guard let text = value as? String, let match = E(rawValue: text) else { throw crBad(path) }
        return match
    }
}

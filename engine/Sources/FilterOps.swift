// Filters for the board, run through Compositor's own filter edit (Document/Filters.swift beginFilter, updateFilter,
// cancelFilter, commitFilter). A panel on the board keeps one edit open in the engine from `filter.begin` to
// `filter.commit` or `filter.cancel`, so its preview, its random seed (Add Noise, Grain, Content-Aware Fill) and its
// cached Vision mask are the ones OK applies, as in the app. Specification: docs/port-specs/filters.md, sections 17-18.
import AppKit
import CoreGraphics
import Foundation

/// A filter panel open on the board: the session holding the edit, and the project as it was on disk when it opened.
final class OpenFilter {
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

extension EngineOperations {
    func filterOperation(_ op: String, _ args: [String: Any]) async throws -> Any? {
        switch op {
        case "filter.begin": return try await filterBegin(args)
        case "filter.update": return try await filterUpdate(args)
        case "filter.commit": return try await filterCommit(args)
        case "filter.cancel": return filterCancel(args)
        case "filter.repeat": return try await filterRepeat(args)
        case "filter.apply": return try await filterApply(args)
        default: return nil
        }
    }

    // MARK: Operations

    func filterBegin(_ args: [String: Any]) async throws -> Any {
        let kind = try filterKind(args)
        let (session, url) = try await session(args)
        configure(session, args)
        if let settings = args["settings"] { session.filterSettings = try filterSettings(settings, base: FilterSettings()) }
        // One panel per project: a new one replaces any left open.
        for (id, open) in openFilters where open.url.path == url.path {
            open.session.cancelFilter()
            openFilters[id] = nil
        }
        session.beginFilter(kind)
        guard let edit = session.filterEdit else {
            return ["error": session.brushError ?? "\(kind.rawValue) can't be applied to this layer."]
        }
        await settle(edit)
        let id = UUID().uuidString
        openFilters[id] = OpenFilter(session: session, url: url, edit: edit, stamp: DiskStamp(url))
        var result = try previewFields(edit, session: session, args: args)
        result["edit"] = id
        result["settings"] = filterSettingsJSON(edit.settings)
        result["layerID"] = edit.layerID.uuidString
        result["layerTransform"] = try jsonObject(edit.transform)
        result["automatic"] = kind.isAutomatic
        return result
    }

    func filterUpdate(_ args: [String: Any]) async throws -> Any {
        let open = try openFilter(args)
        let edit = open.edit
        let settings = try filterSettings(args["settings"] ?? [String: Any](), base: edit.settings)
        open.session.brushError = nil
        open.session.updateFilter(settings, preview: args["preview"] as? Bool ?? edit.preview)
        await settle(edit)
        var result = try previewFields(edit, session: open.session, args: args)
        result["settings"] = filterSettingsJSON(edit.settings)
        return result
    }

    func filterCommit(_ args: [String: Any]) async throws -> Any {
        let open = try openFilter(args)
        let id = args["edit"] as? String ?? ""
        let session = open.session, edit = open.edit
        if let given = args["settings"] {
            let final = try filterSettings(given, base: edit.settings)
            if final != edit.settings {
                session.updateFilter(final, preview: edit.preview || edit.kind.isAutomatic)
                await settle(edit)
            }
        }
        // The project changed on disk while the panel was open (the app, Claude, another board): applying this
        // session's copy would overwrite that, so the filter is applied afresh to the project as it is now.
        if DiskStamp(open.url) != open.stamp {
            session.cancelFilter()
            openFilters[id] = nil
            if try targetChanged(open) { return ["saved": false, "discarded": "stale", "open": false] }
            var fresh = args
            fresh["kind"] = edit.kind.rawValue
            fresh["settings"] = filterSettingsJSON(edit.settings)
            fresh["activeLayerID"] = edit.layerID.uuidString
            return try await filterApply(fresh)
        }
        let before = session.document
        await session.commitFilter()
        // An automatic filter whose preview failed stays open, as its panel does.
        if session.filterEdit === edit {
            var result = outcome(session, saved: false, args: args)
            result["open"] = true
            if result["error"] == nil, let error = edit.previewError { result["error"] = error }
            return result
        }
        openFilters[id] = nil
        let saved = try await saveIfChanged(session, from: before, to: open.url)
        return outcome(session, saved: saved, args: args, extra: [
            "open": false, "noop": !saved, "lastFilter": session.lastFilter?.rawValue ?? NSNull(),
            "filterSettings": filterSettingsJSON(session.filterSettings),
        ])
    }

    func filterCancel(_ args: [String: Any]) -> Any {
        if let id = args["edit"] as? String, let open = openFilters[id] {
            open.session.cancelFilter()
            openFilters[id] = nil
        }
        return [String: Any]()
    }

    /// Filter › Last Filter (⌃⌘F): the filter again with the settings it had, without a panel.
    func filterRepeat(_ args: [String: Any]) async throws -> Any {
        let kind = try filterKind(args)
        var canRepeat = true
        let result = try await withSession(args) { session in
            if let settings = args["settings"] { session.filterSettings = try self.filterSettings(settings, base: FilterSettings()) }
            session.lastFilter = kind
            canRepeat = session.canRepeatLastFilter
            await session.repeatLastFilter()
            if !canRepeat, session.brushError == nil { session.brushError = "Last Filter can't be applied to this layer." }
        }
        return result
    }

    /// One shot, for automation: begin with `settings`, wait for the result, commit.
    func filterApply(_ args: [String: Any]) async throws -> Any {
        let kind = try filterKind(args)
        return try await withSession(args) { session in
            if let settings = args["settings"] { session.filterSettings = try self.filterSettings(settings, base: FilterSettings()) }
            session.beginFilter(kind)
            guard let edit = session.filterEdit else {
                if session.brushError == nil { session.brushError = "\(kind.rawValue) can't be applied to this layer." }
                return
            }
            await self.settle(edit)
            if let error = edit.previewError, kind.isAutomatic {
                session.cancelFilter()
                session.brushError = error
                return
            }
            await session.commitFilter()
            if session.filterEdit === edit { session.cancelFilter() }
        }
    }

    // MARK: Helpers

    func filterKind(_ args: [String: Any]) throws -> FilterKind {
        guard let name = args["kind"] as? String, let kind = FilterKind(rawValue: name) else {
            throw EngineError.bad("unknown filter \(args["kind"] ?? "")")
        }
        return kind
    }

    func openFilter(_ args: [String: Any]) throws -> OpenFilter {
        guard let id = args["edit"] as? String, let open = openFilters[id], open.session.filterEdit === open.edit else {
            throw EngineError.bad("This filter is no longer open.")
        }
        return open
    }

    /// Each finished render starts the newest pending one, so wait until none is left.
    func settle(_ edit: FilterEdit) async {
        while let task = edit.previewTask { await task.value }
    }

    /// The preview as the app would show it, placed in document space by its transform.
    func previewFields(_ edit: FilterEdit, session: EditorSession, args: [String: Any]) throws -> [String: Any] {
        var result: [String: Any] = [:]
        if let error = edit.previewError { result["error"] = error }
        if let alert = session.brushError { result["alert"] = alert }
        if edit.preview || edit.kind.isAutomatic, let image = edit.preparedPreview, let out = args["out"] as? String {
            try writePNG(image, to: out)
            result["transform"] = try jsonObject(edit.preparedTransform ?? edit.transform)
            result["size"] = [image.width, image.height]
            result["previewScale"] = Double(edit.previewScale)
            result["grown"] = edit.preparedTransform != nil
        }
        return result
    }

    /// Whether the layer the filter works on was changed on disk since the panel opened.
    func targetChanged(_ open: OpenFilter) throws -> Bool {
        guard let then = open.stamp, let now = DiskStamp(open.url) else { return true }
        func record(_ data: Data) -> NSDictionary? {
            let manifest = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let layers = manifest?["layers"] as? [[String: Any]] ?? []
            return layers.first { ($0["id"] as? String)?.uppercased() == open.edit.layerID.uuidString } as NSDictionary?
        }
        guard let a = record(then.manifest), let b = record(now.manifest), a == b else { return true }
        for key in ["imageFile", "maskFile"] {
            if let file = a[key] as? String, then.files[file] != now.files[file] { return true }
        }
        return false
    }

    func jsonObject<T: Encodable>(_ value: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
    }

    // MARK: Settings JSON (filters.md section 17)

    private static let numbers: [(String, WritableKeyPath<FilterSettings, Double>)] = [
        ("radius", \.radius), ("angle", \.angle), ("distance", \.distance), ("progressiveFrom", \.progressiveFrom),
        ("progressiveTo", \.progressiveTo), ("amount", \.amount), ("vignetteAmount", \.vignetteAmount),
        ("vignetteMidpoint", \.vignetteMidpoint), ("vignetteRoundness", \.vignetteRoundness),
        ("vignetteFeather", \.vignetteFeather), ("vignetteHighlights", \.vignetteHighlights),
        ("bloomAmount", \.bloomAmount), ("bloomRadius", \.bloomRadius), ("tonalAmount", \.tonalAmount),
        ("tonalRadius", \.tonalRadius), ("tonalShadows", \.tonalShadows), ("tonalMidtones", \.tonalMidtones),
        ("tonalHighlights", \.tonalHighlights), ("distortion", \.distortion), ("refineEdges", \.refineEdges),
        ("matteContrast", \.matteContrast), ("shiftEdge", \.shiftEdge),
    ]
    private static let flags: [(String, WritableKeyPath<FilterSettings, Bool>)] = [
        ("preserveTransparency", \.preserveTransparency), ("progressiveRadial", \.progressiveRadial),
        ("progressiveInverted", \.progressiveInverted), ("gaussian", \.gaussian), ("monochromatic", \.monochromatic),
    ]
    private static let ditherNumbers: [(String, WritableKeyPath<DitherSettings, Double>)] = [
        ("pixelSize", \.pixelSize), ("cellSize", \.cellSize), ("textSize", \.textSize), ("angle", \.angle),
        ("levels", \.levels), ("diffusion", \.diffusion), ("density", \.density), ("contrast", \.contrast),
    ]
    private static let scanlineNumbers: [(String, WritableKeyPath<ScanlinesSettings, Double>)] = [
        ("lineSpacing", \.lineSpacing), ("thickness", \.thickness), ("glow", \.glow), ("dots", \.dots),
        ("wobble", \.wobble), ("displace", \.displace), ("smoothness", \.smoothness), ("threshold", \.threshold),
        ("split", \.split), ("density", \.density), ("contrast", \.contrast), ("blackLevel", \.blackLevel),
    ]

    /// `json` laid over `base`: present keys replace, absent keys keep (filters.md 17.4). No normalization here;
    /// beginFilter and updateFilter normalize.
    func filterSettings(_ json: Any, base: FilterSettings) throws -> FilterSettings {
        guard let object = json as? [String: Any] else { throw EngineError.bad("settings must be an object") }
        var s = base
        for (key, path) in Self.numbers where object[key] != nil { s[keyPath: path] = try number(object[key]!, "settings.\(key)") }
        for (key, path) in Self.flags where object[key] != nil { s[keyPath: path] = try flag(object[key]!, "settings.\(key)") }
        for key in ["progressiveStart", "progressiveEnd"] where object.keys.contains(key) {
            let point = try optionalPoint(object[key]!, "settings.\(key)")
            if key == "progressiveStart" { s.progressiveStart = point } else { s.progressiveEnd = point }
        }
        if let value = object["vignetteColor"] { s.vignetteColor = try decode(value, "settings.vignetteColor") }
        if let value = object["backgroundQuality"] { s.backgroundQuality = try caseNamed(value, "settings.backgroundQuality") }
        if let value = object["curves"] { s.curves = try merged(s.curves, value, "settings.curves") }
        if let value = object["exposure"] { s.exposure = try merged(s.exposure, value, "settings.exposure") }
        if let value = object["gradientMap"] { s.gradientMap = try merged(s.gradientMap, value, "settings.gradientMap") }
        if let value = object["grain"] { s.grain = try merged(s.grain, value, "settings.grain") }
        if let value = object["blackWhite"] { s.blackWhite = try merged(s.blackWhite, value, "settings.blackWhite") }
        if let value = object["colorBalance"] { s.colorBalance = try merged(s.colorBalance, value, "settings.colorBalance") }
        if let value = object["dither"] {
            guard let d = value as? [String: Any] else { throw EngineError.bad("settings.dither must be an object") }
            for (key, path) in Self.ditherNumbers where d[key] != nil { s.dither[keyPath: path] = try number(d[key]!, "settings.dither.\(key)") }
            if let v = d["style"] { s.dither.style = try caseNamed(v, "settings.dither.style") }
            if let v = d["pixelShape"] { s.dither.pixelShape = try caseNamed(v, "settings.dither.pixelShape") }
            if let v = d["colors"] { s.dither.colors = try caseNamed(v, "settings.dither.colors") }
            if let v = d["dark"] { s.dither.dark = try decode(v, "settings.dither.dark") }
            if let v = d["light"] { s.dither.light = try decode(v, "settings.dither.light") }
            if let v = d["lightOnDark"] { s.dither.lightOnDark = try flag(v, "settings.dither.lightOnDark") }
            if let v = d["characters"] {
                guard let text = v as? String else { throw EngineError.bad("settings.dither.characters must be a string") }
                s.dither.characters = text
            }
        }
        if let value = object["scanlines"] {
            guard let d = value as? [String: Any] else { throw EngineError.bad("settings.scanlines must be an object") }
            for (key, path) in Self.scanlineNumbers where d[key] != nil { s.scanlines[keyPath: path] = try number(d[key]!, "settings.scanlines.\(key)") }
            if let v = d["colors"] { s.scanlines.colors = try caseNamed(v, "settings.scanlines.colors") }
            if let v = d["dark"] { s.scanlines.dark = try decode(v, "settings.scanlines.dark") }
            if let v = d["light"] { s.scanlines.light = try decode(v, "settings.scanlines.light") }
        }
        return s
    }

    /// Every key, so the board can show clamped values and remember them (filters.md 17.4 rule 5).
    func filterSettingsJSON(_ s: FilterSettings) -> [String: Any] {
        var json: [String: Any] = [:]
        for (key, path) in Self.numbers { json[key] = s[keyPath: path] }
        for (key, path) in Self.flags { json[key] = s[keyPath: path] }
        json["progressiveStart"] = s.progressiveStart.map { [Double($0.x), Double($0.y)] } ?? NSNull()
        json["progressiveEnd"] = s.progressiveEnd.map { [Double($0.x), Double($0.y)] } ?? NSNull()
        json["vignetteColor"] = (try? jsonObject(s.vignetteColor)) ?? NSNull()
        json["backgroundQuality"] = "\(s.backgroundQuality)"
        json["curves"] = (try? jsonObject(s.curves)) ?? NSNull()
        json["exposure"] = (try? jsonObject(s.exposure)) ?? NSNull()
        json["gradientMap"] = (try? jsonObject(s.gradientMap)) ?? NSNull()
        json["grain"] = (try? jsonObject(s.grain)) ?? NSNull()
        json["blackWhite"] = (try? jsonObject(s.blackWhite)) ?? NSNull()
        json["colorBalance"] = (try? jsonObject(s.colorBalance)) ?? NSNull()
        var dither: [String: Any] = [:]
        for (key, path) in Self.ditherNumbers { dither[key] = s.dither[keyPath: path] }
        dither["style"] = "\(s.dither.style)"
        dither["pixelShape"] = "\(s.dither.pixelShape)"
        dither["colors"] = "\(s.dither.colors)"
        dither["dark"] = (try? jsonObject(s.dither.dark)) ?? NSNull()
        dither["light"] = (try? jsonObject(s.dither.light)) ?? NSNull()
        dither["lightOnDark"] = s.dither.lightOnDark
        dither["characters"] = s.dither.characters
        json["dither"] = dither
        var scanlines: [String: Any] = [:]
        for (key, path) in Self.scanlineNumbers { scanlines[key] = s.scanlines[keyPath: path] }
        scanlines["colors"] = "\(s.scanlines.colors)"
        scanlines["dark"] = (try? jsonObject(s.scanlines.dark)) ?? NSNull()
        scanlines["light"] = (try? jsonObject(s.scanlines.light)) ?? NSNull()
        json["scanlines"] = scanlines
        return json
    }

    private func isBoolean(_ value: Any) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    private func number(_ value: Any, _ name: String) throws -> Double {
        guard let n = value as? NSNumber, !isBoolean(n) else { throw EngineError.bad("\(name) must be a number") }
        return n.doubleValue
    }

    private func flag(_ value: Any, _ name: String) throws -> Bool {
        guard isBoolean(value), let n = value as? NSNumber else { throw EngineError.bad("\(name) must be a boolean") }
        return n.boolValue
    }

    private func optionalPoint(_ value: Any, _ name: String) throws -> CGPoint? {
        if value is NSNull { return nil }
        guard let pair = value as? [Any], pair.count == 2 else { throw EngineError.bad("\(name) must be [x, y] or null") }
        return CGPoint(x: try number(pair[0], name), y: try number(pair[1], name))
    }

    private func caseNamed<E: CaseIterable>(_ value: Any, _ name: String) throws -> E {
        let names = E.allCases.map { "\($0)" }
        guard let text = value as? String, let match = E.allCases.first(where: { "\($0)" == text }) else {
            throw EngineError.bad("\(name) must be one of \(names.joined(separator: ", "))")
        }
        return match
    }

    private func decode<T: Decodable>(_ value: Any, _ name: String) throws -> T {
        guard JSONSerialization.isValidJSONObject([value]) else { throw EngineError.bad("\(name) is not valid") }
        do { return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)) }
        catch { throw EngineError.bad("\(name) is not valid: \(error.localizedDescription)") }
    }

    /// A Codable sub-object with only some keys given: the base encoded, the given keys laid over it, decoded again.
    private func merged<T: Codable>(_ base: T, _ value: Any, _ name: String) throws -> T {
        guard let patch = value as? [String: Any] else { throw EngineError.bad("\(name) must be an object") }
        var object = (try JSONSerialization.jsonObject(with: JSONEncoder().encode(base)) as? [String: Any]) ?? [:]
        for (key, item) in patch { object[key] = item }
        return try decode(object, name)
    }
}

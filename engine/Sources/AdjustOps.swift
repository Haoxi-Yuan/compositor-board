// Adjustment layers and Image-menu adjustments (docs/port-specs/adjustments-effects.md section 10, filters.md section 5).
// The board draws adjustment layers itself with ports of Compositor's kernels; the engine adds the layers, measures
// the Levels histogram (of a layer's pixels, or of what lies under an adjustment layer), and applies destructive
// Levels and Hue/Saturation through the app's own edits. `adjustment.lut` returns the lookup tables the app builds,
// for the board's conformance tests.
import AppKit
import CoreGraphics
import Foundation

extension EngineOperations {
    func adjustOperation(_ op: String, _ args: [String: Any]) async throws -> Any? {
        switch op {
        case "adjustment.add": return try await adjustmentAdd(args)
        case "levels.histogram": return try await levelsHistogram(args)
        case "levels.apply": return try await withSession(args) { session in
            session.beginLevels()
            guard let edit = session.levels else {
                if session.brushError == nil { session.brushError = "Levels can't be applied to this layer." }
                return
            }
            edit.settings = try self.decoded(LevelsSettings.self, args["levels"], "levels")
            await session.commitLevels()
        }
        case "hueSaturation.apply": return try await withSession(args) { session in
            session.beginHueSaturation()
            guard session.hueSaturation != nil else {
                if session.brushError == nil { session.brushError = "Hue/Saturation can't be applied to this layer." }
                return
            }
            session.updateHueSaturation(try self.decoded(HueSaturationSettings.self, args["hueSaturation"], "hueSaturation"), preview: false)
            await session.commitHueSaturation()
        }
        case "adjustment.lut": return try adjustmentLUT(args)
        default: return nil
        }
    }

    /// Layer › New Adjustment Layer (LayerAdjustment.swift:208-229): the record, its place and its undo step are the
    /// app's; the board opens its own editor afterwards.
    func adjustmentAdd(_ args: [String: Any]) async throws -> Any {
        guard let name = args["kind"] as? String, let kind = AdjustmentKind(rawValue: name) else {
            throw EngineError.bad("unknown adjustment \(args["kind"] ?? "")")
        }
        var added: String?
        var result = try await withSession(args) { session in
            let before = session.document?.layers.count ?? 0
            session.addAdjustment(kind)
            if (session.document?.layers.count ?? 0) > before { added = session.activeLayerID?.uuidString }
        } as? [String: Any] ?? [:]
        if let added { result["layerID"] = added }
        result["opensEditor"] = kind.isEditable
        return result
    }

    /// The Levels histogram as the panel shows it (LevelsEdit.histogram): of the active layer's pixels weighted by alpha
    /// and the selection, or, with `layerID` naming a Levels adjustment layer, of the visible layers under it
    /// (AdjustmentEditing.swift:12-37). Saves nothing.
    func levelsHistogram(_ args: [String: Any]) async throws -> Any {
        let (session, _) = try await session(args)
        configure(session, args)
        if let id = uuid(args["layerID"]), session.document?.layers.first(where: { $0.id == id })?.adjustment != nil {
            session.adjustmentEditingID = id
            await session.beginAdjustmentEditing(id)
        } else {
            session.beginLevels()
        }
        guard let edit = session.levels else {
            return ["error": session.brushError ?? "Levels can't be used on this layer."]
        }
        await edit.histogramTask?.value
        return ["bins": edit.histogram, "ready": edit.histogramReady]
    }

    /// The tables Compositor builds for an adjustment (adjustments-effects.md 10.6), to check the board's ports.
    func adjustmentLUT(_ args: [String: Any]) throws -> Any {
        let adjustment = try decoded(LayerAdjustment.self, args["adjustment"], "adjustment")
        switch adjustment.kind {
        case .levels:
            return ["tables": [LevelsChannel.red, .green, .blue].flatMap { channel in
                (0...255).map { Double(Float(adjustment.levels.apply(Double($0) / 255, channel: channel))) }
            }]
        case .curves:
            let curves = adjustment.curves
            return ["tables": (1...3).flatMap { channel in
                (0...255).map { Double(Float(curves.value(curves.value(Double($0), channel: channel), channel: 0) / 255)) }
            }]
        case .exposure:
            let table = adjustment.exposure.table.map { Double($0) }
            return ["tables": table + table + table]
        case .gradientMap:
            let (dark, light) = adjustment.gradientMap.ends
            func channel(_ from: Double, _ to: Double, _ t: Double) -> Int {
                let value: Double = from + (to - from) * t
                return Int(min(255.0, max(0.0, (value * 255).rounded())))
            }
            var table: [Int] = []
            for index in 0...255 {
                let t = Double(index) / 255
                table += [channel(dark.red, light.red, t), channel(dark.green, light.green, t), channel(dark.blue, light.blue, t)]
            }
            return ["table": table]
        case .hsv:
            let cube = HueSaturationFilter.cube(adjustment.resolvedHSV)
            let values = cube.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }.map { Double($0) }
            return ["dimension": HueSaturationFilter.dimension, "cube": values]
        default:
            throw EngineError.bad("no lookup table for \(adjustment.kind.rawValue)")
        }
    }

    /// A Codable value from the request, with the app's own decoder (so manifest-shaped JSON decodes as it loads).
    func decoded<T: Decodable>(_ type: T.Type, _ value: Any?, _ name: String) throws -> T {
        guard let value, JSONSerialization.isValidJSONObject([value]) else { throw EngineError.bad("missing \(name)") }
        do { return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)) }
        catch { throw EngineError.bad("bad settings: \(name)") }
    }
}

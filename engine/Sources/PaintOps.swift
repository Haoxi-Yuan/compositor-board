// Paint tools (docs/port-specs/paint-tools.md section 8): strokes replayed through EditorSession, gradients, color samples.
// A stroke arrives as the points the canvas would have handed EditorSession (the press, every drag point after the
// Shift axis lock, the raw release), so beginBrush / continueBrush / finishBrushImmediately reproduce it exactly:
// Spot Healing's patch search, Clone Stamp's sample, Blur's softened copy, Smudge and Liquify on the GPU, and the
// commit with its growth, mask and 16-bit rules (Document/EditorSession+Brush.swift, SmudgeLiquify.swift, Gradient.swift).
import AppKit
import CoreGraphics
import Foundation

extension EngineOperations {
    func paintOperation(_ op: String, _ args: [String: Any]) async throws -> Any? {
        switch op {
        case "paint.stroke": return try await paintStroke(args)
        case "paint.gradient": return try await withSession(args) { session in try await self.gradient(session, args) }
        case "color.sample": return try await colorSample(args)
        case "paint.limits":
            return ["documentPixelBudget": DocumentLimits.documentPixelBudget,
                    "documentBudgetMegapixels": DocumentLimits.documentBudgetMegapixels,
                    "maxSide": 30_000, "maxSurfacePixels": DocumentLimits.maxSurfacePixels,
                    "maxBrushDiameter": Double(BrushStroke.maxDiameter)]
        default: return nil
        }
    }

    func points(_ value: Any?) -> [CGPoint] {
        guard let list = value as? [Any] else { return [] }
        return list.compactMap { item in
            guard let p = item as? [Any], p.count == 2, let x = double(p[0]), let y = double(p[1]), x.isFinite, y.isFinite else { return nil }
            return CGPoint(x: x, y: y)
        }
    }

    /// One stroke of Brush, Spot Healing, Clone Stamp or Smear (section 8.1).
    func paintStroke(_ args: [String: Any]) async throws -> Any {
        let points = points(args["points"])
        guard let first = points.first else { throw EngineError.bad("missing points") }
        var cloneOffset: CGSize?
        var result = try await withSession(args) { session in
            switch args["tool"] as? String ?? "brush" {
            case "spotHealing": session.tool = .spotHealing
            case "cloneStamp": session.tool = .cloneStamp
            case "smear", "blur": session.tool = .blur
            default: session.tool = .brush
            }
            session.brushMode = args["mode"] as? String == "Erase" ? .erase : .paint
            session.spotHealingMode = SpotHealingMode(rawValue: args["healingType"] as? String ?? "") ?? .contentAware
            session.blurMode = BlurToolMode(rawValue: args["smearMode"] as? String ?? "") ?? .liquify
            // configure() set the foreground, which lives in brushSettings: keep it.
            var settings = session.brushSettings
            if let v = double(args["diameter"]) { settings.diameter = CGFloat(v) }
            if let v = double(args["hardness"]) { settings.hardness = CGFloat(v) }
            if let v = double(args["opacity"]) { settings.opacity = CGFloat(v) }
            if let v = double(args["smoothing"]) { settings.smoothing = CGFloat(v) }
            if let v = double(args["blurRadius"]) { settings.blurRadius = CGFloat(v) }
            session.brushSettings = settings
            if let document = session.document, let zoom = double(args["zoom"]), zoom > 0 {
                session.viewport.setZoom(CGFloat(zoom), anchoredAt: .zero, documentSize: document.size)
            }
            session.cloneSettings = CloneSettings(aligned: args["aligned"] as? Bool ?? true,
                                                  sampleAllLayers: args["sampleAllLayers"] as? Bool ?? false)
            session.cloneSource = self.points([args["cloneSource"]].compactMap { $0 }).first
            if let o = args["cloneOffset"] as? [Any], o.count == 2, let dx = double(o[0]), let dy = double(o[1]) {
                session.cloneOffset = CGSize(width: dx, height: dy)
            } else {
                session.cloneOffset = nil
            }
            session.beginBrush(at: first)
            if session.brushStroke != nil || session.warpStroke != nil {
                for point in points.dropFirst() { session.continueBrush(at: point) }
                session.finishBrushImmediately()
            }
            cloneOffset = session.cloneOffset
        }
        if let cloneOffset, var answer = result as? [String: Any] {
            answer["cloneOffset"] = [Double(cloneOffset.width), Double(cloneOffset.height)]
            result = answer
        }
        return result
    }

    /// A gradient from `start` to `end`, applied as the header's Apply does (section 8.2).
    func gradient(_ session: EditorSession, _ args: [String: Any]) async throws {
        let ends = points([args["start"], args["end"]].compactMap { $0 })
        guard ends.count == 2 else { throw EngineError.bad("missing start and end") }
        session.tool = .gradient
        session.gradientSettings = GradientSettings(
            shape: GradientShape(rawValue: args["shape"] as? String ?? "") ?? .linear,
            style: GradientStyle(rawValue: args["colors"] as? String ?? "") ?? .foregroundToTransparent,
            reversed: args["reverse"] as? Bool ?? false,
            opacity: CGFloat(min(1, max(0.01, double(args["opacity"]) ?? 1))))
        session.beginGradient(at: ends[0])
        // A refusal or the pixel budget leaves the error in brushError.
        guard session.gradientEdit != nil else { return }
        session.moveGradient(end: ends[1])
        await session.commitGradient()
    }

    /// The composite color under a document point as Compositor's eyedropper reads it (section 8.3).
    func colorSample(_ args: [String: Any]) async throws -> Any {
        let (session, _) = try await session(args)
        configure(session, args)
        guard let color = session.sampleCompositeColor(at: try point(args)) else { return ["color": NSNull()] }
        let byte = { (v: CGFloat) in Int((v * 255).rounded()) }
        return ["color": [Double(color.red), Double(color.green), Double(color.blue)],
                "hex": String(format: "%02X%02X%02X", byte(color.red), byte(color.green), byte(color.blue))]
    }
}

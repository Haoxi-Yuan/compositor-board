// Selection operations for the board, run through Compositor's own EditorSession (Document/Selection.swift,
// MagicWand.swift, ObjectSelection.swift, SubjectRemoval.swift, MaskTracing.swift, SelectionEdits.swift,
// SelectionClipboard.swift, FloatingSelection.swift, LayerMask.swift). The board keeps the selection, which Compositor
// never saves, and sends it with every request; each answer returns the selection as it now stands. Specification:
// docs/port-specs/selection.md, section 7.
import AppKit
import CoreGraphics
import Foundation

extension EngineOperations {
    func selectionOperation(_ op: String, _ args: [String: Any]) async throws -> Any? {
        switch op {
        case "selection.combine": return try combine(args)
        case "selection.invert": return try invert(args)
        case "selection.expand": return try resize(args, by: 1)
        case "selection.contract": return try resize(args, by: -1)
        case "selection.wand": return try await withSession(args) { session in
            session.wandSettings = WandSettings(
                tolerance: max(0, min(255, int(args["tolerance"]) ?? 32)),
                sampleSize: WandSampleSize(rawValue: max(0, min(2, int(args["sampleSize"]) ?? 0))) ?? .point,
                contiguous: args["contiguous"] as? Bool ?? true,
                sampleAllLayers: args["sampleAllLayers"] as? Bool ?? false)
            await session.magicWand(at: try point(args), mode: try mode(args))
        }
        case "selection.object": return try await withSession(args) { session in
            session.objectSelectionSettings = ObjectSelectionSettings(
                sampleAllLayers: args["sampleAllLayers"] as? Bool ?? true,
                edgeOffset: max(-10, min(10, int(args["edgeOffset"]) ?? 0)))
            await session.selectObject(at: try point(args), mode: try mode(args))
        }
        case "selection.subject": return try await withSession(args) { session in
            await session.selectSubject(mode: try mode(args))
        }
        case "selection.colorRangeSample": return try await colorRangeSample(args)
        case "selection.colorRange": return try await withSession(args) { session in try self.colorRange(session, args) }
        case "selection.loadLayer": return try await withSession(args) { session in
            guard let id = uuid(args["layerID"]) else { throw EngineError.bad("missing layerID") }
            session.loadLayerSelection(layerID: id, mode: try mode(args))
        }
        case "selection.loadMask": return try await withSession(args) { session in
            guard let id = uuid(args["layerID"]) else { throw EngineError.bad("missing layerID") }
            session.loadMaskSelection(layerID: id, mode: try mode(args))
        }
        case "selection.fill": return try await withSession(args) { session in
            await session.fillSelection(with: args["source"] as? String == "background" ? .background : .foreground)
        }
        case "selection.clear": return try await withSession(args) { session in await session.clearSelectedPixels() }
        case "selection.invertPixels": return try await withSession(args) { session in await session.invertPixels() }
        case "selection.copy": return try await copy(args, cut: false)
        case "selection.cut": return try await copy(args, cut: true)
        case "selection.paste": return try await paste(args)
        case "selection.layerViaCopy": return try await withSession(args) { session in session.layerViaCopy() }
        case "selection.movePixels": return try await withSession(args) { session in
            guard session.beginPixelMove(duplicate: args["duplicate"] as? Bool ?? false) else {
                throw EngineError.bad("These pixels can't be moved: select pixels on a layer that has them (not a mask).")
            }
            session.movePixels(by: CGSize(width: double(args["dx"]) ?? 0, height: double(args["dy"]) ?? 0))
            await session.finishPixelMove()
        }
        case "selection.nudgePixels": return try await withSession(args) { session in
            await session.nudgePixels(dx: CGFloat(double(args["dx"]) ?? 0), dy: CGFloat(double(args["dy"]) ?? 0))
        }
        case "selection.float": return try await float(args)
        case "selection.transform": return try await withSession(args) { session in
            guard session.canTransformSelection else { throw EngineError.bad("Select pixels on a layer that has them to transform them.") }
            await session.beginSelectionTransform()
            guard let edit = session.transformEdit, edit.floating != nil else { throw EngineError.bad(session.brushError ?? "Could not lift the selected pixels.") }
            if let draft = args["draft"] as? [String: Any] { session.previewTransform(try transform(draft)) }
            if let corners = args["corners"] as? [[Any]], corners.count == 4 {
                session.transformEdit?.corners = corners.map { CGPoint(x: ($0[0] as? NSNumber)?.doubleValue ?? 0, y: ($0[1] as? NSNumber)?.doubleValue ?? 0) }
            }
            session.commitTransform()
        }
        case "selection.addMask": return try await withSession(args) { session in
            session.addMask(revealing: args["revealing"] as? Bool ?? true)
        }
        default: return nil
        }
    }

    // MARK: Request plumbing

    func int(_ value: Any?) -> Int? { (value as? NSNumber)?.intValue }
    func double(_ value: Any?) -> Double? { (value as? NSNumber)?.doubleValue }
    func uuid(_ value: Any?) -> UUID? { (value as? String).flatMap(UUID.init(uuidString:)) }

    func point(_ args: [String: Any]) throws -> CGPoint {
        guard let p = args["point"] as? [Any], p.count == 2, let x = double(p[0]), let y = double(p[1]) else { throw EngineError.bad("missing point") }
        return CGPoint(x: x, y: y)
    }

    func mode(_ args: [String: Any]) throws -> SelectionMode {
        switch args["mode"] as? String ?? "New" {
        case "New", "replace": return .replace
        case "Add", "add": return .add
        case "Subtract", "subtract": return .subtract
        default: throw EngineError.bad("mode must be New, Add or Subtract")
        }
    }

    func color(_ value: Any?) -> PaletteColor? {
        guard let c = value as? [Any], c.count >= 3 else { return nil }
        return PaletteColor(red: CGFloat(double(c[0]) ?? 0), green: CGFloat(double(c[1]) ?? 0), blue: CGFloat(double(c[2]) ?? 0))
    }

    func transform(_ json: [String: Any]) throws -> LayerTransform {
        let data = try JSONSerialization.data(withJSONObject: json)
        return try JSONDecoder().decode(LayerTransform.self, from: data)
    }

    /// Loads the project into a session set up like the board (active layer, mask target, selection, the selection
    /// and color options), runs `body`, saves if the document changed, and reports the selection that results.
    func withSession(_ args: [String: Any], _ body: (EditorSession) async throws -> Void) async throws -> Any {
        let (session, url) = try await session(args)
        configure(session, args)
        let before = session.document
        try await body(session)
        let saved = try await saveIfChanged(session, from: before, to: url)
        var result = outcome(session, saved: saved, args: args)
        if saved { result["changedFiles"] = changedFiles(session, from: before) }
        return result
    }

    /// The image and mask files a saved edit actually changed or added: the package is rewritten whole, so the board
    /// is told which files to read again (layers-masks.md 19.3).
    func changedFiles(_ session: EditorSession, from before: CanvasDocument?) -> [String] {
        guard let now = session.document else { return [] }
        let then = Dictionary((before?.layers ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var files: [String] = []
        for layer in now.layers {
            let old = then[layer.id]
            if let asset = layer.asset, !(old?.asset.map { $0.image === asset.image && $0.deep === asset.deep } ?? false) {
                files.append(asset.file(for: layer.id))
            }
            if let mask = layer.mask, !(old?.mask.map { $0.asset.image === mask.asset.image } ?? false) {
                files.append("\(layer.id.uuidString).mask.png")
            }
        }
        return files
    }

    /// Saves when the document differs from `before` in anything but the selection, which is not part of the file.
    func saveIfChanged(_ session: EditorSession, from before: CanvasDocument?, to url: URL) async throws -> Bool {
        guard var now = session.document, var then = before else { return false }
        now.selection = nil
        then.selection = nil
        // ImageLayer equality looks at the 8-bit image only; a depth conversion changes just the 16-bit pixels.
        let deepChanged = now.layers.contains { layer in
            let old = then.layers.first { $0.id == layer.id }
            return old.map { $0.asset?.deep !== layer.asset?.deep } ?? false
        }
        guard now != then || deepChanged else { return false }
        try await save(session, to: url)
        return true
    }

    /// The board's state that a session reads besides the document: mask target, selection and palette options.
    func configure(_ session: EditorSession, _ args: [String: Any]) {
        // The mask can only be the target of a layer that has one, as in the app.
        if let mask = args["isMaskSelected"] as? Bool { session.isMaskSelected = mask && session.activeLayer?.mask != nil }
        if let antialiased = args["antialiased"] as? Bool { session.selectionAntialiased = antialiased }
        if let foreground = color(args["foreground"]) { session.foregroundColor = foreground }
        if let background = color(args["background"]) { session.backgroundColor = background }
        if let white = args["maskPaintWhite"] as? Bool { session.maskPaintWhite = white }
        session.brushError = nil
    }

    func outcome(_ session: EditorSession, saved: Bool, args: [String: Any], extra: [String: Any] = [:]) -> [String: Any] {
        var result: [String: Any] = ["saved": saved, "isMaskSelected": session.isMaskSelected]
        // The undo step's name as the app gives it ("Fill Mask", "Copy Layers from Project"), for the board's history.
        if saved, !session.history.undoName.isEmpty { result["editName"] = session.history.undoName }
        result["selection"] = selectionAnswer(session.document?.selection, args: args)
        if let id = session.activeLayerID { result["activeLayerID"] = id.uuidString }
        result["selectedLayerIDs"] = session.selectedLayerIDs.map(\.uuidString)
        result["collapsedGroupIDs"] = session.collapsedGroupIDs.map(\.uuidString)
        if let error = session.brushError { result["error"] = error }
        for (key, value) in extra { result[key] = value }
        return result
    }

    /// A selection inline, or, past a few hundred thousand path elements (a wand outline can have millions), as a
    /// file the board reads, named by `selectionOut`.
    func selectionAnswer(_ selection: DocumentSelection?, args: [String: Any]) -> Any {
        let json = selectionJSON(selection)
        guard let selection, let out = args["selectionOut"] as? String else { return json }
        var count = 0
        selection.path.applyWithBlock { _ in count += 1 }
        guard count > 200_000, let data = try? JSONSerialization.data(withJSONObject: json),
              (try? data.write(to: URL(fileURLWithPath: out))) != nil else { return json }
        return ["file": true]
    }

    // MARK: Geometry (applySelection, invertSelection, resizeSelection: the same Core Graphics calls)

    func canvas(_ args: [String: Any]) throws -> CGPath {
        guard let width = double(args["width"]), let height = double(args["height"]), width > 0, height > 0 else { throw EngineError.bad("missing width and height") }
        return CGPath(rect: CGRect(x: 0, y: 0, width: width, height: height), transform: nil)
    }

    func combine(_ args: [String: Any]) throws -> Any {
        let canvas = try canvas(args)
        guard let elements = args["shape"] as? [[Any]] else { throw EngineError.bad("missing shape") }
        let current = try selection(from: args["selection"])
        let clipped = try path(from: elements).intersection(canvas, using: .winding)
        let antialiased = args["antialiased"] as? Bool ?? true
        let result: CGPath
        switch try mode(args) {
        case .replace: result = clipped
        case .add: result = current.map { $0.path.union(clipped, using: .winding) } ?? clipped
        case .subtract:
            // Subtracting from no selection selects nothing new, so nothing changes.
            guard let current else { return ["unchanged": true, "selection": NSNull()] }
            result = current.path.subtracting(clipped, using: .winding)
        }
        return ["selection": selectionAnswer(DocumentSelection(path: result, antialiased: antialiased), args: args)]
    }

    func invert(_ args: [String: Any]) throws -> Any {
        let canvas = try canvas(args)
        guard let current = try selection(from: args["selection"]) else { return ["unchanged": true, "selection": NSNull()] }
        let inverse = DocumentSelection(path: canvas.subtracting(current.path, using: .winding), antialiased: current.antialiased,
                                        feather: current.feather)
        // The inverse of everything is no selection at all, not an invisible empty one.
        return ["selection": inverse.isEmpty ? NSNull() : selectionAnswer(inverse, args: args)]
    }

    func resize(_ args: [String: Any], by sign: CGFloat) throws -> Any {
        let canvas = try canvas(args)
        guard let current = try selection(from: args["selection"]), !current.isEmpty else { return ["unchanged": true, "selection": selectionJSON(nil)] }
        let delta = sign * CGFloat(int(args["amount"]) ?? 0)
        guard delta != 0, abs(delta) <= 500 else { throw EngineError.bad("amount must be 1 to 500") }
        // A band `|delta|` wide on each side of the outline, added or removed.
        let band = current.path.copy(strokingWithWidth: abs(delta) * 2, lineCap: .round, lineJoin: .round, miterLimit: 10)
        let result = delta > 0
            ? current.path.union(band, using: .winding).intersection(canvas, using: .winding)
            : current.path.subtracting(band, using: .winding)
        return ["selection": selectionAnswer(DocumentSelection(path: result, antialiased: current.antialiased, feather: current.feather), args: args)]
    }

    // MARK: Color Range (ColorRangeSelection.swift: sampling and colorRangeMask, which are private there)

    func colorRangeSample(_ args: [String: Any]) async throws -> Any {
        let (session, _) = try await session(args)
        guard let document = session.document, let image = session.selectionSample(document, sampleAllLayers: true) else { return ["color": NSNull()] }
        let p = try point(args)
        let x = Int(floor(p.x)), y = Int(floor(p.y))
        guard p.x.isFinite, p.y.isFinite, (0..<image.width).contains(x), (0..<image.height).contains(y) else { return ["color": NSNull()] }
        let context = try BrushRaster.context(width: 3, height: 3, mask: false)
        BrushRaster.draw(image, in: CGRect(x: 1 - x, y: 1 - y, width: image.width, height: image.height), mask: false, context: context)
        guard let data = context.data?.assumingMemoryBound(to: UInt8.self) else { return ["color": NSNull()] }
        var sums = [0, 0, 0, 0]
        for row in 0..<3 {
            for column in 0..<3 {
                for channel in 0..<4 { sums[channel] += Int(data[row * context.bytesPerRow + column * 4 + channel]) }
            }
        }
        guard sums[3] > 0 else { return ["color": NSNull()] }
        return ["color": (0..<3).map { min(255, (sums[$0] * 255 + sums[3] / 2) / sums[3]) }]
    }

    func colorRange(_ session: EditorSession, _ args: [String: Any]) throws {
        guard let document = session.document, let image = session.selectionSample(document, sampleAllLayers: true) else { return }
        let include = (args["include"] as? [Any] ?? []).compactMap { int($0) }.map { UInt8(max(0, min(255, $0))) }
        let exclude = (args["exclude"] as? [Any] ?? []).compactMap { int($0) }.map { UInt8(max(0, min(255, $0))) }
        let fuzziness = Int32(max(0, min(200, (double(args["fuzziness"]) ?? 40).rounded())))
        let width = image.width, height = image.height
        let context = try BrushRaster.context(width: width, height: height, mask: false)
        BrushRaster.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height), mask: false, context: context)
        guard let data = context.data else { throw ExportError.render }
        var mask = [UInt8](repeating: 0, count: width * height)
        _ = mask.withUnsafeMutableBufferPointer { out in
            include.withUnsafeBufferPointer { includeBuffer in
                exclude.withUnsafeBufferPointer { excludeBuffer in
                    color_range_mask(data.assumingMemoryBound(to: UInt8.self), width, height, context.bytesPerRow,
                                     includeBuffer.baseAddress, Int32(include.count / 3), excludeBuffer.baseAddress, Int32(exclude.count / 3),
                                     fuzziness, (args["invert"] as? Bool ?? false) ? 1 : 0, out.baseAddress)
                }
            }
        }
        // As commitColorRange: the result replaces the selection; nothing matched means no selection.
        if mask.contains(where: { $0 != 0 }), let path = try MagicWand.outline(of: mask, width: width, height: height) {
            session.document?.selection = DocumentSelection(path: path, antialiased: session.selectionAntialiased)
        } else {
            session.document?.selection = nil
        }
    }

    // MARK: Clipboard (SelectionClipboard.swift, with the board owning when to paste in place)

    /// Copy / Copy Merged / Cut: the selected pixels as Compositor renders them, written to `out` and to the system
    /// pasteboard as PNG (as the app's Copy does). Without a selection on a layer the layer itself is also remembered,
    /// so Paste duplicates it whole.
    func copy(_ args: [String: Any], cut: Bool) async throws -> Any {
        let merged = args["merged"] as? Bool ?? false
        var extra: [String: Any] = [:]
        let result = try await withSession(args) { session in
            guard session.selection?.isEmpty != true else { throw EngineError.bad("Nothing is selected.") }
            let rendered: (image: CGImage, region: CGRect)?
            if merged { rendered = try session.renderMergedPixels() }
            else if let layer = session.activeLayer, layer.asset != nil || session.isMaskSelected {
                rendered = try session.renderSelectedPixels(from: layer, mask: session.isMaskSelected)
            } else { rendered = nil }
            let pasteboard = NSPasteboard.general
            if let rendered {
                if let out = args["out"] as? String { try self.writePNG(rendered.image, to: out) }
                pasteboard.clearContents()
                if let png = NSBitmapImageRep(cgImage: rendered.image).representation(using: .png, properties: [:]) {
                    pasteboard.setData(png, forType: .png)
                }
                extra["origin"] = [Double(rendered.region.minX), Double(rendered.region.minY)]
                extra["size"] = [rendered.image.width, rendered.image.height]
            } else if session.selection == nil, session.activeLayer != nil {
                pasteboard.clearContents()
                pasteboard.setString(session.activeLayerID?.uuidString ?? "", forType: NSPasteboard.PasteboardType("com.compositor.copied-layer"))
            } else {
                throw EngineError.bad("There is nothing to copy here.")
            }
            extra["changeCount"] = pasteboard.changeCount
            if !merged, session.selection == nil, let id = session.activeLayerID { extra["copiedLayerIDs"] = [id.uuidString] }
            if session.selection == nil, session.selectedLayerIDs.count > 1 { extra["copiedLayerIDs"] = session.selectedLayerIDs.map(\.uuidString) }
            if cut {
                guard session.selection != nil else { throw EngineError.bad("Cut needs a selection.") }
                await session.clearSelectedPixels()
            }
        }
        guard var answer = result as? [String: Any] else { return result }
        for (key, value) in extra { answer[key] = value }
        return answer
    }

    /// Paste: layers copied in this project are duplicated whole, and layers copied in another board's project are
    /// brought over complete; pixels the board copied from this project, with the pasteboard unchanged since, land in
    /// place; any other image on the pasteboard lands centered.
    func paste(_ args: [String: Any]) async throws -> Any {
        let pasteboard = NSPasteboard.general
        let clip = args["clip"] as? [String: Any] ?? [:]
        let fresh = int(clip["changeCount"]) == pasteboard.changeCount
        // Layers copied in another project: that project is read as it stands on disk (its board saved it first).
        var source: EditorSession?
        if fresh, let other = clip["project"] as? String, other != args["project"] as? String,
           clip["copiedLayerIDs"] is [String], FileManager.default.fileExists(atPath: other) {
            source = try await session(["project": other]).0
        }
        return try await withSession(args) { session in
            guard let document = session.document else { return }
            if fresh, clip["project"] as? String == args["project"] as? String, let ids = clip["copiedLayerIDs"] as? [String] {
                let present = ids.compactMap(UUID.init(uuidString:)).filter { id in document.layers.contains { $0.id == id } }
                if !present.isEmpty {
                    session.duplicateLayers(present, editName: "Paste")
                    return
                }
            }
            if let source, let ids = clip["copiedLayerIDs"] as? [String], let layers = source.document?.layers {
                let present = ids.compactMap(UUID.init(uuidString:)).filter { id in layers.contains { $0.id == id } }
                if !present.isEmpty {
                    try await Self.copyLayers(present, from: source, into: session)
                    return
                }
            }
            guard let image = Self.pasteboardImage(pasteboard) else { throw EngineError.bad("There is no image on the clipboard to paste.") }
            var origin = CGPoint(x: floor((CGFloat(document.width) - CGFloat(image.width)) / 2),
                                 y: floor((CGFloat(document.height) - CGFloat(image.height)) / 2))
            if fresh, clip["project"] as? String == args["project"] as? String, let o = clip["origin"] as? [Any], o.count == 2 {
                origin = CGPoint(x: double(o[0]) ?? origin.x, y: double(o[1]) ?? origin.y)
            }
            session.addPixelLayer(image, at: origin, name: session.nextLayerName(), editName: "Paste")
        }
    }

    /// ProjectWorkspace.copyLayers: layers (folders with all they hold) copied into another project as one undo step
    /// "Copy Layers from Project", keeping where they sit relative to each other, centered on the canvas; a layer
    /// clipped to one left behind takes its clipped look as its own pixels.
    static func copyLayers(_ ids: [UUID], from source: EditorSession, into target: EditorSession) async throws {
        guard let id = ids.first, source.canEditLayers, target.canEditLayers, let snapshot = source.projectSnapshot(),
              let sourceDocument = source.document, let targetDocument = target.document else { return }
        let included = ids.reduce(into: Set(ids)) { $0.formUnion(source.descendantIDs(of: $1)) }
        var copied = sourceDocument.layers.filter { included.contains($0.id) }
        let used = targetDocument.layers.reduce(0) { $0 + ($1.asset.map { $0.image.width * $0.image.height } ?? 0) }
        let added = copied.reduce(0) { $0 + ($1.asset.map { $0.image.width * $0.image.height } ?? 0) }
        guard used + added <= DocumentLimits.documentPixelBudget else {
            target.brushError = "The copied layers exceed this project’s \(DocumentLimits.documentBudgetMegapixels)-megapixel limit."
            return
        }
        for i in copied.indices where copied[i].maskSourceID.map({ !included.contains($0) }) == true {
            if copied[i].adjustment != nil { copied[i].maskSourceID = nil; continue }
            let layerID = copied[i].id
            copied[i].asset = try await Task.detached(priority: .userInitiated) { try LiveMaskBaker.bake(snapshot, target: layerID) }.value
            copied[i].maskSourceID = nil
        }
        let mapping = Dictionary(uniqueKeysWithValues: copied.map { ($0.id, UUID()) })
        let pictured = copied.filter { !$0.isGroup }.map { CGRect(origin: $0.transform.origin, size: $0.transform.size) }
        let size = targetDocument.size
        let anchor = ids.count == 1 || pictured.isEmpty
            ? copied.first(where: { $0.id == id })?.transform.center ?? CGPoint(x: sourceDocument.size.width / 2, y: sourceDocument.size.height / 2)
            : { let r = pictured.dropFirst().reduce(pictured[0]) { $0.union($1) }; return CGPoint(x: r.midX, y: r.midY) }()
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let layers = copied.map { layer -> ImageLayer in
            var transform = layer.transform
            transform.origin.x += center.x - anchor.x; transform.origin.y += center.y - anchor.y
            var mask = layer.mask
            mask?.placement?.origin.x += center.x - anchor.x; mask?.placement?.origin.y += center.y - anchor.y
            return ImageLayer(id: mapping[layer.id]!, asset: layer.asset, name: layer.name, isVisible: layer.isVisible,
                              transform: transform, parentID: layer.parentID.flatMap { mapping[$0] }, isGroup: layer.isGroup,
                              opacity: layer.opacity, blendMode: layer.blendMode, mask: mask,
                              maskSourceID: layer.maskSourceID.flatMap { mapping[$0] }, adjustment: layer.adjustment,
                              shape: layer.shape, effects: layer.effects, text: layer.text)
        }
        target.beginEdit("Copy Layers from Project")
        target.document?.layers.append(contentsOf: layers)
        target.activeLayerID = mapping[id]
        target.selectedLayerIDs = Set(ids.compactMap { mapping[$0] })
        target.endEdit()
    }

    /// The pasteboard's image in sRGB RGBA, as the app's Paste converts it.
    static func pasteboardImage(_ pasteboard: NSPasteboard) -> CGImage? {
        guard let image = NSImage(pasteboard: pasteboard), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        guard let context = CGContext(data: nil, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: cg.width * 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return nil }
        context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        return context.makeImage()
    }

    /// The selected pixels of the active layer, lifted for the board to preview a ⌘T transform (nothing is saved).
    func float(_ args: [String: Any]) async throws -> Any {
        let (session, _) = try await session(args)
        guard session.canTransformSelection, let layer = session.activeLayer,
              let lifted = try session.renderSelectedPixels(from: layer, mask: false), let out = args["out"] as? String else {
            throw EngineError.bad("Select pixels on a layer that has them to transform them.")
        }
        try writePNG(lifted.image, to: out)
        return ["origin": [Double(lifted.region.minX), Double(lifted.region.minY)], "size": [lifted.image.width, lifted.image.height]]
    }
}

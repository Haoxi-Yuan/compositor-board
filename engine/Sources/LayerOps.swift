// Layer structure for the board (upstream Document/LayerGroups.swift, SelectionClipboard.swift, LayerMask.swift,
// LayerMerge.swift, LiveLayerMask.swift, DeepLayers.swift, UI/NativeLayerList.swift `place`). Edits that only
// rearrange records run in a "structure session": the board's current manifest with stand-in pixels of the right
// sizes, so nothing is read from or written to the package; the board applies the resulting records as one undo step.
// Edits that read pixels (merge, depth conversion, bake on delete) run in a full session and save. Specification:
// docs/port-specs/layers-masks.md, section 19.
import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

extension EngineOperations {
    func layerOperation(_ op: String, _ args: [String: Any]) async throws -> Any? {
        switch op {
        case "layer.group": return try structure(args) { $0.groupSelectedLayers() }
        case "layer.ungroup": return try structure(args) { $0.ungroupLayers() }
        case "layer.moveOutOfFolder": return try structure(args) { $0.moveActiveLayerOutOfGroup() }
        case "layer.place": return try structure(args) { self.place($0, args) }
        case "layer.duplicate": return try structure(args) { session in
            if let ids = args["ids"] as? [String] {
                session.duplicateLayers(ids.compactMap(UUID.init(uuidString:)), editName: args["editName"] as? String ?? "Duplicate Layer")
            } else {
                session.duplicateActiveLayer()
            }
        }
        case "mask.add": return try structure(args, maskOut: true) { $0.addMask(revealing: args["revealing"] as? Bool ?? true) }
        case "layer.check": return try check(args)
        case "layer.merge": return try await withSession(args) { $0.mergeLayers() }
        case "layer.convertDepth": return try await withSession(args) { $0.convertLayerDepth() }
        case "layer.convertHDRTo16": return try await withSession(args) { $0.convertHDRToSixteenBit() }
        case "layer.delete": return try await deleteBaking(args)
        default: return nil
        }
    }

    // MARK: Structure session (layers-masks.md 19.2)

    /// A session holding the board's manifest with stand-in pixels: enough for every edit that only rearranges
    /// records, none of which draws a layer.
    func structureSession(_ args: [String: Any]) throws -> EditorSession {
        guard let object = args["manifest"] else { throw EngineError.bad("missing manifest") }
        let manifest = try JSONDecoder().decode(ProjectManifest.self, from: JSONSerialization.data(withJSONObject: object))
        let sizes = args["sizes"] as? [String: [String: [Any]]] ?? [:]
        var images: [UUID: ImportedImage] = [:], masks: [UUID: ImportedImage] = [:]
        for layer in manifest.layers {
            let size = sizes[layer.id.uuidString] ?? sizes[layer.id.uuidString.lowercased()]
            if layer.imageFile != nil {
                let fallback = [Int(layer.transform.size.width.rounded()), Int(layer.transform.size.height.rounded())]
                images[layer.id] = try placeholder(size?["image"], fallback: fallback, gray: false)
            }
            if layer.maskFile != nil { masks[layer.id] = try placeholder(size?["mask"], fallback: [1, 1], gray: true) }
        }
        let session = EditorSession()
        session.installProject(ProjectSnapshot(manifest: manifest, images: images, masks: masks), from: try url(args))
        applyBoardState(session, args)
        if args.keys.contains("selection") { session.document?.selection = try selection(from: args["selection"]) }
        return session
    }

    /// The board's session state, in the order its setters expect: the active layer first (which resets the
    /// selection to it), then the selected set, the mask target, the collapsed folders.
    func applyBoardState(_ session: EditorSession, _ args: [String: Any]) {
        let ids = Set(session.document?.layers.map(\.id) ?? [])
        if let text = args["activeLayerID"] as? String, let id = UUID(uuidString: text), ids.contains(id) {
            session.activeLayerID = id
        }
        if let selected = args["selectedLayerIDs"] as? [String] {
            var set = Set(selected.compactMap(UUID.init(uuidString:)).filter(ids.contains))
            if let active = session.activeLayerID { set.insert(active) }
            if !set.isEmpty { session.selectedLayerIDs = set }
        }
        if let mask = args["isMaskSelected"] as? Bool { session.isMaskSelected = mask && session.activeLayer?.mask != nil }
        if let collapsed = args["collapsedGroupIDs"] as? [String] {
            session.collapsedGroupIDs = Set(collapsed.compactMap(UUID.init(uuidString:)).filter(ids.contains))
        }
    }

    /// The board's state after an operation, read back from the session.
    func boardState(_ session: EditorSession) -> [String: Any] {
        [
            "activeLayerID": session.activeLayerID?.uuidString ?? NSNull(),
            "selectedLayerIDs": session.selectedLayerIDs.map(\.uuidString),
            "isMaskSelected": session.isMaskSelected,
            "collapsedGroupIDs": session.collapsedGroupIDs.map(\.uuidString),
        ]
    }

    /// Runs `body` in a structure session and answers the resulting records when anything changed.
    func structure(_ args: [String: Any], maskOut: Bool = false, _ body: (EditorSession) throws -> Void) throws -> Any {
        let session = try structureSession(args)
        let before = session.document
        session.brushError = nil
        try body(session)
        var answer = boardState(session)
        if let error = session.brushError { answer["error"] = error }
        guard let now = session.document, let then = before, now != then, let snapshot = session.projectSnapshot() else {
            answer["changed"] = false
            return answer
        }
        answer["changed"] = true
        answer["editName"] = session.history.undoName
        answer["layers"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot.manifest.layers))
        // New records sharing a stand-in image with an existing one are its copies.
        var images: [ObjectIdentifier: UUID] = [:], masks: [ObjectIdentifier: UUID] = [:]
        for layer in then.layers {
            if let image = layer.asset?.image { images[ObjectIdentifier(image)] = layer.id }
            if let mask = layer.mask?.asset.image { masks[ObjectIdentifier(mask)] = layer.id }
        }
        let old = Set(then.layers.map(\.id))
        var copies: [String: String] = [:], maskCopies: [String: String] = [:]
        for layer in now.layers where !old.contains(layer.id) {
            if let image = layer.asset?.image, let source = images[ObjectIdentifier(image)] { copies[layer.id.uuidString] = source.uuidString }
            if let mask = layer.mask?.asset.image, let source = masks[ObjectIdentifier(mask)] { maskCopies[layer.id.uuidString] = source.uuidString }
        }
        answer["copies"] = copies
        answer["maskCopies"] = maskCopies
        if args.keys.contains("selection") { answer["selection"] = selectionAnswer(now.selection, args: args) }
        // A mask made from the selection comes back as an 8-bit gray PNG for the board to install.
        if maskOut, let out = args["out"] as? String, let active = session.activeLayer, let mask = active.mask,
           !(then.layers.first { $0.id == active.id }?.mask.map { $0.asset.image === mask.asset.image } ?? false) {
            try writeGrayPNG(mask.asset.image, to: out)
            answer["maskLayerID"] = active.id.uuidString
            answer["maskSize"] = [mask.asset.image.width, mask.asset.image.height]
        }
        return answer
    }

    /// A stand-in image of the given pixel size whose bytes are never allocated (every read returns zeros).
    func placeholder(_ size: [Any]?, fallback: [Int], gray: Bool) throws -> ImportedImage {
        let width = max(1, size.flatMap { $0.first }.flatMap(int) ?? fallback[0])
        let height = max(1, size.flatMap { $0.count > 1 ? $0[1] : nil }.flatMap(int) ?? fallback[1])
        let bytes = gray ? 1 : 4
        var callbacks = CGDataProviderDirectCallbacks(version: 0, getBytePointer: nil, releaseBytePointer: nil,
            getBytesAtPosition: { _, buffer, _, count in memset(buffer, 0, count); return count }, releaseInfo: nil)
        guard let provider = CGDataProvider(directInfo: nil, size: off_t(width * height * bytes), callbacks: &callbacks),
              let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8 * bytes, bytesPerRow: width * bytes,
                                  space: gray ? CGColorSpaceCreateDeviceGray() : CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGBitmapInfo(rawValue: gray ? CGImageAlphaInfo.none.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue),
                                  provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else {
            throw EngineError.bad("cannot make a stand-in image")
        }
        return ImportedImage(image: image, thumbnail: image, name: "")
    }

    func writeGrayPNG(_ image: CGImage, to path: String) throws {
        guard let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else {
            throw EngineError.bad("cannot write the mask")
        }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard let gray = context.makeImage() else { throw EngineError.bad("cannot write the mask") }
        try writePNG(gray, to: path)
    }

    /// The layers list's drop (UI/NativeLayerList.swift `place`, 470-497): above the row under the drop line, into a
    /// folder, or at the bottom; ⌥ copies instead of moving.
    func place(_ s: EditorSession, _ args: [String: Any]) {
        let ids = (args["ids"] as? [String] ?? []).compactMap(UUID.init(uuidString:))
        let copying = args["copying"] as? Bool ?? false, intoFolder = args["intoFolder"] as? Bool ?? false
        let row = (args["rowID"] as? String).flatMap(UUID.init(uuidString:))
        let parent: UUID?, above: UUID?, atBottom: Bool
        if intoFolder, let folder = row { parent = folder; above = nil; atBottom = false }
        else if let row, let target = s.document?.layers.first(where: { $0.id == row }) { parent = target.parentID; above = row; atBottom = false }
        else { parent = nil; above = nil; atBottom = true }
        guard !ids.isEmpty, ids.allSatisfy({ s.canPlaceLayer($0, in: parent) }) else { return }
        let order = intoFolder ? Array(ids.reversed()) : ids
        s.beginEdit(copying ? (ids.count > 1 ? "Duplicate Layers" : "Duplicate Layer") : (ids.count > 1 ? "Move Layers" : "Move Layer"))
        var placed = false
        for id in order {
            let done = copying ? s.duplicateLayer(id, in: parent, above: above, atBottom: atBottom)
                               : s.placeLayer(id, in: parent, above: above, atBottom: atBottom)
            placed = done || placed
        }
        if placed, !copying { s.selectLayers(Set(ids), primary: ids.first) }
        s.endEdit()
    }

    /// The predicates the board ports, evaluated by Compositor itself (for tests).
    func check(_ args: [String: Any]) throws -> Any {
        let s = try structureSession(args)
        var answer: [String: Any] = [
            "canMergeLayers": s.canMergeLayers, "mergeTitle": s.mergeTitle, "canUngroupLayers": s.canUngroupLayers,
            "canMoveUp": s.canMoveActiveLayer(by: 1), "canMoveDown": s.canMoveActiveLayer(by: -1),
            "canEditMask": s.canEditMask, "canConvertLayerDepth": s.canConvertLayerDepth, "canPaint": s.canPaint,
            "paintRefusal": s.paintRefusal ?? NSNull(), "canInvert": s.canInvert,
        ]
        var toggles: [String: Bool] = [:]
        for text in args["ids"] as? [String] ?? [] { if let id = UUID(uuidString: text) { toggles[text] = s.canToggleClippingMask(id) } }
        answer["canToggleClippingMask"] = toggles
        return answer
    }

    // MARK: Delete with Bake (LiveLayerMask.swift 74-130), without the alert

    func deleteBaking(_ args: [String: Any]) async throws -> Any {
        let (session, url) = try await session(args)
        configure(session, args)
        applyBoardState(session, args)
        let before = session.document
        guard session.canEditLayers, let document = session.document, let snapshot = session.projectSnapshot() else {
            return outcome(session, saved: false, args: args)
        }
        let selected = session.selectedLayerIDs.isEmpty ? Set([session.activeLayerID].compactMap { $0 }) : session.selectedLayerIDs
        let ids = document.layers.map(\.id).filter(selected.contains)
        let removed = ids.reduce(into: Set(ids)) { $0.formUnion(session.descendantIDs(of: $1)) }
        let targets = document.layers.filter { !removed.contains($0.id) && $0.maskSourceID.map(removed.contains) == true }.map(\.id)
        var baked: [UUID: ImportedImage] = [:]
        for target in targets {
            if let image = try await Task.detached(priority: .userInitiated, operation: { try LiveMaskBaker.bake(snapshot, target: target) }).value {
                baked[target] = image
            }
        }
        session.beginEdit(ids.count > 1 ? "Delete Layers" : "Delete Layer")
        session.finishDeletingLayers(ids, baked: baked)
        session.endEdit()
        let saved = try await saveIfChanged(session, from: before, to: url)
        return outcome(session, saved: saved, args: args)
    }
}

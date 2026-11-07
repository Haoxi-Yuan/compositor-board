// Crop, canvas and image size, trim, rotate and flip, and transforms that resample pixels, run through Compositor's own
// EditorSession, CanvasResizer, ImageResizer, ImageTrim and DistortWarp (docs/port-specs/geometry.md section 9). The
// board commits plain placement changes itself; everything that creates or resamples pixels comes here.
import AppKit
import CoreGraphics
import Foundation

extension EngineOperations {
    func geometryOperation(_ op: String, _ args: [String: Any]) async throws -> Any? {
        switch op {
        case "transform.commit": return try await withSession(args) { session in try self.commitTransform(session, args) }
        case "canvas.crop": return try await projectOperation(args, title: "Couldn’t crop") { session in
            guard let r = args["rect"] as? [Any], r.count == 4, let x = self.double(r[0]), let y = self.double(r[1]),
                  let w = self.double(r[2]), let h = self.double(r[3]) else { throw EngineError.bad("missing rect") }
            session.cropRect = CGRect(x: x, y: y, width: w, height: h)
            await session.commitCrop()
            // commitCrop keeps the frame and reports through cropError (Document/Crop.swift:236-248).
            if let error = session.cropError { throw EngineError.bad(error) }
        }
        case "canvas.size": return try await projectOperation(args, title: "Couldn’t change canvas size") { session in
            guard let width = self.int(args["width"]), let height = self.int(args["height"]) else { throw EngineError.bad("missing width and height") }
            let fill = self.color(args["fill"]).map { CanvasExtensionColor(red: $0.red, green: $0.green, blue: $0.blue) }
            guard let snapshot = session.projectSnapshot() else { throw EngineError.bad("no document") }
            // ProjectController.resizeCanvas without its sheet (IO/ProjectController.swift:111-130).
            let result = try await CanvasResizer.shared.resize(snapshot,
                to: CanvasSizeOptions(width: width, height: height, anchor: self.int(args["anchor"]) ?? 4, fill: fill))
            session.applyDocumentSize(result, actionName: "Canvas Size")
        }
        case "image.size": return try await projectOperation(args, title: "Couldn’t resize the image") { session in
            guard let width = self.int(args["width"]), let height = self.int(args["height"]) else { throw EngineError.bad("missing width and height") }
            guard let snapshot = session.projectSnapshot() else { throw EngineError.bad("no document") }
            let options = ImageSizeOptions(width: width, height: height, resolution: self.double(args["resolution"]) ?? 72,
                                           sampling: LayerSampling(rawValue: args["sampling"] as? String ?? "") ?? .high)
            // ProjectController.resizeImage (IO/ProjectController.swift:133-152).
            let result = try await ImageResizer.shared.resize(snapshot, to: options)
            session.applyImageSize(result)
        }
        case "image.trim": return try await projectOperation(args, title: "Couldn’t trim image") { session in
            let options = TrimOptions(basedOn: TrimBasedOn(rawValue: args["basedOn"] as? String ?? "") ?? .transparentPixels,
                                      top: args["top"] as? Bool ?? true, bottom: args["bottom"] as? Bool ?? true,
                                      left: args["left"] as? Bool ?? true, right: args["right"] as? Bool ?? true)
            // Nothing to trim leaves the document as it was, without a word (ProjectController.trim).
            _ = try await session.trim(options: options)
        }
        case "canvas.rotate": return try await withSession(args) { session in
            session.rotateCanvas(clockwise: args["clockwise"] as? Bool ?? true)
        }
        case "canvas.flip": return try await withSession(args) { session in
            session.flipCanvas(horizontally: args["horizontal"] as? Bool ?? true)
        }
        case "layer.flip": return try await withSession(args) { session in
            session.flipLayers(horizontally: args["horizontal"] as? Bool ?? true)
        }
        default: return nil
        }
    }

    /// A project operation as ProjectController runs it, without the sheet: a thrown error comes back as the alert's
    /// title and message instead of failing the request, and whatever the session changed is saved.
    func projectOperation(_ args: [String: Any], title: String, _ body: (EditorSession) async throws -> Void) async throws -> Any {
        let (session, url) = try await session(args)
        configure(session, args)
        let before = session.document
        var extra: [String: Any] = [:]
        do { try await body(session) } catch {
            extra["errorTitle"] = title
            extra["error"] = CompositorEngineMain.message(error)
        }
        let saved = try await saveIfChanged(session, from: before, to: url)
        var result = outcome(session, saved: saved, args: args, extra: extra)
        if saved { result["changedFiles"] = changedFiles(session, from: before) }
        return result
    }

    /// The board's transform applied by Compositor (geometry.md 9.2): a persistent edit on the active layer, the
    /// selected layers' box or an unlinked mask, set to `draft`, distorted to `corners` when given, then committed.
    func commitTransform(_ session: EditorSession, _ args: [String: Any]) throws {
        session.beginTransform(persistent: true)
        guard let edit = session.transformEdit else {
            throw EngineError.bad("Nothing here can be transformed: select a visible layer with pixels.")
        }
        // The board's box, computed in JavaScript from the same transforms, can differ from Swift's in the last bits;
        // the members follow the board's box exactly when the two agree to within 1e-6.
        if let json = args["box"] as? [String: Any], let group = edit.group {
            let box = try transform(json)
            let close = { (a: CGFloat, b: CGFloat) in abs(a - b) <= 1e-6 }
            if close(box.origin.x, group.box.origin.x), close(box.origin.y, group.box.origin.y),
               close(box.size.width, group.box.size.width), close(box.size.height, group.box.size.height),
               close(box.rotation, group.box.rotation), box.flipX == group.box.flipX, box.flipY == group.box.flipY {
                session.transformEdit = TransformEdit(layerID: edit.layerID, draft: box, persistent: true,
                                                      group: TransformGroup(box: box, originals: group.originals))
            }
        }
        guard let draft = args["draft"] as? [String: Any] else { throw EngineError.bad("missing draft") }
        session.previewTransform(try transform(draft))
        if let list = args["corners"] as? [[Any]] {
            guard list.count == 4 else { throw EngineError.bad("corners must be four points") }
            let corners = list.map { CGPoint(x: double($0.first) ?? .nan, y: double($0.dropFirst().first) ?? .nan) }
            session.beginDistort()
            session.previewCorners(corners)
            guard session.transformEdit?.corners == corners else { throw EngineError.bad("That shape can't be drawn.") }
        }
        session.commitTransform()
    }
}

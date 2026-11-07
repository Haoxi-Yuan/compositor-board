// compositor-engine: Compositor's own document code, driven from the Compositor Board extension and MCP server.
// One JSON request per line on stdin, {"id", "op", "args"}; one JSON answer per line on stdout, {"id", "ok", "result"}
// or {"id", "ok": false, "error"}. Requests run one at a time on the main actor, as the app runs its edits. Images
// travel as files whose paths are in the arguments and results.
import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum EngineError: Error, CustomStringConvertible {
    case bad(String)
    var description: String { if case .bad(let text) = self { return text }; return "error" }
}

@main
struct CompositorEngineMain {
    static func main() async {
        let engine = EngineOperations()
        do {
            for try await line in FileHandle.standardInput.bytes.lines {
                guard let data = line.data(using: .utf8),
                      let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                let id = request["id"] ?? NSNull()
                do {
                    let result = try await engine.run(request["op"] as? String ?? "", request["args"] as? [String: Any] ?? [:])
                    answer(["id": id, "ok": true, "result": result])
                } catch {
                    answer(["id": id, "ok": false, "error": Self.message(error)])
                }
            }
        } catch {
            FileHandle.standardError.write(Data("stdin closed: \(error)\n".utf8))
        }
    }

    /// The words the app would show: Compositor's errors are LocalizedError; the engine's own are written as shown.
    static func message(_ error: Error) -> String {
        if let engine = error as? EngineError { return engine.description }
        return error.localizedDescription
    }

    static func answer(_ object: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
        data.append(0x0a)
        FileHandle.standardOutput.write(data)
    }
}

/// What a project looks like on disk, cheaply: its manifest and each file's size and modification time. Equal stamps
/// mean nothing was written since, by the board, the app or the engine itself.
struct DiskStamp: Equatable {
    let manifest: Data
    let files: [String: [Double]]

    init?(_ url: URL) {
        guard let manifest = try? Data(contentsOf: url.appendingPathComponent("manifest.json")) else { return nil }
        self.manifest = manifest
        var files: [String: [Double]] = [:]
        let images = url.appendingPathComponent("images")
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        for file in (try? FileManager.default.contentsOfDirectory(at: images, includingPropertiesForKeys: keys)) ?? [] {
            let values = try? file.resourceValues(forKeys: Set(keys))
            files[file.lastPathComponent] = [Double(values?.fileSize ?? -1), values?.contentModificationDate?.timeIntervalSince1970 ?? 0]
        }
        self.files = files
    }
}

final class EngineOperations {
    /// Projects as last read or written, reused while their files stay as they were: loading decodes every layer, which
    /// for a large photo costs far more than the operation itself.
    private var loaded: [String: (stamp: DiskStamp, snapshot: ProjectSnapshot)] = [:]
    /// Filter panels open on boards, by edit id (FilterOps.swift).
    var openFilters: [String: OpenFilter] = [:]

    func loadSnapshot(_ url: URL) async throws -> ProjectSnapshot {
        let stamp = DiskStamp(url)
        if let stamp, let entry = loaded[url.path], entry.stamp == stamp { return entry.snapshot }
        // Stamped before reading: a write that lands while loading changes the stamp, so the next request reloads.
        let snapshot = try await ProjectStore.shared.load(from: url)
        if let stamp { remember(url, stamp: stamp, snapshot: snapshot) }
        return snapshot
    }

    private func remember(_ url: URL, stamp: DiskStamp, snapshot: ProjectSnapshot) {
        if loaded[url.path] == nil, loaded.count >= 4, let oldest = loaded.keys.first { loaded[oldest] = nil }
        loaded[url.path] = (stamp, snapshot)
    }

    func run(_ op: String, _ args: [String: Any]) async throws -> Any {
        switch op {
        case "version": return ["engine": 1, "pid": ProcessInfo.processInfo.processIdentifier]
        case "render": return try await render(args)
        default:
            if let result = try await selectionOperation(op, args) { return result }
            if let result = try await filterOperation(op, args) { return result }
            if let result = try await layerOperation(op, args) { return result }
            if let result = try await paintOperation(op, args) { return result }
            if let result = try await geometryOperation(op, args) { return result }
            if let result = try await textOperation(op, args) { return result }
            if let result = try await adjustOperation(op, args) { return result }
            if let result = try await cameraRawOperation(op, args) { return result }
            if let result = try await fileOperation(op, args) { return result }
            if let result = try await cmykOperation(op, args) { return result }
            throw EngineError.bad("unknown operation \(op)")
        }
    }

    // MARK: Helpers

    func url(_ args: [String: Any], _ key: String = "project") throws -> URL {
        guard let path = args[key] as? String, !path.isEmpty else { throw EngineError.bad("missing \(key)") }
        return URL(fileURLWithPath: path)
    }

    /// A session holding the project as Compositor itself loads it, with the board's active layer and selection.
    func session(_ args: [String: Any]) async throws -> (EditorSession, URL) {
        let url = try url(args)
        let snapshot = try await loadSnapshot(url)
        let session = EditorSession()
        session.installProject(snapshot, from: url)
        applyBoardState(session, args)
        if args.keys.contains("selection") { session.document?.selection = try selection(from: args["selection"]) }
        return (session, url)
    }

    /// Saves the session the way the app's Save does: the whole package, with its Quick Look preview.
    func save(_ session: EditorSession, to url: URL) async throws {
        guard let snapshot = session.projectSnapshot() else { throw EngineError.bad("no document") }
        let quickLook = await ImageExporter.shared.quickLookImages(snapshot)
        try await ProjectStore.shared.save(snapshot, to: url, quickLook: quickLook)
        if let stamp = DiskStamp(url) { remember(url, stamp: stamp, snapshot: snapshot) }
    }

    func writePNG(_ image: CGImage, to path: String) throws {
        let url = URL(fileURLWithPath: path)
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw EngineError.bad("cannot write \(path)")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw EngineError.bad("cannot encode \(path)") }
    }

    func scaled(_ image: CGImage, maxSize: Int?) throws -> (CGImage, Double) {
        guard let maxSize, maxSize > 0, max(image.width, image.height) > maxSize else { return (image, 1) }
        let scale = Double(maxSize) / Double(max(image.width, image.height))
        let width = max(1, Int((Double(image.width) * scale).rounded())), height = max(1, Int((Double(image.height) * scale).rounded()))
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw EngineError.bad("cannot scale")
        }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let result = context.makeImage() else { throw EngineError.bad("cannot scale") }
        return (result, scale)
    }

    // MARK: Operations

    /// The project flattened exactly as Compositor exports it: adjustments, effects, masks and clipping included.
    func render(_ args: [String: Any]) async throws -> Any {
        let url = try url(args)
        guard let out = args["out"] as? String else { throw EngineError.bad("missing out") }
        let snapshot = try await loadSnapshot(url)
        let raster = try await ImageExporter.shared.render(snapshot)
        let (image, scale) = try scaled(raster.image, maxSize: (args["maxSize"] as? NSNumber)?.intValue)
        try writePNG(image, to: out)
        return ["width": image.width, "height": image.height, "scale": scale,
                "documentWidth": snapshot.manifest.width, "documentHeight": snapshot.manifest.height]
    }
}

// File operations (docs/port-specs/file.md section 15): new projects from images or the clipboard, importing images
// into an open project (folders, PSD/PSB, camera RAW, SVG), the checks the board's sheets need first (RAW as shot, PSD
// conversions), Export PNG, the Export As session, and the QuickLook preview. Every import and export runs
// Compositor's own code: EditorSession.importImages, ImageImporter, PSDReader, RawImporter, ImageExporter, CMYK.
import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The flattenings an Export As sheet works from, kept in the engine while the sheet is open (ProjectController.exportAs
/// renders them once). The 16-bit and HDR ones are made when first asked for (file.md 15.1 item 4).
final class ExportSession {
    let snapshot: ProjectSnapshot
    let raster: ExportRaster
    var deep: ExportRaster?
    var hdr: ExportRaster?
    let hasDeep: Bool
    let hasHDR: Bool
    /// The bytes the latest preview was made from: what Export… writes.
    var data: Data?
    init(snapshot: ProjectSnapshot, raster: ExportRaster, hasDeep: Bool, hasHDR: Bool) {
        self.snapshot = snapshot
        self.raster = raster
        self.hasDeep = hasDeep
        self.hasHDR = hasHDR
    }
}

/// Open Export As sheets by token. At most two are kept, so a board that never said goodbye cannot hold every raster.
private var exportSessions: [(token: String, session: ExportSession)] = []

/// Export As's formats (ProjectController.swift:417-428, left out of the engine with the rest of that file).
/// A JSON value or null.
private func orNull(_ value: Any?) -> Any { value ?? NSNull() }

private enum ExportKind: String {
    case png = "PNG", jpeg = "JPEG", tiff = "TIFF", pdf = "PDF", exr = "EXR"
}

/// Camera RAW extensions on this Mac that conform to public.camera-raw-image (file.md 6.3).
private let rawExtensions = ["dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "raw", "rwl",
                             "pef", "srw", "3fr", "fff", "iiq", "mos", "mrw", "erf", "dcr"]

extension EngineOperations {
    func fileOperation(_ op: String, _ args: [String: Any]) async throws -> Any? {
        switch op {
        case "import.types": return importTypes()
        case "import.plan": return try importPlan(args)
        case "import.images": return try await importImagesOp(args)
        case "project.inspect": return try await inspectProject(args)
        case "project.create": return try await projectCreate(args)
        case "project.fromImages": return try await projectFromImages(args)
        case "project.fromClipboard": return try await projectFromClipboard(args)
        case "project.quickLook": return try await quickLook(args)
        case "clipboard.inspect": return clipboardInspect()
        case "psd.inspect": return try await inspectPSD(args)
        case "raw.asShot": return try await rawAsShot(args)
        case "raw.preview": return try await rawPreview(args)
        case "raw.release":
            await RawImporter.Queue.shared.release()
            return [:] as [String: Any]
        case "export.png": return try await exportPNG(args)
        case "export.begin": return try await exportBegin(args)
        case "export.preview": return try await exportPreview(args)
        case "export.write": return try await exportWrite(args)
        case "export.end":
            exportSessions.removeAll { $0.token == args["token"] as? String }
            return [:] as [String: Any]
        default: return nil
        }
    }

    // MARK: Import

    /// The picker's types: UTType.importableImages' extensions, and the camera RAW ones (ProjectStore.swift:10-15).
    func importTypes() -> Any {
        var extensions: [String] = []
        for type in UTType.importableImages where type != .rawImage {
            for tag in type.tags[.filenameExtension] ?? [] where !extensions.contains(tag) { extensions.append(tag) }
        }
        let raw = rawExtensions.filter { UTType(filenameExtension: $0)?.conforms(to: .rawImage) == true }
        return ["extensions": extensions, "raw": raw]
    }

    /// What an import request holds, before anything is read: folders opened into the images directly inside them
    /// (ImageFolder), each file's path the way importImages dispatches it (RAW by extension, SVG by extension, PSD by
    /// its 8BPS magic, the rest decoded), and the empty-folder message (EditorSession.swift:818-834).
    func importPlan(_ args: [String: Any]) throws -> Any {
        guard let paths = args["files"] as? [String] else { throw EngineError.bad("missing files") }
        var files: [[String: Any]] = []
        var empty: [String] = []
        for path in paths {
            let url = URL(fileURLWithPath: path)
            let urls: [URL]
            if ImageFolder.matches(url) {
                urls = ImageFolder.images(in: url)
                if urls.isEmpty { empty.append(url.lastPathComponent) }
            } else { urls = [url] }
            for file in urls {
                let kind = RawImporter.matches(file) ? "raw"
                    : UTType(filenameExtension: file.pathExtension)?.conforms(to: .svg) == true ? "svg"
                    : PSDReader.matches(file) ? "psd" : "image"
                files.append(["path": file.path, "name": file.lastPathComponent, "kind": kind])
            }
        }
        let message = empty.map { "“\($0)” has no images to import." }.joined(separator: "\n")
        // "entries", not "files": the board's engine answers carry attached files under that key.
        return ["entries": files, "emptyMessage": empty.isEmpty ? NSNull() : message as Any]
    }

    /// The board ran the develop and conversion sheets first: RAW files arrive with their settings, and only PSDs whose
    /// conversions were accepted arrive at all, so the session's test hooks answer for the sheets
    /// (EditorSession.swift:586-598).
    func prepareImport(_ session: EditorSession, _ args: [String: Any]) -> [URL] {
        let raw = args["raw"] as? [String: Any] ?? [:]
        session.confirmRawDevelop = { url, asShot in
            guard let values = raw[url.standardizedFileURL.path] as? [String: Any] ?? raw[url.path] as? [String: Any] else { return nil }
            return self.rawSettings(values, base: asShot)
        }
        session.confirmConversions = { _ in true }
        // A folder's emptiness was reported when it was opened; upstream keeps that message unless files then fail.
        if let empty = args["emptyMessage"] as? String, !empty.isEmpty { session.importError = empty }
        return (args["files"] as? [String] ?? []).map { URL(fileURLWithPath: $0) }
    }

    func importImagesOp(_ args: [String: Any]) async throws -> Any {
        var errors: String?
        var profile: String?
        let point: CGPoint? = (args["point"] as? [Any]).flatMap { p in
            guard p.count == 2, let x = double(p[0]), let y = double(p[1]) else { return nil }
            return CGPoint(x: x, y: y)
        }
        let answer = try await withSession(args) { session in
            let urls = self.prepareImport(session, args)
            if !urls.isEmpty { await session.importImages(urls, at: point) }
            errors = session.importError
            profile = session.proofProfile?.name
        }
        var result = answer as? [String: Any] ?? [:]
        result["errors"] = errors ?? NSNull()
        result["cmykProfile"] = profile ?? NSNull()
        return result
    }

    /// Create canvas (EditorSession.createNewProject / createDocument): the first layer filled with white or black
    /// at full size and named Background, or a blank selected "Layer 1"; saved at `target`.
    func projectCreate(_ args: [String: Any]) async throws -> Any {
        let target = try url(args, "target")
        guard let width = int(args["width"]), let height = int(args["height"]),
              (1...DocumentLimits.maxSide).contains(width), (1...DocumentLimits.maxSide).contains(height) else { throw ProjectError.tooLarge }
        let background: CGColor? = switch args["background"] as? String {
        case "white": CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
        case "black": CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1)
        default: nil
        }
        let session = EditorSession()
        session.createDocument(width: width, height: height, emptyLayer: true, resolution: double(args["resolution"]) ?? 72, background: background)
        return try await saveNewProject(session, to: target)
    }

    /// A new project made of images, saved at `target` (EditorSession.importImages with no document, then Save).
    func projectFromImages(_ args: [String: Any]) async throws -> Any {
        let target = try url(args, "target")
        let session = EditorSession()
        let urls = prepareImport(session, args)
        if !urls.isEmpty { await session.importImages(urls) }
        return try await saveNewProject(session, to: target)
    }

    /// Cmd-V on the New canvas screen (SelectionClipboard.swift:172-202): a canvas the copied image's size, with it in.
    func projectFromClipboard(_ args: [String: Any]) async throws -> Any {
        let target = try url(args, "target")
        let session = EditorSession()
        session.confirmConversions = { _ in true }
        session.confirmRawDevelop = { _, asShot in asShot }
        guard session.canPasteImageAsNewCanvas else { return ["none": true] }
        await session.pasteImageAsNewCanvas()
        return try await saveNewProject(session, to: target)
    }

    private func saveNewProject(_ session: EditorSession, to target: URL) async throws -> Any {
        guard let document = session.document else {
            throw EngineError.bad(session.importError ?? ImageImportError.unreadable.localizedDescription)
        }
        try await save(session, to: target)
        return ["width": document.width, "height": document.height, "layers": document.layers.count,
                "errors": orNull(session.importError), "cmykProfile": orNull(session.proofProfile?.name)]
    }

    /// The pixels the project already has, against which an import's budget is counted (EditorSession.swift:871-874).
    private func usedPixels(_ args: [String: Any]) async -> Int {
        guard let path = args["project"] as? String, !path.isEmpty,
              let snapshot = try? await loadSnapshot(URL(fileURLWithPath: path)) else { return 0 }
        return snapshot.images.values.reduce(0) { $0 + $1.image.width * $1.image.height }
    }

    /// The conversion report the sheet shows before a PSD is imported (beginPSDReading / finishPSDReading).
    func inspectPSD(_ args: [String: Any]) async throws -> Any {
        let file = try url(args, "file")
        let remaining = DocumentLimits.documentPixelBudget - (await usedPixels(args))
        let parsed = try await ImageImporter.shared.loadPhotoshop(file, remainingPixels: remaining)
        // Only a background: no layer records, the merged image comes in as one layer, with no sheet.
        if parsed.layers.isEmpty {
            return ["backgroundOnly": true, "conversions": [] as [Any], "width": parsed.width, "height": parsed.height,
                    "resolution": parsed.resolution, "layers": 0]
        }
        let assets = try await ImageImporter.shared.photoshopAssets(parsed)
        let imported = try PSDDocumentBuilder.makeImport(parsed, assets: assets)
        return ["backgroundOnly": false,
                "conversions": imported.conversions.map { ["layerName": $0.layerName, "message": $0.message] },
                "width": imported.width, "height": imported.height, "resolution": imported.resolution,
                "layers": imported.layers.count, "cmykProfile": orNull(parsed.cmykProfile?.name)]
    }

    /// The develop sheet's starting point: the size checked first (tooLarge before the sheet), then the camera's own
    /// settings (EditorSession.swift:876-883, RawImporter.asShot).
    func rawAsShot(_ args: [String: Any]) async throws -> Any {
        let file = try url(args, "file")
        guard let size = RawImporter.pixelSize(file) else { throw ImageImportError.unreadable }
        guard size.width <= DocumentLimits.maxSide, size.height <= DocumentLimits.maxSide,
              size.width * size.height <= DocumentLimits.documentPixelBudget - (await usedPixels(args)) else { throw ImageImportError.tooLarge }
        var result = rawJSON(RawImporter.asShot(file) ?? RawDevelopSettings())
        result["width"] = size.width
        result["height"] = size.height
        return result
    }

    /// The sheet's live preview: the frame at most 800 px long, dithered to 8 bits (RawDevelopSheet .task).
    func rawPreview(_ args: [String: Any]) async throws -> Any {
        let file = try url(args, "file")
        guard let out = args["out"] as? String else { throw EngineError.bad("missing out") }
        let settings = rawSettings(args["settings"] as? [String: Any] ?? [:], base: RawImporter.asShot(file) ?? RawDevelopSettings())
        guard let image = await RawImporter.Queue.shared.develop(file, settings: settings, limit: 800) else { throw ImageImportError.unreadable }
        try writePNG(image, to: out)
        return ["width": image.width, "height": image.height]
    }

    func rawJSON(_ s: RawDevelopSettings) -> [String: Any] {
        ["exposure": s.exposure, "temperature": s.temperature, "tint": s.tint, "boost": s.boost,
         "noiseReduction": s.noiseReduction, "lensCorrection": s.lensCorrection, "highlightRecovery": s.highlightRecovery,
         "asShotTemperature": s.asShotTemperature, "asShotTint": s.asShotTint, "asShotNoiseReduction": s.asShotNoiseReduction,
         "asShotLensCorrection": s.asShotLensCorrection, "asShotHighlightRecovery": s.asShotHighlightRecovery,
         "supportsNoiseReduction": s.supportsNoiseReduction, "supportsLensCorrection": s.supportsLensCorrection,
         "supportsHighlightRecovery": s.supportsHighlightRecovery]
    }

    /// The board's slider values over the file's as-shot settings, clamped to the sheet's ranges (RawDevelopSheet).
    func rawSettings(_ json: [String: Any], base: RawDevelopSettings) -> RawDevelopSettings {
        var s = base
        let number = { (key: String, range: ClosedRange<Float>) -> Float? in
            self.double(json[key]).map { min(range.upperBound, max(range.lowerBound, Float($0))) }
        }
        if let v = number("exposure", -3...3) { s.exposure = v }
        if let v = number("temperature", 2000...12000) { s.temperature = v }
        if let v = number("tint", -150...150) { s.tint = v }
        if let v = number("boost", 0...1) { s.boost = v }
        if let v = number("noiseReduction", 0...1) { s.noiseReduction = v }
        if let v = json["lensCorrection"] as? Bool { s.lensCorrection = v }
        if let v = json["highlightRecovery"] as? Bool { s.highlightRecovery = v }
        return s
    }

    // MARK: Projects

    /// Open Project's check before anything opens (ProjectController.open: a missing package names the project, a bad
    /// one gives ProjectError's text).
    func inspectProject(_ args: [String: Any]) async throws -> Any {
        let url = try url(args)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: url.path])
        }
        let snapshot = try await ProjectStore.shared.load(from: url)
        return ["width": snapshot.manifest.width, "height": snapshot.manifest.height,
                "resolution": snapshot.manifest.resolution ?? 72, "version": snapshot.manifest.version,
                "layers": snapshot.manifest.layers.count]
    }

    /// QuickLook/Preview.jpg as Compositor writes it on every save (ImageExporter.quickLookImages): nothing above 50 MP.
    func quickLook(_ args: [String: Any]) async throws -> Any {
        let snapshot = try await loadSnapshot(try url(args))
        guard let out = args["out"] as? String else { throw EngineError.bad("missing out") }
        guard let images = await ImageExporter.shared.quickLookImages(snapshot) else { return ["none": true] }
        try images.preview.write(to: URL(fileURLWithPath: out))
        return ["bytes": images.preview.count]
    }

    /// What Cmd-V on the New canvas screen would do (NewCanvasSheet.clipboardDimensions, canPasteImageAsNewCanvas).
    func clipboardInspect() -> Any {
        let pasteboard = NSPasteboard.general
        var imageSize: Any = NSNull()
        for type in [NSPasteboard.PasteboardType.png, .tiff] {
            guard let data = pasteboard.data(forType: type),
                  let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  var width = properties[kCGImagePropertyPixelWidth] as? Int,
                  var height = properties[kCGImagePropertyPixelHeight] as? Int else { continue }
            if let orientation = properties[kCGImagePropertyOrientation] as? Int, (5...8).contains(orientation) {
                swap(&width, &height)
            }
            guard CanvasDocument.validDimension(String(width)) != nil, CanvasDocument.validDimension(String(height)) != nil else { continue }
            imageSize = [width, height]
            break
        }
        let text = pasteboard.string(forType: .string)
        return ["imageSize": imageSize, "canPasteAsCanvas": EditorSession().canPasteImageAsNewCanvas,
                "sizeText": orNull(text.flatMap { CanvasDocument.validDimension($0) != nil ? $0 : nil })]
    }

    // MARK: Export

    /// File › Export PNG… (ProjectController.exportPNG): the flattened canvas, 8-bit sRGB with alpha and DPI.
    func exportPNG(_ args: [String: Any]) async throws -> Any {
        let snapshot = try await loadSnapshot(try url(args))
        let target = try url(args, "path")
        try await ImageExporter.shared.exportPNG(snapshot, to: target)
        return ["width": snapshot.manifest.width, "height": snapshot.manifest.height]
    }

    /// Export As opens (ProjectController.exportAs): the project flattened once; whether 16-bit and HDR layers exist.
    func exportBegin(_ args: [String: Any]) async throws -> Any {
        let snapshot = try await loadSnapshot(try url(args))
        let raster = try await ImageExporter.shared.render(snapshot)
        let hasDeep = snapshot.images.values.contains { $0.deep != nil }
        let hasHDR = snapshot.images.values.contains { $0.isHDR }
        let token = UUID().uuidString
        exportSessions.append((token, ExportSession(snapshot: snapshot, raster: raster, hasDeep: hasDeep, hasHDR: hasHDR)))
        if exportSessions.count > 2 { exportSessions.removeFirst(exportSessions.count - 2) }
        return ["token": token, "width": raster.image.width, "height": raster.image.height, "resolution": raster.resolution,
                "hasDeep": hasDeep, "hasHDR": hasHDR, "profile": orNull(cmykProfile(args)?.name)]
    }

    private func exportSession(_ args: [String: Any]) throws -> ExportSession {
        guard let token = args["token"] as? String, let found = exportSessions.first(where: { $0.token == token }) else {
            throw EngineError.bad("The export session expired. Close Export As and open it again.")
        }
        return found.session
    }

    /// The profile CMYK export goes through: the board's chosen name among the profiles the engine can read (the
    /// system's, and the folders the extension keeps loaded ones in), else Generic CMYK, else the first (CMYK.chosen).
    func cmykProfile(_ args: [String: Any]) -> CMYKProfile? {
        var found: [String: CMYKProfile] = [:]
        for profile in CMYK.installed() { found[profile.name] = profile }
        for folder in args["profileFolders"] as? [String] ?? [] {
            let files = (try? FileManager.default.contentsOfDirectory(at: URL(fileURLWithPath: folder), includingPropertiesForKeys: nil)) ?? []
            for file in files where ["icc", "icm"].contains(file.pathExtension.lowercased()) {
                guard let data = try? Data(contentsOf: file),
                      let profile = CMYKProfile(name: file.deletingPathExtension().lastPathComponent, data: data) else { continue }
                found[profile.name] = profile
            }
        }
        let all = found.values.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        let name = args["cmykProfile"] as? String
        return all.first { $0.name == name } ?? all.first { $0.name == "Generic CMYK Profile" } ?? all.first
    }

    /// One preview of Export As (ExportAsSheet .task, :206-239): the source flattening resized, encoded in the format,
    /// and the picture the sheet shows. The encoded bytes stay for export.write.
    func exportPreview(_ args: [String: Any]) async throws -> Any {
        let session = try exportSession(args)
        guard let out = args["out"] as? String else { throw EngineError.bad("missing out") }
        let format = ExportKind(rawValue: args["format"] as? String ?? "PNG") ?? .png
        let width = int(args["width"]) ?? session.raster.image.width, height = int(args["height"]) ?? session.raster.image.height
        let matteRGB = (args["matte"] as? [Any])?.compactMap { double($0) } ?? [1, 1, 1]
        let red = CGFloat(matteRGB.count > 0 ? matteRGB[0] : 1), green = CGFloat(matteRGB.count > 1 ? matteRGB[1] : 1)
        let blue = CGFloat(matteRGB.count > 2 ? matteRGB[2] : 1)
        let options = JPEGOptions(quality: double(args["quality"]) ?? 0.85, red: red, green: green, blue: blue)
        let takesCMYK = format == .jpeg || format == .tiff || format == .pdf
        let cmyk = takesCMYK && args["cmyk"] as? Bool == true ? cmykProfile(args) : nil
        let sixteenBit = args["sixteenBit"] as? Bool == true && format == .png && session.hasDeep
        let source: ExportRaster
        if format == .exr, session.hasHDR {
            if session.hdr == nil { session.hdr = try await ImageExporter.shared.render(session.snapshot, sixteenBit: true, hdr: true) }
            source = session.hdr!
        } else if sixteenBit {
            if session.deep == nil { session.deep = try await ImageExporter.shared.render(session.snapshot, sixteenBit: true) }
            source = session.deep!
        } else { source = session.raster }
        let sized = try await ImageExporter.shared.resized(source, width: width, height: height)
        let data: Data, preview: CGImage
        var previewData: Data?
        switch format {
        case .jpeg:
            let encoded = try await ImageExporter.shared.jpeg(sized, options: options, cmyk: cmyk)
            (data, preview) = (encoded.data, encoded.preview)
            // The browser decodes an RGB JPEG itself, artifacts included; a CMYK one goes through ImageIO's picture.
            if cmyk == nil, max(sized.image.width, sized.image.height) <= 8192 { previewData = encoded.data }
        case .tiff:
            let matte = CGColor(srgbRed: red, green: green, blue: blue, alpha: 1)
            (data, preview) = try await ImageExporter.shared.tiffData(sized, cmyk: cmyk, matte: matte)
        case .png: (data, preview) = (try await ImageExporter.shared.pngData(sized), sized.image)
        // Shown as everything is, brighter than white as white.
        case .exr: (data, preview) = (try await ImageExporter.shared.exrData(sized), try DeepLayer.dithered(sized.image))
        case .pdf:
            let background = CGColor(srgbRed: red, green: green, blue: blue, alpha: 1)
            data = try await ImageExporter.shared.pdfData(sized, background: background, cmyk: cmyk)
            if let cmyk { preview = try CMYK.convert(sized.image, to: cmyk, over: background) }
            else { preview = try await ImageExporter.shared.flattened(sized, over: background) }
        }
        session.data = data
        let shown: CGImage
        if let previewData {
            try previewData.write(to: URL(fileURLWithPath: out))
            shown = preview
        } else {
            shown = try displayable(preview, limit: 8192)
            try writePNG(shown, to: out)
        }
        return ["bytes": data.count, "previewType": previewData == nil ? "png" : "jpeg",
                "previewWidth": shown.width, "previewHeight": shown.height, "width": sized.image.width, "height": sized.image.height,
                "profile": orNull(cmyk?.name)]
    }

    /// A preview the webview can show: 8-bit sRGB with alpha, at most `limit` px long, as the sheet's JPEG preview is
    /// capped (ImageExporter.jpeg).
    private func displayable(_ image: CGImage, limit: Int) throws -> CGImage {
        let scale = min(1, Double(limit) / Double(max(image.width, image.height)))
        let width = max(1, Int((Double(image.width) * scale).rounded())), height = max(1, Int((Double(image.height) * scale).rounded()))
        if scale == 1, image.bitsPerComponent == 8, image.colorSpace?.name == CGColorSpace.sRGB,
           image.alphaInfo == .premultipliedLast || image.alphaInfo == .noneSkipLast { return image }
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { throw ExportError.render }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let result = context.makeImage() else { throw ExportError.render }
        return result
    }

    /// Export…: the exact bytes the preview was made from (ImageExporter.write, a coordinated atomic write).
    func exportWrite(_ args: [String: Any]) async throws -> Any {
        let session = try exportSession(args)
        guard let data = session.data else { throw ExportError.encode }
        try await ImageExporter.shared.write(data, to: try url(args, "path"))
        return ["bytes": data.count]
    }
}

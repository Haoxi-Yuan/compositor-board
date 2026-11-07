// Type layers (docs/port-specs/text.md section 11): the layout of a text style as Compositor draws it (the same
// TextKit set-up as EditorSession.textImage, Document/TypeTool.swift:449-471), so the board's caret, selection and hit
// testing are TextKit's own; the installed faces for the font menu; and the commit, through EditorSession.applyText.
// text.layout and text.fonts never read a project; the extension runs them on a second engine process (the text
// lane) so typing does not wait behind a filter or a save.
import AppKit
import CoreGraphics
import Foundation

extension EngineOperations {
    func textOperation(_ op: String, _ args: [String: Any]) async throws -> Any? {
        switch op {
        case "text.layout": return try textLayout(args)
        case "text.fonts": return try textFonts(args)
        case "text.commit": return try await withSession(args) { session in
            guard let document = session.document else { return }
            let draft = TextDraft(documentID: document.id, layerID: self.uuid(args["layerID"]),
                                  origin: try self.textPoint(args["origin"]),
                                  transform: try (args["transform"] as? [String: Any]).map { try self.transform($0) },
                                  style: try self.textStyle(args["style"]))
            // applyText reports a style or layer it cannot use by returning false without a message.
            if !session.applyText(draft), session.brushError == nil { session.brushError = "The text could not be applied." }
        }
        default: return nil
        }
    }

    /// A LayerTextStyle in the manifest's JSON form.
    func textStyle(_ value: Any?) throws -> LayerTextStyle {
        guard let json = value as? [String: Any] else { throw EngineError.bad("missing style") }
        let data = try JSONSerialization.data(withJSONObject: json)
        return try JSONDecoder().decode(LayerTextStyle.self, from: data)
    }

    func textPoint(_ value: Any?) throws -> CGPoint {
        guard let p = value as? [Any], p.count == 2, let x = double(p[0]), let y = double(p[1]) else { throw EngineError.bad("missing origin") }
        return CGPoint(x: x, y: y)
    }

    /// Geometry in image pixels (the container plus the 12 px padding), and the raster as PNG (base64) unless
    /// `image` is false. A raster too large to make still answers its geometry, with `imageError: "tooLarge"`.
    func textLayout(_ args: [String: Any]) throws -> Any {
        let style = try textStyle(args["style"])
        guard style.isValid else { throw EngineError.bad("That text style is not valid.") }
        let padding = LayerTextStyle.padding
        let size = EditorSession.textBoxSize(style)
        let width = ceil(size.width), height = ceil(size.height)
        let storage = NSTextStorage(attributedString: EditorSession.attributedText(style))
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: max(1, width - 2 * padding), height: max(1, height - 2 * padding)))
        container.lineFragmentPadding = 0
        storage.addLayoutManager(layout)
        layout.addTextContainer(container)
        let glyphs = layout.glyphRange(for: container)
        let content = style.content as NSString
        var lines: [[String: Any]] = []
        layout.enumerateLineFragments(forGlyphRange: glyphs) { rect, used, _, glyphRange, _ in
            let chars = layout.characterRange(forGlyphRange: glyphRange, actualGlyphRange: nil)
            var positions = [CGFloat](repeating: 0, count: chars.length + 2)
            var indexes = [Int](repeating: 0, count: chars.length + 2)
            let count = layout.getLineFragmentInsertionPoints(forCharacterAt: chars.location, alternatePositions: false,
                                                              inDisplayOrder: false, positions: &positions, characterIndexes: &indexes)
            let baseline = rect.minY + layout.location(forGlyphAt: glyphRange.location).y
            let last = chars.length > 0 ? content.character(at: chars.location + chars.length - 1) : 0
            lines.append(["range": [chars.location, chars.length],
                          "rect": [rect.minX + padding, rect.minY + padding, rect.width, rect.height],
                          "used": [used.minX + padding, used.minY + padding, used.width, used.height],
                          "baseline": baseline + padding,
                          "carets": (0..<count).map { [indexes[$0], rect.minX + positions[$0] + padding] },
                          "hardBreak": last == 0x0A || last == 0x0D || last == 0x2028 || last == 0x2029])
        }
        // Empty text has no letter to take the paragraph style from; the editor's typing attributes give its one line
        // the style's line height (text.md 2.5: "" → extra fragment 0, 0, 8, 86.4).
        var extra = layout.extraLineFragmentRect
        if content.length == 0 { extra = CGRect(x: 0, y: 0, width: container.size.width, height: style.lineHeight) }
        let laidOut = layout.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        // The faces actually drawn, after TextKit's fallback (fixed attributes once laid out).
        var fonts: [[Any]] = []
        storage.enumerateAttribute(.font, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            if let font = value as? NSFont { fonts.append([range.location, range.length, font.fontName]) }
        }
        let requested = Set([style.fontName] + (style.fontRuns ?? []).map(\.fontName))
        let missing = requested.filter { NSFont(name: $0, size: style.fontSize) == nil }.sorted()
        let descender = abs((EditorSession.textAttributes(style)[.font] as? NSFont)?.descender ?? 0)
        var result: [String: Any] = [
            "size": [width, height], "padding": padding,
            "container": [max(1, width - 2 * padding), max(1, height - 2 * padding)],
            "laidOut": laidOut.location + laidOut.length, "overflow": laidOut.location + laidOut.length < content.length,
            "lineHeight": style.lineHeight, "baseDescender": descender, "lines": lines,
            "extra": extra.height > 0 ? ["rect": [extra.minX + padding, extra.minY + padding, extra.width, extra.height]] as Any : NSNull(),
            "fonts": fonts, "missingFonts": missing, "imageError": NSNull(),
        ]
        if args["image"] as? Bool ?? true {
            do {
                let image = try EditorSession.textImage(style)
                result["png"] = try pngData(image).base64EncodedString()
                result["imageSize"] = [image.width, image.height]
            } catch ProjectError.tooLarge {
                result["imageError"] = "tooLarge"
            }
        }
        return result
    }

    func pngData(_ image: CGImage) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, "public.png" as CFString, 1, nil) else {
            throw EngineError.bad("cannot encode png")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw EngineError.bad("cannot encode png") }
        return data as Data
    }

    /// Every installed face (NSFontManager.availableFonts, sorted), whether it can show its own name
    /// (TypeFontPicker.makeStyledName, UI/TypeControls.swift:204-209), and optionally sheets of rows with each name set
    /// in its own face at the menu's size (or the menu font when it cannot), white on clear, for the board's menu.
    func textFonts(_ args: [String: Any]) throws -> Any {
        let names = NSFontManager.shared.availableFonts.sorted()
        let size = NSFont.systemFontSize
        let faces: [(String, NSFont?)] = names.map { name in
            guard let font = NSFont(name: name, size: size),
                  name.unicodeScalars.filter({ $0.properties.isAlphabetic }).allSatisfy({ font.coveredCharacterSet.contains($0) })
            else { return (name, nil) }
            return (name, font)
        }
        var result: [String: Any] = ["fonts": faces.map { ["name": $0.0, "ownFace": $0.1 != nil] }]
        guard let sprite = args["sprite"] as? [String: Any] else { return result }
        let scale = max(1, min(4, double(sprite["scale"]) ?? 2))
        let width = max(80, min(600, double(sprite["width"]) ?? 300))
        let rowHeight: CGFloat = 22
        let perSheet = max(1, Int(floor(16000 / (rowHeight * scale))))
        var sheets: [String] = []
        var start = 0
        while start < faces.count {
            let rows = Array(faces[start..<min(faces.count, start + perSheet)])
            let pixelWidth = Int(ceil(width * scale)), pixelHeight = Int(ceil(CGFloat(rows.count) * rowHeight * scale))
            guard let context = CGContext(data: nil, width: pixelWidth, height: pixelHeight, bitsPerComponent: 8, bytesPerRow: pixelWidth * 4,
                                          space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw EngineError.bad("cannot draw font names") }
            context.translateBy(x: 0, y: CGFloat(pixelHeight))
            context.scaleBy(x: scale, y: -scale)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
            for (index, (name, font)) in rows.enumerated() {
                let face = font ?? NSFont.menuFont(ofSize: size)
                let line = NSAttributedString(string: name, attributes: [.font: face, .foregroundColor: NSColor.white])
                let bounds = line.size()
                let top = CGFloat(index) * rowHeight + max(0, (rowHeight - bounds.height) / 2)
                context.saveGState()
                context.clip(to: CGRect(x: 0, y: CGFloat(index) * rowHeight, width: width, height: rowHeight))
                line.draw(at: CGPoint(x: 0, y: top))
                context.restoreGState()
            }
            NSGraphicsContext.restoreGraphicsState()
            guard let image = context.makeImage() else { throw EngineError.bad("cannot draw font names") }
            sheets.append(try pngData(image).base64EncodedString())
            start += perSheet
        }
        result["sprite"] = ["rowHeight": rowHeight, "scale": scale, "width": width, "rowsPerSheet": perSheet, "sheets": sheets]
        return result
    }
}

// Selections cross between the board (JavaScript) and the engine as JSON: the outline as a list of path elements in
// document pixels, ["M", x, y], ["L", x, y], ["Q", cx, cy, x, y], ["C", c1x, c1y, c2x, c2y, x, y] and ["Z"], plus the
// antialias flag and feather radius of upstream's DocumentSelection.
import CoreGraphics
import Foundation

func pathElements(_ path: CGPath) -> [[Any]] {
    var out: [[Any]] = []
    path.applyWithBlock { pointer in
        let element = pointer.pointee
        let p = element.points
        switch element.type {
        case .moveToPoint: out.append(["M", Double(p[0].x), Double(p[0].y)])
        case .addLineToPoint: out.append(["L", Double(p[0].x), Double(p[0].y)])
        case .addQuadCurveToPoint: out.append(["Q", Double(p[0].x), Double(p[0].y), Double(p[1].x), Double(p[1].y)])
        case .addCurveToPoint:
            out.append(["C", Double(p[0].x), Double(p[0].y), Double(p[1].x), Double(p[1].y), Double(p[2].x), Double(p[2].y)])
        case .closeSubpath: out.append(["Z"])
        @unknown default: break
        }
    }
    return out
}

func path(from elements: [[Any]]) throws -> CGPath {
    let path = CGMutablePath()
    for element in elements {
        guard let kind = element.first as? String else { throw EngineError.bad("path element without a kind") }
        let n = element.dropFirst().map { ($0 as? NSNumber)?.doubleValue ?? .nan }
        let point = { (i: Int) -> CGPoint in CGPoint(x: n[i], y: n[i + 1]) }
        switch (kind, n.count) {
        case ("M", 2): path.move(to: point(0))
        case ("L", 2): path.addLine(to: point(0))
        case ("Q", 4): path.addQuadCurve(to: point(2), control: point(0))
        case ("C", 6): path.addCurve(to: point(4), control1: point(0), control2: point(2))
        case ("Z", 0): path.closeSubpath()
        default: throw EngineError.bad("bad path element \(kind) with \(n.count) numbers")
        }
        guard n.allSatisfy(\.isFinite) else { throw EngineError.bad("non-finite path coordinate") }
    }
    return path
}

func selectionJSON(_ selection: DocumentSelection?) -> Any {
    guard let selection else { return NSNull() }
    return ["path": pathElements(selection.path), "antialiased": selection.antialiased, "feather": Double(selection.feather)]
}

func selection(from json: Any?) throws -> DocumentSelection? {
    guard let json = json as? [String: Any] else { return nil }
    let elements = json["path"] as? [[Any]] ?? []
    return DocumentSelection(path: try path(from: elements),
                             antialiased: json["antialiased"] as? Bool ?? true,
                             feather: CGFloat((json["feather"] as? NSNumber)?.doubleValue ?? 0))
}

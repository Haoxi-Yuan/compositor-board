// CMYK proofing (docs/port-specs/chrome.md section 20): the CMYK output profiles there are to choose, the proof
// lookups ColorSync makes through one (IO/CMYK.swift), and the check Load Profile… runs. The extension owns which
// profile is chosen and where loaded ones are kept, so nothing here reads or writes the engine's own preferences.
import AppKit
import CoreGraphics
import Foundation

extension EngineOperations {
    func cmykOperation(_ op: String, _ args: [String: Any]) async throws -> Any? {
        switch op {
        case "cmyk.profiles": return cmykProfiles(args)
        case "cmyk.lookups": return try cmykLookups(args)
        case "cmyk.validate":
            let url = try url(args, "path")
            guard let data = try? Data(contentsOf: url),
                  CMYKProfile(name: url.deletingPathExtension().lastPathComponent, data: data) != nil else {
                throw EngineError.bad(CMYKError.notCMYK.errorDescription ?? "")
            }
            return ["name": url.deletingPathExtension().lastPathComponent]
        default: return nil
        }
    }

    /// CMYK.installed (IO/CMYK.swift:39-50) over the system folders and the ones the extension names; a later folder
    /// wins a name clash.
    private func cmykProfiles(_ args: [String: Any]) -> Any {
        var folders = [URL(fileURLWithPath: "/System/Library/ColorSync/Profiles"), URL(fileURLWithPath: "/Library/ColorSync/Profiles")]
        folders += (args["folders"] as? [String] ?? []).map { URL(fileURLWithPath: $0) }
        var found: [String: String] = [:]
        for folder in folders {
            let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
            for file in files where ["icc", "icm"].contains(file.pathExtension.lowercased()) {
                let name = file.deletingPathExtension().lastPathComponent
                guard let data = try? Data(contentsOf: file), CMYKProfile(name: name, data: data) != nil else { continue }
                found[name] = file.path
            }
        }
        let names = found.keys.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        return ["profiles": names.map { ["name": $0, "path": found[$0]!] }]
    }

    /// CMYK.proofLookups: the proof, warning and marked tables back to back, each 33³ RGBA Float32, red fastest.
    private func cmykLookups(_ args: [String: Any]) throws -> Any {
        let url = try url(args, "path")
        guard let out = args["out"] as? String else { throw EngineError.bad("missing out") }
        let name = args["name"] as? String ?? url.deletingPathExtension().lastPathComponent
        guard let data = try? Data(contentsOf: url), let profile = CMYKProfile(name: name, data: data),
              let lookups = CMYK.proofLookups(profile) else {
            throw EngineError.bad(CMYKError.notCMYK.errorDescription ?? "")
        }
        try (lookups.proof + lookups.warning + lookups.marked).write(to: URL(fileURLWithPath: out))
        return ["dimension": CMYK.dimension, "tables": ["proof", "warning", "marked"], "bytesPerTable": lookups.proof.count]
    }
}

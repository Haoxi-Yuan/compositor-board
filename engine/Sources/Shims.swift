// Stand-ins for view modifiers defined in SwiftUI files the engine leaves out (they need SwiftUI's macro plugins,
// which only Xcode ships). They only style controls the engine never shows.
import SwiftUI

extension View {
    func roundedControls() -> some View { self }
}

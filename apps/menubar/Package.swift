// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Ned",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Ned",
            path: "Sources/Ned",
            // Required: without it the SwiftUI `@main` App exits with code 0 right after
            // launch under Swift 6.2 / Xcode 26 (verified 2026-11). Do not remove.
            swiftSettings: [.unsafeFlags(["-parse-as-library"])]
        )
    ]
)

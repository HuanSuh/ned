// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Ned",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Ned",
            path: "Sources/Ned",
            swiftSettings: [.unsafeFlags(["-parse-as-library"])]
        )
    ]
)

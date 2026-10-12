// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ReviewGateCore",
    defaultLocalization: "en",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "ReviewGateCore", targets: ["ReviewGateCore"]),
    ],
    dependencies: [
        .package(url: "https://github.com/raspu/Highlightr", exact: "2.3.0"),
    ],
    targets: [
        .target(
            name: "ReviewGateCore",
            dependencies: [.product(name: "Highlightr", package: "Highlightr")],
            resources: [.process("Resources")],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "ReviewGateCoreTests",
            dependencies: ["ReviewGateCore"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)

// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "VdsForm",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "VdsForm", targets: ["VdsForm"]),
        .library(name: "VdsFormUI", targets: ["VdsFormUI"]),
    ],
    targets: [
        .target(name: "VdsForm"),
        .target(name: "VdsFormUI", dependencies: ["VdsForm"]),
        .testTarget(name: "VdsFormTests", dependencies: ["VdsForm"]),
    ]
)

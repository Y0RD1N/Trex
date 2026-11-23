// swift-tools-version: 6.0

import PackageDescription

// La app nativa de iPhone para el control remoto de trex (se compila con xtool).
//
// En Linux no hay SwiftUI: para probar solo el núcleo (modelos, protocolo, Markdown) se
// compila sin la app con `TREX_CORE_ONLY=1 swift test`.
let coreOnly = Context.environment["TREX_CORE_ONLY"] == "1"

var products: [Product] = [
    .library(name: "TrexRemoteCore", targets: ["TrexRemoteCore"]),
]
var targets: [Target] = [
    .target(name: "TrexRemoteCore"),
    .testTarget(name: "TrexRemoteCoreTests", dependencies: ["TrexRemoteCore"]),
]

if !coreOnly {
    products.append(.library(name: "TrexRemote", targets: ["TrexRemote"]))
    targets.append(.target(
        name: "TrexRemote",
        dependencies: ["TrexRemoteCore"],
        // UIKit/AVFoundation aún no están anotados para la concurrencia estricta de Swift 6.
        swiftSettings: [.swiftLanguageMode(.v5)]
    ))
}

let package = Package(
    name: "TrexRemote",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: products,
    targets: targets
)

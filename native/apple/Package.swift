// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "VectisVM",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "vectis-vm", targets: ["VectisVM"])],
    targets: [.executableTarget(name: "VectisVM")]
)

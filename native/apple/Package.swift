// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "VectisVM",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "vectis-vm", targets: ["VectisVM"]), .executable(name: "vectis-keychain", targets: ["VectisKeychain"]), .executable(name: "vectis-launcher", targets: ["VectisLauncher"])],
    targets: [.executableTarget(name: "VectisVM"), .executableTarget(name: "VectisKeychain"), .executableTarget(name: "VectisLauncher")]
)

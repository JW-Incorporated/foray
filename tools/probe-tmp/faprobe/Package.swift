// swift-tools-version: 6.0
// THROWAWAY probe (branch probe/kokoro-speed-prior-art). Never merged.
import PackageDescription
let package = Package(
    name: "FaProbe",
    platforms: [.macOS(.v14)],
    dependencies: [.package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.4")],
    targets: [.executableTarget(name: "FaProbe", dependencies: [.product(name: "FluidAudio", package: "FluidAudio")])]
)

// swift-tools-version: 6.0

import Foundation
import PackageDescription

let packageRoot = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()
  .standardizedFileURL
let whisperInstallRoot = packageRoot
  .appendingPathComponent("../build/whisper-install")
  .standardizedFileURL
let whisperIncludePath = whisperInstallRoot
  .appendingPathComponent("include")
  .path
let whisperLibPath = whisperInstallRoot
  .appendingPathComponent("lib")
  .path

let package = Package(
  name: "TarteelMacAudioBackend",
  platforms: [
    .macOS(.v15),
  ],
  products: [
    .executable(
      name: "TarteelMacAudioBackend",
      targets: ["TarteelMacAudioBackend"]
    ),
  ],
  targets: [
    .target(
      name: "CWhisper",
      path: "Sources/CWhisper",
      publicHeadersPath: "include",
      cSettings: [
        .unsafeFlags([
          "-I\(whisperIncludePath)",
        ]),
      ]
    ),
    .executableTarget(
      name: "TarteelMacAudioBackend",
      dependencies: ["CWhisper"],
      linkerSettings: [
        .unsafeFlags([
          "-L\(whisperLibPath)",
          "-lwhisper",
          "-lggml",
          "-lggml-cpu",
          "-lggml-base",
          "-Xlinker", "-rpath",
          "-Xlinker", "@executable_path/../lib",
          "-Xlinker", "-rpath",
          "-Xlinker", "@executable_path/../../../build/whisper-install/lib",
        ]),
        .linkedFramework("Metal"),
        .linkedFramework("MetalKit"),
      ]
    ),
  ]
)

import Foundation
import Virtualization

@MainActor
func restoreImageInfo(arguments: [String]) async throws {
    guard arguments.count == 2 || arguments.count == 3 else {
        throw HelperError(message: "Usage: vectis-vm restore-info [restore.ipsw]")
    }
    let image: VZMacOSRestoreImage
    if arguments.count == 3 {
        image = try await VZMacOSRestoreImage.image(from: URL(fileURLWithPath: arguments[2]))
    } else {
        image = try await VZMacOSRestoreImage.latestSupported
    }
    guard let requirements = image.mostFeaturefulSupportedConfiguration else {
        throw HelperError(message: "The restore image is not supported by this host.")
    }
    let version = image.operatingSystemVersion
    struct RestoreInfo: Encodable {
        let url: String
        let build: String
        let majorVersion: Int
        let version: String
        let minimumCpu: Int
        let minimumMemoryBytes: UInt64
    }
    let info = RestoreInfo(
        url: image.url.absoluteString,
        build: image.buildVersion,
        majorVersion: version.majorVersion,
        version: "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)",
        minimumCpu: requirements.minimumSupportedCPUCount,
        minimumMemoryBytes: requirements.minimumSupportedMemorySize
    )
    FileHandle.standardOutput.write(try JSONEncoder().encode(info))
    FileHandle.standardOutput.write(Data("\n".utf8))
}

import Foundation
import Darwin
import Virtualization

@MainActor
func installMac(arguments: [String]) async throws {
    guard arguments.count == 7,
          let cpu = Int(arguments[4]), let memory = UInt64(arguments[5]),
          let diskGiB = UInt64(arguments[6]), cpu > 0, memory >= 4096,
          memory <= 131072, diskGiB >= 40, diskGiB <= 2048 else {
        throw HelperError(message: "Usage: vectis-vm install-macos restore.ipsw new-bundle cpu memoryMiB diskGiB")
    }
    let restoreURL = URL(fileURLWithPath: arguments[2])
    let bundle = URL(fileURLWithPath: arguments[3])
    guard !FileManager.default.fileExists(atPath: bundle.path) else {
        throw HelperError(message: "The destination already exists. Use a new bundle directory.")
    }
    let restore = try await VZMacOSRestoreImage.image(from: restoreURL)
    guard restore.operatingSystemVersion.majorVersion == 26,
          let requirements = restore.mostFeaturefulSupportedConfiguration,
          cpu >= requirements.minimumSupportedCPUCount,
          memory * 1048576 >= requirements.minimumSupportedMemorySize else {
        throw HelperError(message: "The restore image must support macOS 26 on this host with the requested CPU and memory.")
    }
    guard mkdir(bundle.path, 0o700) == 0 else {
        throw HelperError(message: "Could not reserve a new macOS bundle directory.")
    }
    let platform = VZMacPlatformConfiguration()
    platform.hardwareModel = requirements.hardwareModel
    platform.machineIdentifier = VZMacMachineIdentifier()
    try platform.hardwareModel.dataRepresentation.write(to: bundle.appendingPathComponent("hardware-model.bin"), options: .atomic)
    try platform.machineIdentifier.dataRepresentation.write(to: bundle.appendingPathComponent("machine-identifier.bin"), options: .atomic)
    platform.auxiliaryStorage = try VZMacAuxiliaryStorage(creatingStorageAt: bundle.appendingPathComponent("auxiliary-storage.bin"), hardwareModel: requirements.hardwareModel, options: [])
    let disk = bundle.appendingPathComponent("disk.img")
    guard FileManager.default.createFile(atPath: disk.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
        throw HelperError(message: "Could not create the macOS work disk.")
    }
    let file = try FileHandle(forWritingTo: disk)
    try file.truncate(atOffset: diskGiB * 1073741824)
    try file.close()
    let config = VZVirtualMachineConfiguration()
    config.platform = platform
    config.bootLoader = VZMacOSBootLoader()
    config.cpuCount = cpu
    config.memorySize = memory * 1048576
    config.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: disk, readOnly: false))]
    let graphics = VZMacGraphicsDeviceConfiguration()
    graphics.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: 1280, heightInPixels: 800, pixelsPerInch: 80)]
    config.graphicsDevices = [graphics]
    let network = VZVirtioNetworkDeviceConfiguration()
    network.attachment = VZNATNetworkDeviceAttachment()
    config.networkDevices = [network]
    try config.validate()
    let machine = VZVirtualMachine(configuration: config)
    let installer = VZMacOSInstaller(virtualMachine: machine, restoringFromImageAt: restoreURL)
    let progress = installer.progress
    var signals: [DispatchSourceSignal] = []
    for number in [SIGTERM, SIGINT] {
        signal(number, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
        source.setEventHandler { progress.cancel() }
        source.resume()
        signals.append(source)
    }
    FileHandle.standardInput.readabilityHandler = { handle in
        if handle.availableData.isEmpty {
            handle.readabilityHandler = nil
            Task { @MainActor in progress.cancel() }
        }
    }
    defer {
        FileHandle.standardInput.readabilityHandler = nil
        for source in signals { source.cancel() }
    }
    emit("installation.started", message: restore.buildVersion)
    try await installer.install()
    let metadata: [String: Any] = ["build": restore.buildVersion, "state": "action_required", "nextStep": "Complete macOS Setup Assistant before preparing the runner."]
    try JSONSerialization.data(withJSONObject: metadata).write(to: bundle.appendingPathComponent("installation.json"), options: .atomic)
    emit("installation.action_required", message: "Complete macOS Setup Assistant before preparing the runner.")
}

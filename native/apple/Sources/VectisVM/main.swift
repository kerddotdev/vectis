import Foundation
import AppKit
import Virtualization

struct HelperError: Error { let message: String }

@MainActor
func emit(_ event: String, message: String? = nil, macAddress: String? = nil) {
    if (event == "vm.stopped" || event == "vm.error" || event == "installation.action_required"),
       let path = ProcessInfo.processInfo.environment["VECTIS_EXIT_RECEIPT"],
       let id = ProcessInfo.processInfo.environment["VECTIS_INSTANCE_ID"],
       let receipt = try? JSONSerialization.data(withJSONObject: ["instanceId": id, "pid": getpid()]) {
        try? receipt.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
    var body = ["event": event]
    if let message { body["message"] = message }
    if let macAddress { body["macAddress"] = macAddress }
    if let data = try? JSONSerialization.data(withJSONObject: body) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}

@MainActor
final class Controller: NSObject, VZVirtualMachineDelegate, NSWindowDelegate {
    var window: NSWindow?
    var machine: VZVirtualMachine?
    var signals: [DispatchSourceSignal] = []
    var stopping = false

    func start(arguments: [String]) async throws {
        guard (7...8).contains(arguments.count), arguments[1] == "run",
              let cpu = Int(arguments[4]), let memory = UInt64(arguments[5]),
              cpu > 0, memory >= 512, memory <= UInt64.max / 1048576 else {
            throw HelperError(message: "Usage: vectis-vm run linux|macos image cpu memoryMiB efiPath [seedPath]")
        }
        let os = arguments[2]
        let image = URL(fileURLWithPath: arguments[3])
        let configuration = VZVirtualMachineConfiguration()
        configuration.cpuCount = cpu
        configuration.memorySize = memory * 1048576
        let disk: URL
        if os == "linux" {
            let boot = VZEFIBootLoader()
            let efi = URL(fileURLWithPath: arguments[6])
            boot.variableStore = try VZEFIVariableStore(creatingVariableStoreAt: efi)
            configuration.bootLoader = boot
            configuration.platform = VZGenericPlatformConfiguration()
            configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
            configuration.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
            let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
            serial.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil, fileHandleForWriting: .standardError)
            configuration.serialPorts = [serial]
            disk = image
        } else if os == "macos" {
            let platform = VZMacPlatformConfiguration()
            guard let hardware = VZMacHardwareModel(dataRepresentation: try Data(contentsOf: image.appendingPathComponent("hardware-model.bin"))), hardware.isSupported,
                  let identifier = VZMacMachineIdentifier(dataRepresentation: try Data(contentsOf: image.appendingPathComponent("machine-identifier.bin"))) else {
                throw HelperError(message: "The macOS bundle hardware or machine identifier is invalid or unsupported.")
            }
            platform.hardwareModel = hardware
            platform.machineIdentifier = identifier
            platform.auxiliaryStorage = VZMacAuxiliaryStorage(url: image.appendingPathComponent("auxiliary-storage.bin"))
            configuration.platform = platform
            configuration.bootLoader = VZMacOSBootLoader()
            let graphics = VZMacGraphicsDeviceConfiguration()
            graphics.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: 1280, heightInPixels: 800, pixelsPerInch: 80)]
            configuration.graphicsDevices = [graphics]
            configuration.keyboards = [VZUSBKeyboardConfiguration()]
            configuration.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
            disk = image.appendingPathComponent("disk.img")
        } else {
            throw HelperError(message: "Only linux and macos guests use the Apple helper.")
        }
        let attachment = try VZDiskImageStorageDeviceAttachment(url: disk, readOnly: false)
        configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: attachment)]
        if arguments.count == 8 && arguments[7] != "--console" {
            guard os == "linux" else { throw HelperError(message: "A setup seed is supported only for Linux.") }
            let seed = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: arguments[7]), readOnly: true)
            configuration.storageDevices.append(VZVirtioBlockDeviceConfiguration(attachment: seed))
        }
        let network = VZVirtioNetworkDeviceConfiguration()
        network.macAddress = VZMACAddress.randomLocallyAdministered()
        network.attachment = VZNATNetworkDeviceAttachment()
        configuration.networkDevices = [network]
        try configuration.validate()
        let vm = VZVirtualMachine(configuration: configuration)
        vm.delegate = self
        machine = vm
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { Task { @MainActor in await self.stop() } }
            source.resume()
            signals.append(source)
        }
        FileHandle.standardInput.readabilityHandler = { handle in
            if handle.availableData.isEmpty {
                handle.readabilityHandler = nil
                Task { @MainActor in await self.stop() }
            }
        }
        try await vm.start()
        if arguments.last == "--console" {
            guard os == "macos" else { throw HelperError(message: "The graphical console requires macOS.") }
            let view = VZVirtualMachineView()
            view.virtualMachine = vm
            view.capturesSystemKeys = true
            let console = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
            console.title = "Vectis macOS setup"
            console.contentView = view
            console.delegate = self
            console.center()
            console.makeKeyAndOrderFront(nil)
            window = console
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
        emit("vm.running", macAddress: network.macAddress.string)
    }

    func windowWillClose(_ notification: Notification) {
        Task { @MainActor in await self.stop() }
    }

    func stop() async {
        guard !stopping else { return }
        stopping = true
        if let machine, machine.canStop {
            do { try await machine.stop() }
            catch { emit("vm.error", message: "Unable to stop the virtual machine."); exit(1) }
        }
        emit("vm.stopped")
        exit(0)
    }

    nonisolated func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        Task { @MainActor in
            emit("vm.stopped")
            exit(0)
        }
    }

    nonisolated func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        let message = error.localizedDescription
        Task { @MainActor in
            emit("vm.error", message: message)
            exit(1)
        }
    }
}

let showConsole = CommandLine.arguments.last == "--console"
if showConsole { NSApplication.shared.setActivationPolicy(.regular) }
let controller = Controller()
Task { @MainActor in
    do {
        if CommandLine.arguments.dropFirst().first == "restore-info" {
            try await restoreImageInfo(arguments: CommandLine.arguments)
            exit(0)
        }
        if CommandLine.arguments.dropFirst().first == "install-macos" {
            try await installMac(arguments: CommandLine.arguments)
            exit(0)
        }
        try await controller.start(arguments: CommandLine.arguments)
    }
    catch {
        emit("vm.error", message: (error as? HelperError)?.message ?? error.localizedDescription)
        exit(1)
    }
}
if showConsole { NSApplication.shared.run() } else { dispatchMain() }

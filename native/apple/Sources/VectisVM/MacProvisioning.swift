import Foundation
import Virtualization

func provisioningSupported() -> Bool {
    #if compiler(>=6.4) && arch(arm64)
    if #available(macOS 27, *) { return true }
    #endif
    return false
}

@MainActor
func configureProvisioning(_ options: VZMacOSVirtualMachineStartOptions) throws {
    #if compiler(>=6.4) && arch(arm64)
    if #available(macOS 27, *) {
        // Read only the first line; stdin remains open for owned shutdown control.
        var data = Data()
        while data.count < 1024 {
            let byte = FileHandle.standardInput.readData(ofLength: 1)
            guard !byte.isEmpty else { break }
            if byte.first == 10 { break }
            data.append(byte)
        }
        defer { data.resetBytes(in: 0..<data.count) }
        struct Input: Decodable { let password: String }
        do {
            let input = try JSONDecoder().decode(Input.self, from: data)
            let provisioning = VZMacGuestProvisioningOptions()
            provisioning.fullName = "Vectis"
            provisioning.username = "vectis"
            provisioning.password = input.password
            provisioning.logsInAutomatically = true
            provisioning.enablesRemoteLogin = true
            try options.setGuestProvisioning(provisioning)
        } catch {
            // Framework validation errors must never echo credential values.
            throw HelperError(message: "Guest provisioning options were rejected.")
        }
        return
    }
    #endif
    throw HelperError(message: "This helper or host does not support automatic macOS setup.")
}

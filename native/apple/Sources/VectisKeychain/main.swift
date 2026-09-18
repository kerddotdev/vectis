import Foundation
import Security
import LocalAuthentication

let arguments = CommandLine.arguments
guard arguments.count == 3, ["get", "set", "delete"].contains(arguments[1]), !arguments[2].isEmpty else {
    FileHandle.standardError.write(Data("Usage: vectis-keychain get|set|delete account\n".utf8))
    exit(2)
}
let authenticationContext = LAContext()
authenticationContext.interactionNotAllowed = true
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "sh.vectis.machine",
    kSecAttrAccount as String: arguments[2],
    kSecAttrSynchronizable as String: false,
    kSecUseAuthenticationContext as String: authenticationContext,
]
func finish(_ status: OSStatus) -> Never {
    if status == errSecSuccess { exit(0) }
    if status == errSecItemNotFound { exit(44) }
    FileHandle.standardError.write(Data("Keychain operation failed (\(status)).\n".utf8))
    exit(1)
}
switch arguments[1] {
case "get":
    var request = query
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecSuccess {
        guard let data = result as? Data, data.count <= 4096 else { finish(errSecDecode) }
        FileHandle.standardOutput.write(data)
    }
    finish(status)
case "set":
    var data = Data()
    do {
        while let chunk = try FileHandle.standardInput.read(upToCount: 4097), !chunk.isEmpty {
            data.append(chunk)
            if data.count > 4096 { exit(2) }
        }
    } catch { exit(2) }
    guard !data.isEmpty else { exit(2) }
    let attributes: [String: Any] = [kSecValueData as String: data]
    let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        finish(SecItemAdd(item as CFDictionary, nil))
    }
    finish(status)
default:
    let status = SecItemDelete(query as CFDictionary)
    finish(status == errSecItemNotFound ? errSecSuccess : status)
}

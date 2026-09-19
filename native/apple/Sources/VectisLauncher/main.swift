import Foundation
import Darwin

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

guard let resources = Bundle.main.resourceURL,
      Bundle.main.bundleIdentifier == "com.kerddotdev.vectis.runtime" else {
    fail("Run Vectis from its complete runtime application bundle.")
}

let runtime = resources.appendingPathComponent("runtime")
let node = runtime.appendingPathComponent("bin/node")
var arguments = Array(CommandLine.arguments.dropFirst())
let entry: String
switch arguments.first {
case "--mcp":
    entry = "mcp"
    arguments.removeFirst()
case "--service":
    entry = "server"
    arguments.removeFirst()
default:
    entry = "cli"
}
let main = resources.appendingPathComponent("app/dist/apps/\(entry)/src/main.js")
guard FileManager.default.isExecutableFile(atPath: node.path),
      FileManager.default.fileExists(atPath: main.path) else {
    fail("The Vectis runtime bundle is incomplete. Reinstall the complete package.")
}

for (name, relative) in [
    ("VECTIS_APPLE_HELPER", "vectis-vm"),
    ("VECTIS_KEYCHAIN_HELPER", "vectis-keychain"),
    ("VECTIS_QEMU", "windows/bin/qemu-system-aarch64"),
    ("VECTIS_QEMU_IMG", "windows/bin/qemu-img"),
    ("VECTIS_SWTPM", "windows/bin/swtpm")
] {
    let path = runtime.appendingPathComponent(relative).path
    if getenv(name) == nil && FileManager.default.isExecutableFile(atPath: path) {
        setenv(name, path, 0)
    }
}

var pointers = ([node.path, main.path] + arguments).map { strdup($0) }
guard pointers.allSatisfy({ $0 != nil }) else {
    pointers.forEach { free($0) }
    fail("Could not allocate Vectis runtime arguments.")
}
pointers.append(nil)
let result = pointers.withUnsafeBufferPointer { buffer in
    guard let base = buffer.baseAddress else { return Int32(-1) }
    return execv(node.path, base)
}
let failure = errno
pointers.forEach { free($0) }
if result == -1 {
    fail("Could not start the Vectis runtime: \(String(cString: strerror(failure)))")
}

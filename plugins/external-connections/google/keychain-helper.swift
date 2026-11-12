import Foundation
import Security
import LocalAuthentication

// Private pipe protocol only: never pass credential material as command arguments.
struct Request: Decodable {
    let operation: String
    let account: String
    let value: String?
}
struct Reply: Encodable {
    let status: String
    var value: String? = nil
    var code: Int32? = nil
}
func reply(_ result: Reply) -> Never {
    if let data = try? JSONEncoder().encode(result) {
        FileHandle.standardOutput.write(data)
    }
    exit(result.status == "ok" ? 0 : 1)
}

let validateOnly = CommandLine.arguments == [CommandLine.arguments[0], "--validate-only"]
guard CommandLine.arguments.count == 1 || validateOnly else {
    reply(Reply(status: "invalid_arguments"))
}
var input = Data()
while input.count <= 65536 {
    let chunk = FileHandle.standardInput.readData(ofLength: min(4096, 65537 - input.count))
    if chunk.isEmpty { break }
    input.append(chunk)
}
guard input.count <= 65536,
      let request = try? JSONDecoder().decode(Request.self, from: input),
      request.account.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil,
      ["read", "write", "delete"].contains(request.operation) else {
    reply(Reply(status: "invalid_request"))
}
if request.operation == "write" {
    guard let value = request.value, !value.isEmpty, value.utf8.count <= 16384 else {
        reply(Reply(status: "invalid_value"))
    }
} else if request.value != nil {
    reply(Reply(status: "invalid_value"))
}
if validateOnly { reply(Reply(status: "ok")) }

let authenticationContext = LAContext()
authenticationContext.interactionNotAllowed = true
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "app.paseo.google.oauth",
    kSecAttrAccount as String: request.account,
    kSecAttrSynchronizable as String: false,
    // No unexpected keychain prompt from an agent/background request.
    kSecUseAuthenticationContext as String: authenticationContext,
]
switch request.operation {
case "read":
    var readQuery = query
    readQuery[kSecReturnData as String] = true
    readQuery[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(readQuery as CFDictionary, &item)
    guard status == errSecSuccess else {
        reply(Reply(status: status == errSecItemNotFound ? "not_found" : "keychain_unavailable", code: status))
    }
    guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
        reply(Reply(status: "invalid_stored_value"))
    }
    reply(Reply(status: "ok", value: value))
case "write":
    let data = Data(request.value!.utf8)
    var addQuery = query
    addQuery[kSecValueData as String] = data
    var status = SecItemAdd(addQuery as CFDictionary, nil)
    if status == errSecDuplicateItem {
        status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    }
    guard status == errSecSuccess else { reply(Reply(status: "keychain_unavailable", code: status)) }
    reply(Reply(status: "ok"))
case "delete":
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
        reply(Reply(status: "keychain_unavailable", code: status))
    }
    reply(Reply(status: "ok"))
default:
    reply(Reply(status: "invalid_request"))
}

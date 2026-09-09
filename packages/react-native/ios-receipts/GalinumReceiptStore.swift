import Foundation
import CryptoKit
import Security
import UserNotifications
import UniformTypeIdentifiers

@objc(GalinumReceiptStore)
public final class GalinumReceiptStore: NSObject {
  private static func configuration() throws -> (URL, String, String) {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "GalinumReceiptAppGroup") as? String,
          let access = Bundle.main.object(forInfoDictionaryKey: "GalinumReceiptKeychainGroup") as? String,
          !group.isEmpty, !access.isEmpty,
          let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
      throw failure("receipt_configuration_missing")
    }
    return (container.appendingPathComponent("GalinumReceipts", isDirectory: true), group, access)
  }
  private static func failure(_ code: String) -> NSError { NSError(domain: code, code: 1) }
  private static func key(create: Bool) throws -> SymmetricKey {
    let (_, group, access) = try configuration()
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "com.galinum.receipt.key", kSecAttrAccount as String: group,
      kSecAttrAccessGroup as String: access]
    var read = query
    read[kSecReturnData as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(read as CFDictionary, &result)
    if status == errSecSuccess, let data = result as? Data, data.count == 32 { return SymmetricKey(data: data) }
    guard status == errSecItemNotFound, create else { throw failure("receipt_key_unavailable") }
    let (directory, _, _) = try configuration()
    if (try? FileManager.default.contentsOfDirectory(atPath: directory.path).contains { $0.hasSuffix(".receipt") }) == true {
      throw failure("receipt_key_unavailable")
    }
    let key = SymmetricKey(size: .bits256)
    var insert = query
    insert[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
    insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let inserted = SecItemAdd(insert as CFDictionary, nil)
    if inserted == errSecDuplicateItem { return try self.key(create: false) }
    guard inserted == errSecSuccess else { throw failure("receipt_key_unavailable") }
    return key
  }
  @objc public static func prepare() -> Bool {
    do {
      let (directory, _, _) = try configuration()
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
      var url = directory
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try url.setResourceValues(values)
      _ = try key(create: true)
      return true
    } catch { return false }
  }
  @objc public static func capture(_ envelope: NSDictionary) -> Bool {
    do {
      let (directory, _, _) = try configuration()
      let identifier = UUID().uuidString
      let data = try JSONSerialization.data(withJSONObject: ["id": identifier, "envelope": envelope])
      guard data.count <= 65536 else { return false }
      let sealed = try AES.GCM.seal(data, using: key(create: false))
      guard let bytes = sealed.combined else { return false }
      try bytes.write(to: directory.appendingPathComponent(identifier + ".receipt"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      return true
    } catch { return false }
  }
  @objc public static func pending() -> [NSDictionary] { readPending(installationId: nil) }
  @objc(pendingForInstallation:) public static func pending(forInstallation installationId: String) -> [NSDictionary] {
    readPending(installationId: installationId)
  }
  private static func readPending(installationId: String?) -> [NSDictionary] {
    do {
      let (directory, _, _) = try configuration()
      let key = try key(create: false)
      return Array(try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey])
        .filter { $0.pathExtension == "receipt" }.sorted { $0.lastPathComponent < $1.lastPathComponent }.lazy.compactMap { url -> NSDictionary? in
          guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 65600,
                let bytes = try? Data(contentsOf: url), let box = try? AES.GCM.SealedBox(combined: bytes),
                let plain = try? AES.GCM.open(box, using: key),
                let row = (try? JSONSerialization.jsonObject(with: plain)) as? NSDictionary,
                let identifier = row["id"] as? String, identifier == url.deletingPathExtension().lastPathComponent else { return nil }
          if let installationId, (row["envelope"] as? NSDictionary)?["installationId"] as? String != installationId { return nil }
          return row
        }.prefix(32))
    } catch { return [] }
  }
  @objc public static func acknowledge(_ identifier: String) {
    guard UUID(uuidString: identifier) != nil, let (directory, _, _) = try? configuration() else { return }
    try? FileManager.default.removeItem(at: directory.appendingPathComponent(identifier + ".receipt"))
  }
}

@objc(GalinumNotificationService)
open class GalinumNotificationService: UNNotificationServiceExtension, URLSessionDownloadDelegate {
  private let lock = NSLock()
  private var handler: ((UNNotificationContent) -> Void)?
  private var content: UNMutableNotificationContent?
  private var session: URLSession?
  private var download: URLSessionDownloadTask?
  private func finish() {
    lock.lock()
    let callback = handler
    let delivered = content
    handler = nil
    let session = self.session
    self.session = nil
    lock.unlock()
    session?.invalidateAndCancel()
    if let callback, let delivered { callback(delivered) }
  }
  open override func didReceive(_ request: UNNotificationRequest, withContentHandler handler: @escaping (UNNotificationContent) -> Void) {
    guard let copy = request.content.mutableCopy() as? UNMutableNotificationContent else { handler(request.content); return }
    lock.lock()
    self.handler = handler
    content = copy
    lock.unlock()
    guard let envelope = copy.userInfo["galinum"] as? NSDictionary, envelope["version"] as? Int == 1,
          let push = envelope["content"] as? NSDictionary else { finish(); return }
    _ = GalinumReceiptStore.capture(envelope)
    guard let text = push["image"] as? String,
          let url = URL(string: text), url.scheme == "https", url.user == nil, url.password == nil else { finish(); return }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 10
    configuration.timeoutIntervalForResource = 15
    configuration.urlCache = nil
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    lock.lock()
    guard self.handler != nil else { lock.unlock(); session.invalidateAndCancel(); return }
    self.session = session
    let task = session.downloadTask(with: url)
    download = task
    lock.unlock()
    task.resume()
  }
  public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                         newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    guard request.url?.scheme == "https", request.url?.user == nil, request.url?.password == nil else { completionHandler(nil); return }
    completionHandler(request)
  }
  public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                         totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
    if totalBytesWritten > 5 * 1024 * 1024 || totalBytesExpectedToWrite > 5 * 1024 * 1024 { finish() }
  }
  public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    defer { finish() }
    guard let response = downloadTask.response as? HTTPURLResponse, response.statusCode == 200,
          let mime = response.mimeType, ["image/jpeg", "image/png", "image/gif"].contains(mime),
          let type = UTType(mimeType: mime), let suffix = type.preferredFilenameExtension,
          let size = try? location.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 5 * 1024 * 1024 else { return }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    let file = directory.appendingPathComponent("image." + suffix)
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try FileManager.default.moveItem(at: location, to: file)
      let attachment = try UNNotificationAttachment(identifier: "galinum-image", url: file)
      lock.lock()
      if handler != nil { content?.attachments = [attachment] }
      lock.unlock()
      try? FileManager.default.removeItem(at: directory)
    } catch { try? FileManager.default.removeItem(at: directory) }
  }
  public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if error != nil { finish() }
  }
  open override func serviceExtensionTimeWillExpire() { finish() }
}

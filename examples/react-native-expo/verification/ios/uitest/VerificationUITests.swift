import XCTest

final class VerificationUITests: XCTestCase {
  private let environment = ProcessInfo.processInfo.environment
  private var springboard: XCUIApplication { XCUIApplication(bundleIdentifier: "com.apple.springboard") }

  private func value(_ name: String) -> String { environment["GALINUM_UI_" + name] ?? "" }

  private func labelled(_ application: XCUIApplication, _ label: String) -> XCUIElement {
    application.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", label)).firstMatch
  }

  private func record(_ report: [String: Any]) {
    guard let path = environment["GALINUM_UI_RESULT"], let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) else { return }
    try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
  }

  func testDrive() {
    let mode = value("MODE")
    let label = value("LABEL")
    let timeout = TimeInterval(value("TIMEOUT")) ?? 30
    var report: [String: Any] = ["mode": mode, "label": label]
    switch mode {
    case "alert-allow":
      let button = springboard.alerts.buttons["Allow"].firstMatch
      let present = button.waitForExistence(timeout: timeout)
      report["alert"] = present
      if present { button.tap() }
    case "notification-tap":
      let banner = labelled(springboard, label)
      XCTAssertTrue(banner.waitForExistence(timeout: timeout), "banner absent")
      report["banner"] = banner.debugDescription
      banner.tap()
    case "notification-action":
      let banner = labelled(springboard, label)
      XCTAssertTrue(banner.waitForExistence(timeout: timeout), "banner absent")
      report["banner"] = banner.debugDescription
      banner.press(forDuration: 1.5)
      let action = springboard.buttons[value("ACTION")].firstMatch
      XCTAssertTrue(action.waitForExistence(timeout: 10), "action absent")
      report["action"] = action.debugDescription
      action.tap()
    case "app-tap":
      let application = XCUIApplication(bundleIdentifier: value("APP"))
      let button = application.buttons[label].firstMatch
      XCTAssertTrue(button.waitForExistence(timeout: timeout), "button absent")
      report["button"] = button.debugDescription
      button.tap()
      let confirmation = springboard.buttons["Open"].firstMatch
      if confirmation.waitForExistence(timeout: 6) {
        report["openConfirmation"] = confirmation.debugDescription
        confirmation.tap()
      }
    default:
      XCTFail("unknown mode")
    }
    report["springboard"] = springboard.debugDescription
    record(report)
  }
}

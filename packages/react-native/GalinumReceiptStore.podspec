require 'json'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
Pod::Spec.new do |s|
  s.name = 'GalinumReceiptStore'
  s.version = package['version']
  s.summary = 'Isolated notification extension receipts and media'
  s.homepage = package['homepage']
  s.license = package['license']
  s.author = 'Galinum'
  s.source = { :git => 'https://github.com/Galinum/galinum.git', :tag => "v#{s.version}" }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.0'
  s.source_files = 'ios-receipts/*.swift'
  s.frameworks = 'UserNotifications', 'CryptoKit', 'Security'
end

require 'json'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
Pod::Spec.new do |s|
  s.name = 'GalinumJournal'
  s.version = package['version']
  s.summary = package['description']
  s.homepage = package['homepage']
  s.license = package['license']
  s.author = 'Galinum'
  s.source = { :git => 'https://github.com/Galinum/galinum.git', :tag => "v#{s.version}" }
  s.platforms = { :ios => min_ios_version_supported }
  s.source_files = 'ios/**/*.{h,mm}'
  s.private_header_files = 'ios/GalinumJournalText.h'
  s.dependency 'SQLCipher', '4.10.0'
  s.pod_target_xcconfig = { 'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) SQLITE_HAS_CODEC=1' }
  install_modules_dependencies(s)
end

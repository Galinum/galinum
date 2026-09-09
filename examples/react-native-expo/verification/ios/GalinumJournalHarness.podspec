Pod::Spec.new do |s|
  s.name = 'GalinumJournalHarness'
  s.version = '0.0.0'
  s.summary = 'Verification-only journal harness'
  s.homepage = 'https://docs.galinum.com'
  s.license = 'Apache-2.0'
  s.author = 'Galinum'
  s.source = { :path => '.' }
  s.platforms = { :ios => '16.4' }
  s.source_files = 'JournalHarness.mm'
  s.pod_target_xcconfig = { 'HEADER_SEARCH_PATHS' => '$(inherited) "$(PODS_CONFIGURATION_BUILD_DIR)/GalinumReceiptStore/Swift Compatibility Header"' }
  s.dependency 'GalinumJournal'
  s.dependency 'React-Core'
  s.dependency 'GalinumReceiptStore'
end

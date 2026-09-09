require 'xcodeproj'
root = File.expand_path('../../../..', __dir__)
example = File.join(root, 'examples/react-native-expo')
ios = File.join(example, 'ios')
project_path = File.join(ios, 'GalinumNativeFoundation.xcodeproj')
project = Xcodeproj::Project.open(project_path)
app = project.targets.find { |target| target.name == 'GalinumNativeFoundation' }
abort 'Fixture already prepared' if project.targets.any? { |target| target.name == 'GalinumNotificationService' }

podfile = File.join(ios, 'Podfile')
contents = File.read(podfile)
harness = "  pod 'GalinumJournalHarness', :path => '../verification/ios'\n"
File.write(podfile, contents.sub(/^  use_expo_modules!\n/) { |line| line + harness }) unless contents.include?('GalinumJournalHarness')

delegate = File.join(ios, 'GalinumNativeFoundation/AppDelegate.swift')
embedded = 'return Bundle.main.url(forResource: "main", withExtension: "jsbundle")'
File.write(delegate, File.read(delegate).sub(/#if DEBUG\n.*?\n#else/m, "#if DEBUG\n    #{embedded}\n#else"))

node = `command -v node`.strip
abort 'node is not on PATH' if node.empty?
File.write(File.join(ios, '.xcode.env.local'), <<~ENV)
  export NODE_BINARY=#{node}
  unset SKIP_BUNDLING
  export FORCE_BUNDLING=1
  export CONFIGURATION=Release
  export ENTRY_FILE="$PROJECT_ROOT/verification/ios/integrated.ts"
ENV

plist_path = File.join(ios, 'GalinumNativeFoundation/Info.plist')
service_plist = Xcodeproj::Plist.read_from_path(File.join(__dir__, 'service/Info.plist'))
plist = Xcodeproj::Plist.read_from_path(plist_path)
%w[GalinumReceiptAppGroup GalinumReceiptKeychainGroup].each { |key| plist[key] = service_plist[key] }
Xcodeproj::Plist.write_to_path(plist, plist_path)

app.build_configurations.each do |configuration|
  configuration.build_settings['CODE_SIGN_ENTITLEMENTS'] = File.join(__dir__, 'Simulator.entitlements')
  flags = configuration.build_settings['OTHER_SWIFT_FLAGS']
  configuration.build_settings['OTHER_SWIFT_FLAGS'] = flags.sub(' -D EXPO_CONFIGURATION_DEBUG', '') if flags.is_a?(String)
end

name = 'GalinumNotificationService'
service = project.new_target(:app_extension, name, :ios, '16.4')
[File.join(root, 'packages/react-native/ios-receipts/GalinumReceiptStore.swift'), File.join(__dir__, 'service/NotificationService.swift')].each do |path|
  service.source_build_phase.add_file_reference(project.main_group.new_file(path))
end
service.build_configurations.each do |configuration|
  configuration.build_settings.merge!({
    'PRODUCT_NAME' => name,
    'PRODUCT_MODULE_NAME' => name,
    'PRODUCT_BUNDLE_IDENTIFIER' => 'com.galinum.nativefoundation.notificationservice',
    'INFOPLIST_FILE' => File.join(__dir__, 'service/Info.plist'),
    'SWIFT_VERSION' => '5.0',
    'CODE_SIGN_ENTITLEMENTS' => File.join(__dir__, 'service/Simulator.entitlements'),
    'APPLICATION_EXTENSION_API_ONLY' => 'YES',
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'SKIP_INSTALL' => 'YES',
  })
end
app.add_dependency(service)
phase = app.new_copy_files_build_phase('Embed Notification Service')
phase.dst_subfolder_spec = '13'
phase.add_file_reference(service.product_reference).settings = {'ATTRIBUTES' => ['RemoveHeadersOnCopy']}

ui = project.new_target(:ui_test_bundle, 'GalinumVerificationUITests', :ios, '16.4')
ui.source_build_phase.add_file_reference(project.main_group.new_file(File.join(__dir__, 'uitest/VerificationUITests.swift')))
ui.build_configurations.each do |configuration|
  configuration.build_settings.merge!({
    'PRODUCT_NAME' => 'GalinumVerificationUITests',
    'PRODUCT_MODULE_NAME' => 'GalinumVerificationUITests',
    'PRODUCT_BUNDLE_IDENTIFIER' => 'com.galinum.nativefoundation.uitests',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'SWIFT_VERSION' => '5.0',
    'CODE_SIGN_IDENTITY' => '-',
    'TARGETED_DEVICE_FAMILY' => '1,2',
  })
end
scheme = Xcodeproj::XCScheme.new
scheme.add_test_target(ui)
scheme.save_as(project_path, 'GalinumVerificationUITests', true)
project.save
puts 'Prepared iOS verification fixture: embedded bundle, simulator entitlements, receipt groups, extension and UI driver targets.'

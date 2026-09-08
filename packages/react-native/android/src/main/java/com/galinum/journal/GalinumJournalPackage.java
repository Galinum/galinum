package com.galinum.journal;

import com.facebook.react.BaseReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.module.model.ReactModuleInfo;
import com.facebook.react.module.model.ReactModuleInfoProvider;
import java.util.Collections;

public final class GalinumJournalPackage extends BaseReactPackage {
  @Override
  public NativeModule getModule(String name, ReactApplicationContext context) {
    return name.equals(GalinumJournalModule.NAME) ? new GalinumJournalModule(context) : null;
  }
  @Override
  public ReactModuleInfoProvider getReactModuleInfoProvider() {
    return ()
               -> Collections.singletonMap(GalinumJournalModule.NAME,
                   new ReactModuleInfo(GalinumJournalModule.NAME, GalinumJournalModule.NAME, false,
                       false, false, true));
  }
}

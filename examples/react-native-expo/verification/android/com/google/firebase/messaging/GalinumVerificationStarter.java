package com.google.firebase.messaging;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ResolveInfo;

public final class GalinumVerificationStarter {
  private GalinumVerificationStarter() {}
  public static String resolvedService(Context context) {
    ResolveInfo info = context.getPackageManager().resolveService(new Intent("com.google.firebase.MESSAGING_EVENT").setPackage(context.getPackageName()), 0);
    return info == null || info.serviceInfo == null ? "" : info.serviceInfo.name;
  }
  public static int start(Context context, Intent intent) throws Exception {
    return com.google.android.gms.tasks.Tasks.await(new FcmBroadcastProcessor(context).process(intent), 20, java.util.concurrent.TimeUnit.SECONDS);
  }
}

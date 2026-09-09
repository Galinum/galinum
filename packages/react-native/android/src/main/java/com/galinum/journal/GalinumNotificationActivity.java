package com.galinum.journal;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

public final class GalinumNotificationActivity {
  private GalinumNotificationActivity() {}
  public static boolean onCreate(Activity activity, Bundle savedInstanceState) {
    return JournalActor.capture(activity, activity.getIntent(), savedInstanceState);
  }
  public static boolean onNewIntent(Activity activity, Intent intent) {
    return JournalActor.capture(activity, intent, true);
  }
}

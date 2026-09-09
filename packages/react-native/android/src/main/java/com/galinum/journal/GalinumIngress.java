package com.galinum.journal;

import android.content.Context;

public final class GalinumIngress {
  private GalinumIngress() {}
  public static String receive(Context context, String envelope) {
    try {
      return JournalActor.ingress(context, envelope, GalinumNotifications.foreground(context));
    } catch (JournalActor.Failure failure) {
      return "{\"state\":\"failed\",\"code\":\"" + failure.code + "\"}";
    } catch (Exception error) {
      return "{\"state\":\"failed\",\"code\":\"journal_storage_failure\"}";
    }
  }
}

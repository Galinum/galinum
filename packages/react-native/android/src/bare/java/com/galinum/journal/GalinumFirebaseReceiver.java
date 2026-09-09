package com.galinum.journal;

import android.content.Context;
import android.content.Intent;
import io.invertase.firebase.messaging.ReactNativeFirebaseMessagingReceiver;

public class GalinumFirebaseReceiver extends ReactNativeFirebaseMessagingReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    String messageType = intent.getStringExtra("message_type");
    String envelope = intent.getStringExtra("galinum");
    if (intent.getExtras() == null || envelope == null || messageType != null && !"gcm".equals(messageType) || intent.getStringExtra("google.message_id") == null) {
      super.onReceive(context, intent);
      return;
    }
    GalinumIngressService.submit(context.getApplicationContext(), envelope, intent.getFlags(), goAsync());
  }
}

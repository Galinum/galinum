package com.galinum.journal;

import com.google.firebase.messaging.RemoteMessage;
import expo.modules.notifications.service.ExpoFirebaseMessagingService;

public class GalinumExpoMessagingService extends ExpoFirebaseMessagingService {
  @Override
  public void onMessageReceived(RemoteMessage message) {
    String envelope = message.getData().get("galinum");
    if (envelope == null) {
      super.onMessageReceived(message);
      return;
    }
    GalinumIngress.receive(getApplicationContext(), envelope);
  }
}

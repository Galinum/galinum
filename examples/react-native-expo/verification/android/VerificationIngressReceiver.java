package com.galinum.journal;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Iterator;
import org.json.JSONObject;

public final class VerificationIngressReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    PendingResult pending = goAsync();
    new Thread(() -> {
      try { receive(context.getApplicationContext(), intent); }
      finally { pending.finish(); }
    }, "verification-ingress").start();
  }
  private void receive(Context context, Intent intent) {
    String name = intent.getStringExtra("file");
    JSONObject result = new JSONObject();
    try {
      if (name == null || !name.matches("[a-z0-9-]+\\.json"))
        throw new IllegalArgumentException("file");
      File file = new File(context.getFilesDir(), name);
      JSONObject message = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
      if (message.has("resume")) {
        java.util.concurrent.CountDownLatch latch = JournalHarness.pauses.remove(message.getString("resume"));
        if (latch != null) latch.countDown();
        return;
      }
      Intent delivery = new Intent("com.google.android.c2dm.intent.RECEIVE").setPackage(context.getPackageName());
      JSONObject data = message.getJSONObject("data");
      for (Iterator<String> keys = data.keys(); keys.hasNext();) {
        String key = keys.next();
        delivery.putExtra(key, data.getString(key));
      }
      if (message.optBoolean("foregroundFlag", false)) delivery.addFlags(Intent.FLAG_RECEIVER_FOREGROUND);
      delivery.putExtra("verification.failService", message.optBoolean("failService", false));
      delivery.putExtra("verification.delayService", message.optBoolean("delayService", false));
      delivery.putExtra("google.message_id", message.getString("messageId"));
      delivery.putExtra("from", message.optString("from", "verification"));
      delivery.putExtra("google.sent_time", System.currentTimeMillis());
      delivery.putExtra("google.original_priority", "high");
      delivery.putExtra("google.delivered_priority", "high");
      result.put("resolvedService", com.google.firebase.messaging.GalinumVerificationStarter.resolvedService(context));
      if (message.optString("carrier").equals("bare")) {
        delivery.setComponent(new android.content.ComponentName(context, "com.galinum.journal.VerificationBareReceiver"));
        context.sendBroadcast(delivery);
        result.put("startResult", -1).put("carrier", "bare-private-alias");
      } else result.put("startResult", com.google.firebase.messaging.GalinumVerificationStarter.start(context, delivery));
      result.put("pid", android.os.Process.myPid()).put("label", "injected-receiver-test; not provider delivery");
    } catch (Exception error) {
      try { result.put("error", String.valueOf(error)); } catch (Exception ignored) {}
    }
    try {
      File out = new File(context.getFilesDir(), "ingress-result.json");
      Files.write(out.toPath(), result.toString().getBytes(StandardCharsets.UTF_8));
    } catch (Exception ignored) {}
  }
}

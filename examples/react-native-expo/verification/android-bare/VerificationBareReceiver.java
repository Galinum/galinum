package com.galinum.journal;

public final class VerificationBareReceiver extends GalinumFirebaseReceiver {
  @Override public void onReceive(android.content.Context context, android.content.Intent intent) {
    boolean fail = intent.getBooleanExtra("verification.failService", false);
    boolean delay = intent.getBooleanExtra("verification.delayService", false);
    android.content.Context wrapped = new android.content.ContextWrapper(context.getApplicationContext()) {
      @Override public android.content.Context getApplicationContext() { return this; }
      @Override public android.content.ComponentName startService(android.content.Intent service) {
        if (fail) throw new IllegalStateException("verification_forced_start_failure");
        if (!delay) return super.startService(service);
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> getBaseContext().startService(service), 1500);
        return service.getComponent();
      }
    };
    super.onReceive(wrapped, intent);
  }
}

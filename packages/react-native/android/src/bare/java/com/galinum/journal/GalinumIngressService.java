package com.galinum.journal;

import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

public final class GalinumIngressService extends Service {
  private static final ExecutorService ingress = Executors.newSingleThreadExecutor();
  private static final ScheduledExecutorService guards = Executors.newSingleThreadScheduledExecutor();
  private static final Map<Long, Job> jobs = new LinkedHashMap<>();
  private static long nextJob;
  private static GalinumIngressService service;
  private int latestStartId;

  private static final class Job {
    final long id, receivedAt, guardMs, processAgeMs;
    final int flags;
    final Context context;
    final String envelope;
    final BroadcastReceiver.PendingResult broadcast;
    final AtomicBoolean finished = new AtomicBoolean();
    volatile ScheduledFuture<?> guard;
    Job(Context context, String envelope, int flags, BroadcastReceiver.PendingResult broadcast) {
      this.id = ++nextJob;
      this.context = context;
      this.envelope = envelope;
      this.flags = flags;
      this.broadcast = broadcast;
      this.receivedAt = SystemClock.elapsedRealtime();
      this.processAgeMs = Build.VERSION.SDK_INT >= 24 ? receivedAt - android.os.Process.getStartElapsedRealtime() : 9000;
      this.guardMs = Math.max(0, Math.min(1000, 9000 - processAgeMs));
    }
    void finish(String reason) {
      if (!finished.compareAndSet(false, true)) return;
      ScheduledFuture<?> scheduled = guard;
      if (scheduled != null) scheduled.cancel(false);
      try { broadcast.finish(); }
      finally { event("broadcast-finished", this, reason); }
    }
    void run() {
      PowerManager.WakeLock wake = null;
      try {
        try {
          PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
          wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "galinum:ingress");
          wake.acquire(30000);
        } catch (RuntimeException failure) { event("ingress-wakelock-unavailable", this, failure.getClass().getSimpleName()); }
        try {
          JournalActor.pause("ingress-service-before-start");
          context.startService(new Intent(context, GalinumIngressService.class));
          event("ingress-service-requested", this, "");
        } catch (RuntimeException failure) { event("ingress-service-unavailable", this, failure.getClass().getSimpleName()); }
        JournalActor.ingress(context, envelope, GalinumNotifications.foreground(context), () -> finish("receipt-durable"), false);
        event("ingress-job-settled", this, "");
      } catch (Exception failure) {
        event("ingress-job-failed", this, failure instanceof JournalActor.Failure ? ((JournalActor.Failure) failure).code : "journal_storage_failure");
      } finally {
        try { finish("ingress-settled"); }
        finally {
          try { if (wake != null && wake.isHeld()) wake.release(); }
          finally {
            synchronized (GalinumIngressService.class) {
              jobs.remove(id);
              stopIfIdle();
            }
          }
        }
      }
    }
  }
  private static void event(String kind, Job job, String reason) {
    try {
      JournalActor.record(kind, new JSONObject().put("job", job.id).put("flags", job.flags).put("processAgeMs", job.processAgeMs).put("guardMs", job.guardMs).put("elapsedMs", SystemClock.elapsedRealtime() - job.receivedAt), reason);
    } catch (Exception ignored) {}
  }
  static synchronized void submit(Context context, String envelope, int flags, BroadcastReceiver.PendingResult broadcast) {
    Job job = new Job(context, envelope, flags, broadcast);
    jobs.put(job.id, job);
    event("ingress-job-queued", job, "");
    job.guard = guards.schedule(() -> job.finish("guard"), job.guardMs, TimeUnit.MILLISECONDS);
    if (job.finished.get()) job.guard.cancel(false);
    ingress.execute(job::run);
    event("broadcast-returning", job, "");
  }
  private static void stopIfIdle() {
    if (!jobs.isEmpty() || service == null) return;
    boolean stopped = service.stopSelfResult(service.latestStartId);
    try { JournalActor.record("ingress-service-stop", new JSONObject().put("startId", service.latestStartId).put("stopped", stopped).put("jobs", jobs.size()), ""); }
    catch (Exception ignored) {}
  }
  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    synchronized (GalinumIngressService.class) {
      service = this;
      latestStartId = startId;
      try { JournalActor.record("ingress-service-start", new JSONObject().put("startId", startId).put("jobs", jobs.size()), ""); }
      catch (Exception ignored) {}
      stopIfIdle();
    }
    return START_NOT_STICKY;
  }
  @Override public void onDestroy() {
    synchronized (GalinumIngressService.class) { if (service == this) service = null; }
    super.onDestroy();
  }
  @Override public IBinder onBind(Intent intent) { return null; }
}

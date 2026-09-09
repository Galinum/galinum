package com.galinum.journal;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.database.Cursor;
import android.os.Bundle;
import com.facebook.react.bridge.Promise;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONObject;

public final class FaultCaptureActivity extends Activity {
  JSONObject config, result;
  volatile Fixture fixture;
  volatile String failure = "", barrier = "";
  volatile CountDownLatch blocked = new CountDownLatch(1);
  volatile boolean reached;
  volatile int reserves;
  final JournalActor.Hooks hooks = new JournalActor.Hooks() {
    public void checkpoint(String point) {
      try {
        if (point.equals(failure)) {
          event("injected-failure", new JSONObject(), point);
          if (point.equals("capture-commit-before")) fixture.actor.db.execSQL("INSERT INTO missing_capture_fault_table VALUES(1)");
          throw new IllegalStateException("injected " + point);
        }
        if (point.equals(barrier)) {
          reached = true;
          JSONObject snapshot = fixture == null || fixture.actor.db == null ? new JSONObject() : fixture.snapshotNow();
          save("boundary", snapshot.put("point", point).put("tray", tray()));
          event("pause-reached", new JSONObject(), point);
          blocked.await();
        }
      } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
      catch (RuntimeException error) { throw error; }
      catch (Exception error) { throw new RuntimeException(error); }
    }
    public void event(String kind, JSONObject data, String detail) {
      try {
        if (kind.equals("reserve-interaction")) reserves++;
        JSONObject entry = new JSONObject(data.toString()).put("event", kind).put("detail", detail)
            .put("pid", android.os.Process.myPid()).put("nanos", android.os.SystemClock.elapsedRealtimeNanos());
        synchronized (FaultCaptureActivity.class) {
          try (FileOutputStream stream = new FileOutputStream(new File(getFilesDir(), "trace.jsonl"), true)) {
            stream.write((entry + "\n").getBytes(StandardCharsets.UTF_8)); stream.getFD().sync();
          }
        }
      } catch (Exception error) { throw new RuntimeException(error); }
    }
  };
  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);
    try {
      config = new JSONObject(new String(Files.readAllBytes(new File(getFilesDir(), "config.json").toPath()), StandardCharsets.UTF_8));
      result = new JSONObject().put("phase", config.getString("phase")).put("restored", saved != null);
      JournalActor.hooks = hooks;
      if (config.getString("phase").equals("kill")) barrier = config.getString("point");
      if (config.has("scope")) fixture = new Fixture(config.getString("scope"), config.getString("installation"));
      GalinumNotificationActivity.onCreate(this, saved);
      new Thread(() -> {
        try { run(); result.put("verified", true); }
        catch (Throwable error) {
          try { result.put("verified", false).put("error", error.toString()).put("stack", android.util.Log.getStackTraceString(error)); }
          catch (Exception ignored) {}
        }
        finally {
          try { save("result", result); } catch (Exception error) { throw new RuntimeException(error); }
        }
      }, "capture-fault-proof").start();
    } catch (Exception error) { throw new RuntimeException(error); }
  }
  @Override public void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    GalinumNotificationActivity.onNewIntent(this, intent);
  }
  void save(String name, JSONObject value) throws Exception {
    value.put("pid", android.os.Process.myPid());
    try (FileOutputStream stream = new FileOutputStream(new File(getFilesDir(), name + ".json"))) {
      stream.write(value.toString().getBytes(StandardCharsets.UTF_8)); stream.getFD().sync();
    }
  }
  static void check(boolean value, String label) { if (!value) throw new AssertionError(label); }
  static Object call(Consumer<Promise> operation) throws Exception {
    CompletableFuture<Object> future = new CompletableFuture<>();
    Promise promise = (Promise) Proxy.newProxyInstance(Promise.class.getClassLoader(), new Class<?>[] {Promise.class}, (proxy, method, args) -> {
      if (method.getName().equals("resolve")) future.complete(args[0]);
      if (method.getName().equals("reject")) future.completeExceptionally(new IllegalStateException(String.valueOf(args[0])));
      return null;
    });
    operation.accept(promise);
    return future.get(20, TimeUnit.SECONDS);
  }
  void ui(Runnable action) throws Exception {
    CompletableFuture<Void> done = new CompletableFuture<>();
    runOnUiThread(() -> { try { action.run(); done.complete(null); } catch (Throwable error) { done.completeExceptionally(error); } });
    done.get(20, TimeUnit.SECONDS);
  }
  interface Condition { boolean get() throws Exception; }
  void waitFor(Condition condition, String label) throws Exception {
    long until = android.os.SystemClock.elapsedRealtime() + 15000;
    while (!condition.get()) {
      if (android.os.SystemClock.elapsedRealtime() > until) throw new AssertionError(label);
      Thread.sleep(10);
    }
  }
  JSONArray tray() throws Exception {
    JSONArray result = new JSONArray();
    for (android.service.notification.StatusBarNotification notification : ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).getActiveNotifications())
      result.put(new JSONObject().put("tag", notification.getTag()).put("id", notification.getId()));
    return result;
  }
  boolean visible(String target) throws Exception {
    JSONArray rows = tray();
    for (int index = 0; index < rows.length(); index++) if (rows.getJSONObject(index).getString("tag").equals("galinum:" + target)) return true;
    return false;
  }
  final class Fixture {
    final String scope, installation;
    final JournalActor actor;
    String owner;
    long operation;
    long generation = 1;
    String user = "A";
    Fixture() { this(UUID.randomUUID().toString().replace("-", "") + UUID.randomUUID().toString().replace("-", ""), UUID.randomUUID().toString().replace("-", "")); }
    Fixture(String scope, String installation) {
      this.scope = scope; this.installation = installation;
      actor = JournalActor.getOrCreate(FaultCaptureActivity.this, scope);
    }
    void attach() throws Exception {
      owner = actor.attach();
      call(p -> actor.open(owner, p));
      actor.resolveInitial(0);
    }
    void seed() throws Exception {
      attach(); identify("A");
      call(p -> actor.configureNotifications(owner, "{\"channels\":[{\"id\":\"faults\",\"name\":\"Capture faults\"}],\"actions\":[{\"id\":\"open\",\"title\":\"Open\"}]}", p));
    }
    JSONObject state(String user) throws Exception {
      return new JSONObject().put("scope", scope).put("installationId", installation)
          .put("session", new JSONObject().put("userId", user).put("consent", true))
          .put("bindingRevision", generation).put("acknowledgedBindingRevision", generation)
          .put("pending", JSONObject.NULL).put("token", JSONObject.NULL);
    }
    void control(String user) throws Exception {
      if (!this.user.equals(user)) generation++;
      this.user = user;
      JSONObject row = actor.executor.submit(actor::controlRow).get();
      long revision = row == null ? -1 : row.getLong("revision");
      String encoded = state(user).toString(), id = owner + ":" + (++operation);
      call(p -> actor.commitControl(owner, id, revision, encoded, true, p));
    }
    void publish(boolean confirmed) throws Exception {
      String encoded = new JSONObject().put("installationId", installation).put("generation", generation)
          .put("userId", user).put("bindingRevision", generation).put("acknowledgedBindingRevision", generation)
          .put("appConfirmed", confirmed).toString();
      call(p -> actor.publish(0, encoded, p));
      JSONObject row = actor.executor.submit(actor::controlRow).get();
      String proposal = actor.proposeDisplay(new JSONObject().put("deadlineMs", 10000).put("controlRevision", row.getLong("revision"))
          .put("userId", user).put("operationId", owner + ":" + operation).toString());
      call(p -> actor.publishDisplay(owner, proposal, p));
    }
    void identify(String user) throws Exception { control(user); publish(true); }
    void recover() throws Exception { call(p -> actor.readControl(owner, p)); }
    String post(String target) throws Exception {
      JSONObject envelope = new JSONObject().put("version", 1).put("targetId", target).put("attemptId", target + "-attempt")
          .put("installationId", installation).put("bindingGeneration", generation).put("test", true)
          .put("content", new JSONObject().put("title", "Capture " + target).put("body", "Native capture fault proof")
              .put("destination", new JSONObject().put("kind", "app").put("url", "fault-proof://open"))
              .put("android", new JSONObject().put("channelId", "faults"))
              .put("actions", new JSONArray().put(new JSONObject().put("id", "open").put("title", "Open"))));
      JSONObject receipt = new JSONObject(JournalActor.ingress(FaultCaptureActivity.this, envelope.toString(), false));
      check(receipt.getString("state").equals("displayed"), "post failed " + receipt);
      waitFor(() -> visible(target), "notification visible");
      return actor.executor.submit(() -> {
        try (Cursor row = actor.db.rawQuery("SELECT handle FROM notifications WHERE target_id=?", new String[] {target})) { row.moveToFirst(); return row.getString(0); }
      }).get();
    }
    void capture(String handle) throws Exception {
      ui(() -> onNewIntent(new Intent(getIntent()).putExtra("galinum.scope", scope).putExtra("galinum.handle", handle).putExtra("galinum.action", "open")));
    }
    void idle() throws Exception {
      actor.executor.submit(() -> {}).get(20, TimeUnit.SECONDS);
      waitFor(() -> { synchronized (actor) { return actor.nativeJobs == 0 && actor.leaseWork == 0; } }, "native settled");
    }
    JSONObject snapshotNow() throws Exception {
      JSONObject value = new JSONObject();
      for (String table : new String[] {"notifications", "interactions", "observations", "commands"}) {
        JSONArray entries = new JSONArray();
        try (Cursor cursor = actor.db.rawQuery("SELECT * FROM " + table, null)) {
          while (cursor.moveToNext()) {
            JSONObject row = new JSONObject();
            for (int index = 0; index < cursor.getColumnCount(); index++) row.put(cursor.getColumnName(index), cursor.isNull(index) ? JSONObject.NULL : cursor.getString(index));
            entries.put(row);
          }
        }
        value.put(table, entries);
      }
      return value;
    }
    JSONObject snapshot() throws Exception { return actor.executor.submit(this::snapshotNow).get(20, TimeUnit.SECONDS); }
    int interactions() throws Exception { return snapshot().getJSONArray("interactions").length(); }
    void finish() throws Exception { failure = ""; call(p -> actor.cancelNotifications(owner, p)); call(p -> actor.release(true, p)); }
  }
  void retry(String point) throws Exception {
    Fixture f = fixture = new Fixture(); f.seed();
    String target = "retry-" + UUID.randomUUID(), handle = f.post(target);
    int before = reserves;
    failure = point; f.capture(handle); f.idle();
    JSONObject failed = f.snapshot();
    check(failed.getJSONArray("interactions").length() == 0 && failed.getJSONArray("notifications").length() == 1 && visible(target), "failed capture keeps action recoverable");
    failure = ""; f.capture(handle); f.idle();
    result.put(point, new JSONObject().put("failed", failed).put("retried", f.snapshot()).put("reserves", reserves - before));
    check(f.interactions() == 1 && reserves - before == 2, "same Activity redelivery must retry failed capture");
    check(!visible(target), "successful retry cancels notification");
    f.capture(handle); f.idle(); check(f.interactions() == 1, "consumed redelivery deduplicates"); f.finish();
  }
  void activeDuplicate() throws Exception {
    Fixture f = fixture = new Fixture(); f.seed();
    String handle = f.post("active-" + UUID.randomUUID()); int before = reserves;
    barrier = config.optString("point", "capture-before-bootstrap"); reached = false; blocked = new CountDownLatch(1);
    f.capture(handle); waitFor(() -> reached, "active capture paused");
    f.capture(handle); check(reserves - before == 1, "active duplicate deduplicates");
    barrier = ""; blocked.countDown(); f.idle();
    check(f.interactions() == 1, "active capture once"); result.put("activeDuplicate", f.snapshot()); f.finish();
  }
  void cancellation(String recovery) throws Exception {
    Fixture f = fixture = new Fixture(); f.seed();
    String target = recovery + "-" + UUID.randomUUID(), handle = f.post(target);
    failure = "notification-cancel-before"; f.capture(handle); f.idle();
    JSONObject failed = f.snapshot();
    result.put(recovery, new JSONObject().put("failed", failed).put("trayAfterFailure", tray()));
    check(failed.getJSONArray("interactions").length() == 1 && failed.getJSONArray("notifications").length() == 1 && visible(target), "committed capture retains cleanup owner");
    f.capture(handle); f.idle(); check(f.interactions() == 1, "durable duplicate while cleanup fails");
    call(p -> f.actor.acknowledgeInteraction(0, handle, "handled", p));
    String targetB = target + "-B";
    if (recovery.equals("switch") || recovery.equals("replacement")) {
      try { f.control("B"); throw new AssertionError("switch cleanup must fail"); } catch (java.util.concurrent.ExecutionException expected) {}
      f.publish(true);
      f.post(recovery.equals("replacement") ? target : targetB);
    }
    failure = "";
    if (recovery.equals("same-user")) f.identify("A");
    else if (recovery.equals("capture")) f.capture(handle);
    else f.recover();
    f.idle();
    if (recovery.equals("replacement")) check(visible(target), "replacement handle preserves B notification");
    else check(!visible(target), "recovery cancels captured A notification");
    if (recovery.equals("switch")) check(visible(targetB), "switch preserves B notification");
    result.getJSONObject(recovery).put("recovered", f.snapshot()).put("trayRecovered", tray());
    check(f.interactions() == 1, "recovery no duplicate interaction"); f.finish();
  }
  void run() throws Exception {
    switch (config.getString("phase")) {
      case "retry": retry(config.getString("point")); break;
      case "active": activeDuplicate(); break;
      case "cancel": cancellation(config.getString("recovery")); break;
      case "seed-failed":
      case "seed": {
        Fixture f = fixture = new Fixture(); f.seed();
        String target = "death-" + UUID.randomUUID(), handle = f.post(target);
        if (config.getString("phase").equals("seed-failed")) {
          failure = "capture-before-bootstrap"; f.capture(handle); f.idle(); failure = "";
          check(f.interactions() == 0 && visible(target), "settled failure retains capture");
        }
        result.put("scope", f.scope).put("installation", f.installation).put("target", target).put("handle", handle).put("state", f.snapshot());
        break;
      }
      case "kill": {
        waitFor(() -> reached, "kill boundary reached");
        result.put("boundary", barrier);
        break;
      }
      case "recover": {
        Fixture f = fixture;
        f.idle();
        f.attach();
        boolean unconfirmed = false;
        try { call(p -> f.actor.readInteractions(0, p)); } catch (java.util.concurrent.ExecutionException expected) { unconfirmed = true; }
        result.put("unconfirmedBlocked", unconfirmed).put("beforeIdentify", f.snapshot());
        f.identify(config.optString("user", "A")); f.idle();
        JSONArray interactions = new JSONArray((String) call(p -> f.actor.readInteractions(0, p)));
        result.put("available", interactions).put("state", f.snapshot()).put("tray", tray());
        check(unconfirmed, "no unconfirmed interaction delivery");
        check(f.interactions() == 1, "kill recovery exactly one interaction");
        check(interactions.length() == (f.user.equals("A") ? 1 : 0), "recovered identity delivery");
        check(!visible(config.getString("target")), "kill recovery cleanup");
        f.capture(config.getString("handle")); f.idle(); check(f.interactions() == 1, "restart duplicate suppressed");
        f.finish();
        break;
      }
      default: throw new AssertionError("unknown phase");
    }
  }
}

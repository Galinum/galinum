package com.galinum.journal;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.*;
import com.facebook.react.uimanager.ViewManager;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import org.json.JSONArray;
import org.json.JSONObject;

public final class JournalHarness extends ReactContextBaseJavaModule {
  static volatile boolean loseReply;
  static volatile JournalActor failingControl;
  static final Map<String, CountDownLatch> pauses = new java.util.concurrent.ConcurrentHashMap<>();
  static final Set<String> reached = java.util.concurrent.ConcurrentHashMap.newKeySet();
  static final List<JSONObject> events = Collections.synchronizedList(new ArrayList<>());
  static final List<JSONObject> submissions = Collections.synchronizedList(new ArrayList<>());
  static volatile File traceFile;
  static synchronized void install(android.content.Context context) {
    traceFile = new File(context.getFilesDir(), "native-trace.jsonl");
    JournalActor.hooks = instrumentation;
  }
  static final JournalActor.Hooks instrumentation = new JournalActor.Hooks() {
    public void checkpoint(String point) {
      if (point.equals("control-commit-before") && failingControl != null) {
        event("injected-sql-failure", new JSONObject(), point);
        failingControl.db.execSQL("INSERT INTO galinum_missing_fault_table VALUES(1)");
      }
      if (point.equals("control-commit-after") && loseReply) { loseReply = false;throw new JournalActor.Failure("journal_storage_failure"); }
      CountDownLatch latch = pauses.get(point);
      if (latch == null) return;
      reached.add(point);
      event("pause-reached", new JSONObject(), point);
      try { latch.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
      event("pause-released", new JSONObject(), point);
    }
    public void event(String kind, JSONObject data, String detail) {
      try {
        JSONObject entry = new JSONObject(data.toString()).put("kind",kind).put("detail",detail)
          .put("nanos",android.os.SystemClock.elapsedRealtimeNanos()).put("thread",Thread.currentThread().getName()).put("pid",android.os.Process.myPid());
        events.add(entry);
        File target = traceFile;
        if (target != null) synchronized (submissions) {
          try (java.io.FileOutputStream output = new java.io.FileOutputStream(target, true)) { output.write((entry.toString() + "\n").getBytes(StandardCharsets.UTF_8)); output.getFD().sync(); }
        }
      } catch (Exception error) { throw new RuntimeException(error); }
    }
  };
  public JournalHarness(ReactApplicationContext context) {
    super(context);
    install(context.getApplicationContext());
  }
  @Override
  public String getName() {
    return "JournalHarness";
  }
  @ReactMethod(isBlockingSynchronousMethod = true)
  public String config() throws Exception {
    return new String(
        Files.readAllBytes(
            new File(getReactApplicationContext().getFilesDir(), "journal-config.json").toPath()),
        StandardCharsets.UTF_8);
  }
  @ReactMethod(isBlockingSynchronousMethod = true)
  public double now() {
    return (double) android.os.SystemClock.elapsedRealtimeNanos();
  }
  @ReactMethod(isBlockingSynchronousMethod = true)
  public String resolvedService() {
    return com.google.firebase.messaging.GalinumVerificationStarter.resolvedService(getReactApplicationContext());
  }
  @ReactMethod(isBlockingSynchronousMethod = true)
  public String bareReceiver() throws Exception {
    android.content.Context context = getReactApplicationContext();
    return context.getPackageManager().getReceiverInfo(new android.content.ComponentName(context, "com.galinum.journal.GalinumFirebaseReceiver"), 0).name;
  }
  @ReactMethod(isBlockingSynchronousMethod = true)
  public String tap(String scope, String owner, String observation) throws Exception {
    return JournalActor.get(scope, owner).reserveNative(new JSONObject(observation));
  }
  @ReactMethod(isBlockingSynchronousMethod = true)
  public boolean pause(String point) {
    pauses.put(point, new CountDownLatch(1));
    reached.remove(point);
    return true;
  }
  @ReactMethod(isBlockingSynchronousMethod = true)
  public boolean resume(String point) {
    CountDownLatch latch = pauses.remove(point);
    if (latch != null)
      latch.countDown();
    return latch != null;
  }
  @ReactMethod(isBlockingSynchronousMethod = true)
  public boolean reached(String point) {
    return reached.contains(point);
  }
  @ReactMethod(isBlockingSynchronousMethod = true)
  public String trace() {
    JSONArray entries = new JSONArray();
    synchronized (events) {
      for (JSONObject entry : events) entries.put(entry);
      events.clear();
    }
    return entries.toString();
  }
  @ReactMethod
  public void block(String scope, Promise promise) {
    JournalActor actor = JournalActor.getOrCreate(getReactApplicationContext(), scope);
    actor.work(promise, () -> {
      JournalActor.pause("executor");
      return null;
    });
  }
  @ReactMethod
  public void submit(String scope, Promise promise) {
    JournalActor.getOrCreate(getReactApplicationContext(), scope).submitIfCurrent(publication -> { submissions.add(publication);instrumentation.checkpoint("submission-handoff"); }, promise);
  }
  @ReactMethod
  public void inspect(String scope, Promise promise) {
    bootstrapAndInspectKernel(getReactApplicationContext(), scope, promise);
  }
  static void bootstrapAndInspectKernel(android.content.Context context, String scope, Promise promise) {
    JournalActor actor;
    try {
      actor = JournalActor.getOrCreate(context, scope);
    } catch (JournalActor.Failure failure) {
      JournalActor.fail(promise, failure);
      return;
    }
    actor.work(promise, () -> {
      JSONObject result = new JSONObject()
                              .put("pid", android.os.Process.myPid())
                              .put("registry", actor.registryFile.getName())
                              .put("key", actor.keyFile.getName())
                              .put("db", actor.file.getName())
                              .put("registryExists", actor.registryFile.exists())
                              .put("keyExists", actor.keyFile.exists())
                              .put("dbExists", actor.file.exists())
                              .put("dbBytes", actor.file.exists() ? actor.file.length() : 0)
                              .put("aliasExists", actor.aliasExists());
      try {
        actor.bootstrap();
        result.put("bootstrap", "ready").put("incarnation", actor.incarnation);
      } catch (JournalActor.Failure failure) {
        return result.put("bootstrap", failure.code).toString();
      }
      JSONObject row = actor.controlRow();
      result.put("control", row == null ? JSONObject.NULL : row);
      synchronized (actor) {
        result.put("memoryDisplayOpen", actor.displayOpen).put("fence", actor.displayFence).put("restrictions", actor.restrictions).put("leaseLive", !actor.released).put("inFlight", actor.leaseWork).put("submitted", new JSONArray(submissions));
      }
      try (android.database.Cursor rows = actor.db.rawQuery("SELECT id,revision,kind,disposition FROM operations ORDER BY revision", null)) {
        JSONArray operations = new JSONArray();
        while (rows.moveToNext())
          operations.put(new JSONObject().put("id", rows.getString(0)).put("revision", rows.getLong(1)).put("kind", rows.getString(2)).put("disposition", rows.getString(3)));
        result.put("operations", operations);
      }
      try (android.database.Cursor rows = actor.db.rawQuery("SELECT generation,user_id,next_sequence,acknowledged FROM streams ORDER BY generation", null)) {
        JSONArray streams = new JSONArray();
        while (rows.moveToNext())
          streams.put(new JSONObject().put("generation", rows.getLong(0)).put("userId", rows.isNull(1) ? JSONObject.NULL : rows.getString(1)).put("nextSequence", rows.getLong(2)).put("acknowledged", rows.getLong(3)));
        result.put("streams", streams);
      }
      try (android.database.Cursor rows = actor.db.rawQuery("SELECT generation,sequence,id FROM commands ORDER BY generation,sequence", null)) {
        JSONArray commands = new JSONArray();
        while (rows.moveToNext())
          commands.put(new JSONObject().put("generation", rows.getLong(0)).put("sequence", rows.getLong(1)).put("id", rows.getString(2)));
        result.put("commands", commands);
      }
      try (android.database.Cursor rows = actor.db.rawQuery("SELECT ordinal,process,ticket,kind,target_id,attempt_id,action_id,binding_generation,user_id,status FROM observations ORDER BY ordinal", null)) {
        JSONArray observations = new JSONArray();
        while (rows.moveToNext())
          observations.put(new JSONObject().put("ordinal", rows.getLong(0)).put("process", rows.getString(1)).put("ticket", rows.isNull(2) ? JSONObject.NULL : rows.getString(2)).put("kind", rows.getString(3)).put("targetId", rows.getString(4)).put("attemptId", rows.getString(5)).put("actionId", rows.isNull(6) ? JSONObject.NULL : rows.getString(6)).put("bindingGeneration", rows.getLong(7)).put("userId", rows.isNull(8) ? JSONObject.NULL : rows.getString(8)).put("status", rows.getString(9)));
        result.put("observations", observations);
      }
      try (android.database.Cursor rows = actor.db.rawQuery("SELECT id,ordinal,kind,action_id,target_id,user_id,binding_generation,status FROM interactions ORDER BY ordinal", null)) {
        JSONArray interactions = new JSONArray();
        while (rows.moveToNext())
          interactions.put(new JSONObject().put("id", rows.getString(0)).put("ordinal", rows.getLong(1)).put("kind", rows.getString(2)).put("actionId", rows.isNull(3) ? JSONObject.NULL : rows.getString(3)).put("targetId", rows.getString(4)).put("userId", rows.getString(5)).put("bindingGeneration", rows.getLong(6)).put("status", rows.getString(7)));
        result.put("interactions", interactions);
      }
      try (android.database.Cursor rows = actor.db.rawQuery("SELECT target_id,attempt_id,notification_id,user_id,binding_generation FROM notifications", null)) {
        JSONArray notifications = new JSONArray();
        while (rows.moveToNext())
          notifications.put(new JSONObject().put("targetId", rows.getString(0)).put("attemptId", rows.getString(1)).put("notificationId", rows.getLong(2)).put("userId", rows.getString(3)).put("bindingGeneration", rows.getLong(4)));
        result.put("notifications", notifications);
      }
      try (android.database.Cursor rows = actor.db.rawQuery("SELECT feedback_id,user_id,delivery_id,type,shown_feedback_id,status FROM feedback ORDER BY ordinal", null)) {
        JSONArray feedback = new JSONArray();
        while (rows.moveToNext())
          feedback.put(new JSONObject().put("feedbackId", rows.getString(0)).put("userId", rows.getString(1)).put("deliveryId", rows.getString(2)).put("type", rows.getString(3)).put("shownFeedbackId", rows.isNull(4) ? JSONObject.NULL : rows.getString(4)).put("status", rows.getString(5)));
        result.put("feedback", feedback);
      }
      try (android.database.Cursor rows = actor.db.rawQuery("SELECT foreground,channels,actions FROM settings WHERE id=1", null)) {
        result.put("settings", rows.moveToFirst() ? new JSONObject().put("foreground", rows.getString(0)).put("channels", new JSONArray(rows.getString(1))).put("actions", new JSONArray(rows.getString(2))) : JSONObject.NULL);
      }
      try (android.database.Cursor rows = actor.db.rawQuery("SELECT binding FROM metadata WHERE id=1", null)) {
        result.put("binding", rows.moveToFirst() && !rows.isNull(0) ? new JSONObject(rows.getString(0)) : JSONObject.NULL);
      }
      return result.toString();
    });
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  public String leaseState(String scope) throws Exception {
    JournalActor actor = JournalActor.getOrCreate(getReactApplicationContext(), scope);
    synchronized (actor) {
      return new JSONObject().put("released", actor.released).put("leaseWork", actor.leaseWork).put("nativeJobs", actor.nativeJobs).put("displayOpen", actor.displayOpen).toString();
    }
  }
  @ReactMethod
  public void ingress(String encoded, Promise promise) {
    new Thread(() -> {
      try { promise.resolve(JournalActor.ingress(getReactApplicationContext(), encoded, false)); }
      catch (Throwable error) { JournalActor.fail(promise, error); }
    }, "repair-ingress").start();
  }
  @ReactMethod(isBlockingSynchronousMethod = true)
  public String tray() throws Exception {
    JSONArray notifications = new JSONArray();
    android.app.NotificationManager manager = (android.app.NotificationManager) getReactApplicationContext().getSystemService(android.content.Context.NOTIFICATION_SERVICE);
    for (android.service.notification.StatusBarNotification posted : manager.getActiveNotifications()) {
      if (posted.getTag() == null || !posted.getTag().startsWith("galinum:")) continue;
      JSONArray actions = new JSONArray();
      if (posted.getNotification().actions != null)
        for (android.app.Notification.Action action : posted.getNotification().actions) actions.put(action.title.toString());
      notifications.put(new JSONObject().put("tag", posted.getTag()).put("actions", actions));
    }
    return notifications.toString();
  }
  @ReactMethod
  public void capturePosted(String scope, String target, boolean fresh, Promise promise) {
    JournalActor actor = JournalActor.getOrCreate(getReactApplicationContext(), scope);
    actor.executor.execute(() -> {
      try {
        String handle;
        try (android.database.Cursor row = actor.db.rawQuery("SELECT handle FROM notifications WHERE target_id=?", new String[] {target})) {
          if (!row.moveToFirst()) throw new IllegalStateException("notification_missing");
          handle = row.getString(0);
        }
        android.app.Activity activity = getReactApplicationContext().getCurrentActivity();
        activity.runOnUiThread(() -> {
          android.content.Intent intent = new android.content.Intent(activity.getIntent()).putExtra("galinum.scope", scope).putExtra("galinum.handle", handle);
          JournalActor.capture(activity, intent, fresh);
          promise.resolve(handle);
        });
      } catch (Throwable error) { JournalActor.fail(promise, error); }
    });
  }
  @ReactMethod
  public void recapture(String scope, String handle, boolean fresh, Promise promise) {
    android.app.Activity activity = getReactApplicationContext().getCurrentActivity();
    activity.runOnUiThread(() -> {
      android.content.Intent intent = new android.content.Intent(activity.getIntent()).putExtra("galinum.scope", scope).putExtra("galinum.handle", handle);
      JournalActor.capture(activity, intent, fresh);
      promise.resolve(null);
    });
  }
  @ReactMethod(isBlockingSynchronousMethod = true)
  public boolean loseNextReply() { loseReply = true;return true; }
  @ReactMethod(isBlockingSynchronousMethod = true)
  public boolean reloadLease(String scope, String owner) {
    JournalActor actor = JournalActor.get(scope, owner);
    new Thread(() -> actor.release(false, null)).start();
    return true;
  }
  @ReactMethod
  public void files(String scope, Promise promise) {
    JournalActor actor = JournalActor.getOrCreate(getReactApplicationContext(), scope);
    actor.work(promise, () -> new JSONObject().put("dbExists",actor.file.exists())
      .put("registryExists",actor.registryFile.exists()).put("keyExists",actor.keyFile.exists()).toString());
  }
  @ReactMethod(isBlockingSynchronousMethod = true)
  public boolean failControlWrites(String scope, boolean fail) {
    failingControl = fail ? JournalActor.getOrCreate(getReactApplicationContext(), scope) : null;
    return true;
  }
  @ReactMethod
  public void removeControl(String scope, Promise promise) {
    JournalActor actor = JournalActor.getOrCreate(getReactApplicationContext(), scope);
    actor.work(promise, () -> actor.transaction(() -> {
      actor.db.execSQL("DELETE FROM control");
      actor.db.execSQL("DELETE FROM operations");
      return null;
    }));
  }
  @ReactMethod
  public void capacity(String scope, String owner, boolean constrained, Promise promise) {
    JournalActor actor = JournalActor.get(scope, owner);
    actor.executor.execute(() -> {
      try {
        long pages;
        try (android.database.Cursor row = actor.db.rawQuery("PRAGMA page_count", null)) {
          row.moveToFirst();
          pages = row.getLong(0);
        }
        long limit = constrained ? pages : 1048576;
        try (android.database.Cursor row =
                 actor.db.rawQuery("PRAGMA max_page_count=" + limit, null)) {
          row.moveToFirst();
          limit = row.getLong(0);
        }
        String version;
        try (android.database.Cursor row = actor.db.rawQuery("PRAGMA cipher_version", null)) {
          row.moveToFirst();
          version = row.getString(0);
        }
        promise.resolve(new JSONObject()
                            .put("pages", pages)
                            .put("limit", limit)
                            .put("cipherVersion", version)
                            .toString());
      } catch (Exception error) {
        promise.reject("fixture_failure", "fixture_failure");
      }
    });
  }
  @ReactMethod
  public void save(String phase, String encoded, Promise promise) {
    try {
      if (!phase.matches("[a-z0-9-]+"))
        throw new Exception();
      JSONObject result = new JSONObject(encoded);
      result.put("pid", android.os.Process.myPid());
      File path =
          new File(getReactApplicationContext().getFilesDir(), "journal-" + phase + ".json");
      try (java.io.FileOutputStream output = new java.io.FileOutputStream(path)) {
        output.write(result.toString().getBytes(StandardCharsets.UTF_8));
        output.getFD().sync();
      }
      promise.resolve(null);
    } catch (Exception error) {
      promise.reject("fixture_failure", "fixture_failure");
    }
  }
  public static final class Package implements ReactPackage {
    @Override
    public List<NativeModule> createNativeModules(ReactApplicationContext context) {
      return Arrays.asList(new JournalHarness(context));
    }
    @Override
    public List<ViewManager> createViewManagers(ReactApplicationContext context) {
      return Collections.emptyList();
    }
  }
}

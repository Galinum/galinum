package com.galinum.journal;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.*;
import com.facebook.react.uimanager.ViewManager;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import org.json.JSONObject;

public final class JournalHarness extends ReactContextBaseJavaModule {
  public JournalHarness(ReactApplicationContext context) {
    super(context);
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
  public String tap(String scope, String owner, String observation) throws Exception {
    return JournalActor.get(scope, owner).reserveNative(new JSONObject(observation));
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
      if (!phase.matches("[a-z]+"))
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

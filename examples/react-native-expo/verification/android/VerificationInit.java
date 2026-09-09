package com.galinum.journal;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;

public final class VerificationInit extends ContentProvider {
  @Override
  public boolean onCreate() {
    JournalHarness.install(getContext().getApplicationContext());
    try {
      java.io.File file = new java.io.File(getContext().getFilesDir(), "journal-config.json");
      org.json.JSONObject config = new org.json.JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()), java.nio.charset.StandardCharsets.UTF_8));
      String point = config.optString("pause", "");
      if (config.optString("phase").equals("repair-before-death")) point = "capture-before-bootstrap";
      if (!point.isEmpty()) JournalHarness.pauses.put(point, new java.util.concurrent.CountDownLatch(1));
    } catch (Exception ignored) {}
    return true;
  }
  @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) { return null; }
  @Override public String getType(Uri uri) { return null; }
  @Override public Uri insert(Uri uri, ContentValues values) { return null; }
  @Override public int delete(Uri uri, String selection, String[] args) { return 0; }
  @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { return 0; }
}

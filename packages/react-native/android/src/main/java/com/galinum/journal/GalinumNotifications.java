package com.galinum.journal;

import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.os.Build;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.util.Iterator;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

final class GalinumNotifications {
  static final String TAG_PREFIX = "galinum:";
  private static final String IDENTIFIER = "[A-Za-z0-9_.-]{1,64}";
  private GalinumNotifications() {}

  static JSONObject parseEnvelope(String encoded) {
    try {
      JSONObject envelope = new JSONObject(encoded);
      if (envelope.getInt("version") != 1 || envelope.length() > 7)
        throw new JournalActor.Failure("invalid_envelope");
      for (String key : new String[] {"targetId", "attemptId", "installationId"}) {
        String value = envelope.getString(key);
        if (value.isEmpty() || value.length() > 256)
          throw new JournalActor.Failure("invalid_envelope");
      }
      if (!envelope.getString("installationId").matches("[a-f0-9]{32}"))
        throw new JournalActor.Failure("invalid_envelope");
      long generation = envelope.getLong("bindingGeneration");
      if (generation < 0 || generation > 9007199254740991L)
        throw new JournalActor.Failure("invalid_envelope");
      envelope.getBoolean("test");
      JSONObject content = envelope.getJSONObject("content");
      String title = content.getString("title"), body = content.getString("body");
      if (title.isEmpty() || title.length() > 256 || body.isEmpty() || body.length() > 4096)
        throw new JournalActor.Failure("invalid_envelope");
      JSONObject destination = content.getJSONObject("destination");
      String kind = destination.getString("kind"), url = destination.getString("url");
      if (!(kind.equals("website") || kind.equals("app")) || url.isEmpty() || url.length() > 2048)
        throw new JournalActor.Failure("invalid_envelope");
      if (kind.equals("website") && !url.startsWith("https://"))
        throw new JournalActor.Failure("invalid_envelope");
      if (content.has("data")) {
        JSONObject data = content.getJSONObject("data");
        if (data.length() > 32)
          throw new JournalActor.Failure("invalid_envelope");
        for (Iterator<String> keys = data.keys(); keys.hasNext();) {
          String key = keys.next();
          if (!(data.get(key) instanceof String) || key.length() > 64 || data.getString(key).length() > 1024)
            throw new JournalActor.Failure("invalid_envelope");
        }
      }
      if (content.has("actions")) {
        JSONArray actions = content.getJSONArray("actions");
        if (actions.length() > 3)
          throw new JournalActor.Failure("invalid_envelope");
        for (int index = 0; index < actions.length(); index++) {
          JSONObject action = actions.getJSONObject(index);
          if (!action.getString("id").matches(IDENTIFIER) || action.getString("title").isEmpty() || action.getString("title").length() > 64)
            throw new JournalActor.Failure("invalid_envelope");
        }
      }
      if (content.has("image") && (content.getString("image").isEmpty() || content.getString("image").length() > 2048))
        throw new JournalActor.Failure("invalid_envelope");
      if (content.has("android") && !content.getJSONObject("android").getString("channelId").matches(IDENTIFIER))
        throw new JournalActor.Failure("invalid_envelope");
      return envelope;
    } catch (JournalActor.Failure failure) {
      throw failure;
    } catch (Exception error) {
      throw new JournalActor.Failure("invalid_envelope");
    }
  }

  static JSONObject parseSetup(String encoded) {
    try {
      JSONObject setup = new JSONObject(encoded);
      String foreground = setup.optString("foreground", "display");
      if (!foreground.equals("display") && !foreground.equals("suppress"))
        throw new JournalActor.Failure("invalid_setup");
      JSONArray channels = setup.optJSONArray("channels") == null ? new JSONArray() : setup.getJSONArray("channels");
      JSONArray actions = setup.optJSONArray("actions") == null ? new JSONArray() : setup.getJSONArray("actions");
      if (channels.length() > 16 || actions.length() > 3)
        throw new JournalActor.Failure("invalid_setup");
      for (int index = 0; index < channels.length(); index++) {
        JSONObject channel = channels.getJSONObject(index);
        String importance = channel.optString("importance", "default");
        if (!channel.getString("id").matches(IDENTIFIER) || channel.getString("name").isEmpty() || channel.getString("name").length() > 64
            || !(importance.equals("default") || importance.equals("high") || importance.equals("low")))
          throw new JournalActor.Failure("invalid_setup");
      }
      for (int index = 0; index < actions.length(); index++) {
        JSONObject action = actions.getJSONObject(index);
        if (!action.getString("id").matches(IDENTIFIER) || action.getString("title").isEmpty() || action.getString("title").length() > 64)
          throw new JournalActor.Failure("invalid_setup");
      }
      JSONObject android = setup.optJSONObject("android");
      String smallIcon = android == null ? "" : android.optString("smallIcon", "");
      if (!smallIcon.isEmpty() && !smallIcon.matches("[a-z][a-z0-9_]{0,63}"))
        throw new JournalActor.Failure("invalid_setup");
      return new JSONObject().put("foreground", foreground).put("channels", channels).put("actions", actions).put("smallIcon", smallIcon);
    } catch (JournalActor.Failure failure) {
      throw failure;
    } catch (Exception error) {
      throw new JournalActor.Failure("invalid_setup");
    }
  }

  static JSONObject setup(Context context, JSONObject setup) throws Exception {
    NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    JSONArray channels = setup.getJSONArray("channels");
    JSONArray ready = new JSONArray();
    for (int index = 0; index < channels.length(); index++) {
      JSONObject channel = channels.getJSONObject(index);
      String id = channel.getString("id");
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        ready.put(id);
        continue;
      }
      NotificationChannel existing = manager.getNotificationChannel(id);
      if (existing == null) {
        String importance = channel.optString("importance", "default");
        int level = importance.equals("high") ? NotificationManager.IMPORTANCE_HIGH : importance.equals("low") ? NotificationManager.IMPORTANCE_LOW : NotificationManager.IMPORTANCE_DEFAULT;
        manager.createNotificationChannel(new NotificationChannel(id, channel.getString("name"), level));
        existing = manager.getNotificationChannel(id);
      }
      if (existing != null)
        ready.put(id);
    }
    JSONArray actionIds = new JSONArray();
    JSONArray actions = setup.getJSONArray("actions");
    for (int index = 0; index < actions.length(); index++) actionIds.put(actions.getJSONObject(index).getString("id"));
    return new JSONObject().put("actions", actionIds).put("channels", ready).put("richImages", true);
  }

  static boolean foreground(Context context) {
    ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
    List<ActivityManager.RunningAppProcessInfo> processes = manager == null ? null : manager.getRunningAppProcesses();
    if (processes == null)
      return false;
    for (ActivityManager.RunningAppProcessInfo process : processes)
      if (process.pid == android.os.Process.myPid())
        return process.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
    return false;
  }

  static String platformReason(Context context, JSONObject envelope, JSONObject settings) throws Exception {
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled())
      return "notifications-disabled";
    JSONObject content = envelope.getJSONObject("content");
    if (!content.has("android"))
      return "no-channel";
    String channelId = content.getJSONObject("android").getString("channelId");
    boolean configured = false;
    JSONArray channels = settings.getJSONArray("channels");
    for (int index = 0; index < channels.length(); index++)
      if (channels.getString(index).equals(channelId))
        configured = true;
    if (!configured)
      return "channel-not-configured";
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
      NotificationChannel channel = manager.getNotificationChannel(channelId);
      if (channel == null)
        return "channel-missing";
      if (channel.getImportance() == NotificationManager.IMPORTANCE_NONE)
        return "channel-blocked";
    }
    JSONArray actions = content.optJSONArray("actions");
    JSONArray registered = settings.getJSONArray("actions");
    for (int index = 0; actions != null && index < actions.length(); index++) {
      boolean known = false;
      for (int candidate = 0; candidate < registered.length(); candidate++)
        if (registered.getJSONObject(candidate).getString("id").equals(actions.getJSONObject(index).getString("id")))
          known = true;
      if (!known)
        return "action-not-registered";
    }
    return null;
  }

  static Bitmap image(Context context, JSONObject envelope) throws Exception {
    String address = envelope.getJSONObject("content").optString("image", "");
    if (address.isEmpty()) return null;
    URI uri = new URI(address);
    boolean local = (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0
        && ("10.0.2.2".equals(uri.getHost()) || "127.0.0.1".equals(uri.getHost()) || "localhost".equals(uri.getHost()));
    if (uri.getUserInfo() != null || !("https".equals(uri.getScheme()) || local && "http".equals(uri.getScheme())))
      throw new JournalActor.Failure("image_unavailable");
    HttpURLConnection connection = (HttpURLConnection) uri.toURL().openConnection();
    connection.setConnectTimeout(3000);
    connection.setReadTimeout(3000);
    connection.setInstanceFollowRedirects(false);
    try {
      if (connection.getResponseCode() != 200 || connection.getContentLengthLong() > 1048576)
        throw new JournalActor.Failure("image_unavailable");
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      long deadline = android.os.SystemClock.elapsedRealtime() + 4000;
      try (InputStream input = connection.getInputStream()) {
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer)) != -1) {
          if (bytes.size() + count > 1048576 || android.os.SystemClock.elapsedRealtime() > deadline)
            throw new JournalActor.Failure("image_unavailable");
          bytes.write(buffer, 0, count);
        }
      }
      byte[] encoded = bytes.toByteArray();
      BitmapFactory.Options options = new BitmapFactory.Options();
      options.inJustDecodeBounds = true;
      BitmapFactory.decodeByteArray(encoded, 0, encoded.length, options);
      if (options.outWidth <= 0 || options.outHeight <= 0 || (long) options.outWidth * options.outHeight > 40000000)
        throw new JournalActor.Failure("image_unavailable");
      options.inSampleSize = 1;
      while ((long) (options.outWidth / options.inSampleSize) * (options.outHeight / options.inSampleSize) > 1048576)
        options.inSampleSize *= 2;
      options.inJustDecodeBounds = false;
      Bitmap bitmap = BitmapFactory.decodeByteArray(encoded, 0, encoded.length, options);
      if (bitmap == null) throw new JournalActor.Failure("image_unavailable");
      return bitmap;
    } finally { connection.disconnect(); }
  }

  private static PendingIntent launch(Context context, String scope, String handle, String actionId, int requestCode) {
    Intent launcher = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
    if (launcher == null)
      throw new JournalActor.Failure("launch_activity_missing");
    Intent intent = new Intent(Intent.ACTION_MAIN).setComponent(launcher.getComponent()).setPackage(context.getPackageName())
                        .addCategory(Intent.CATEGORY_LAUNCHER)
                        .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                        .setData(android.net.Uri.parse("galinum-notification://" + scope + "/" + handle + "/" + (actionId == null ? "tap" : "action/" + actionId)))
                        .putExtra("galinum.handle", handle)
                        .putExtra("galinum.scope", scope)
                        .putExtra("galinum.action", actionId == null ? "" : actionId);
    return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
  }

  private static int smallIcon(Context context, JSONObject settings) {
    String name = settings.optString("smallIcon", "");
    if (!name.isEmpty()) {
      int drawable = context.getResources().getIdentifier(name, "drawable", context.getPackageName());
      if (drawable != 0)
        return drawable;
      int mipmap = context.getResources().getIdentifier(name, "mipmap", context.getPackageName());
      if (mipmap != 0)
        return mipmap;
    }
    ApplicationInfo info = context.getApplicationInfo();
    return info.icon != 0 ? info.icon : android.R.drawable.ic_dialog_info;
  }

  static void post(Context context, String scope, JSONObject envelope, String handle, int notificationId, JSONObject settings, Bitmap image) throws Exception {
    JSONObject content = envelope.getJSONObject("content");
    String targetId = envelope.getString("targetId");
    NotificationCompat.Builder builder = new NotificationCompat.Builder(context, content.getJSONObject("android").getString("channelId"))
                                             .setSmallIcon(smallIcon(context, settings))
                                             .setContentTitle(content.getString("title"))
                                             .setContentText(content.getString("body"))
                                             .setStyle(new NotificationCompat.BigTextStyle().bigText(content.getString("body")))
                                             .setAutoCancel(true)
                                             .setOnlyAlertOnce(true)
                                             .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                                             .setContentIntent(launch(context, scope, handle, null, (handle + ":tap").hashCode()));
    if (image != null) builder.setStyle(new NotificationCompat.BigPictureStyle().bigPicture(image).setSummaryText(content.getString("body")));
    JSONArray actions = content.optJSONArray("actions");
    for (int index = 0; actions != null && index < actions.length(); index++) {
      JSONObject action = actions.getJSONObject(index);
      String title = action.getString("title");
      builder.addAction(new NotificationCompat.Action.Builder(0, title, launch(context, scope, handle, action.getString("id"), (handle + ":" + action.getString("id")).hashCode())).build());
    }
    Notification notification = builder.build();
    NotificationManagerCompat.from(context).notify(TAG_PREFIX + targetId, notificationId, notification);
  }

  static void cancel(Context context, String targetId, int notificationId) {
    try {
      JournalActor.pause("notification-cancel-before");
      NotificationManagerCompat.from(context).cancel(TAG_PREFIX + targetId, notificationId);
    } catch (RuntimeException error) {
      throw new JournalActor.Failure("notifications_unavailable");
    }
  }
}

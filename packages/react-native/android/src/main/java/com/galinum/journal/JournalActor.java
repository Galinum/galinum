package com.galinum.journal;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteFullException;
import android.os.SystemClock;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.system.Os;
import android.system.OsConstants;
import com.facebook.react.bridge.Promise;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import net.zetetic.database.sqlcipher.SQLiteDatabase;
import org.json.JSONArray;
import org.json.JSONObject;

final class JournalActor {
  private static final Map<String, JournalActor> actors = new HashMap<>();
  static final String processIncarnation = UUID.randomUUID().toString();
  private static final String CAPTURES_STATE = "com.galinum.pendingCaptures";
  private static final Map<android.app.Activity, LinkedHashMap<String, PendingCapture>> pendingCaptures = new java.util.WeakHashMap<>();
  private static boolean captureCallbacksRegistered;
  private static final class PendingCapture {
    final String scope, handle, actionId;
    boolean active;
    PendingCapture(String scope, String handle, String actionId) {
      this.scope = scope;
      this.handle = handle;
      this.actionId = actionId;
    }
    String key() { return scope + ":" + handle; }
    JSONObject json() throws Exception {
      return new JSONObject().put("scope", scope).put("handle", handle).put("actionId", actionId == null ? JSONObject.NULL : actionId);
    }
  }
  private interface CaptureCompletion { void settled(boolean consumed); }
  interface Hooks {
    default void checkpoint(String point) {}
    default void event(String kind, JSONObject data, String detail) {}
  }
  static Hooks hooks = new Hooks() {};
  interface InteractionSink { void interaction(String scope); }
  static volatile InteractionSink interactionSink = scope -> {};
  interface Submission { void submit(JSONObject publication) throws Exception; }
  final ExecutorService executor = Executors.newSingleThreadExecutor();
  final File file, registryFile, keyFile;
  final String scope, keyAlias;
  final Context context;
  final LinkedHashMap<String, Ticket> tickets = new LinkedHashMap<>();
  final Map<String, Proposal> proposals = new HashMap<>();
  long submittedCount = 0;
  String owner = null;
  boolean released = true;
  int leaseWork = 0;
  int nativeJobs = 0;
  long nextTicket = 0, nextProposal = 0, lastOperation = 0;
  long intent = 0;
  boolean initialResolved = false;
  boolean ready = false;
  boolean displayOpen = false;
  long displayFence = 0;
  long restrictions = 0;
  String incarnation;
  JSONObject binding;
  volatile String installationKey;
  SQLiteDatabase db;

  static final class Failure extends RuntimeException {
    final String code;
    Failure(String code) {
      super(code);
      this.code = code;
    }
  }
  static final class Ticket {
    final String id, eventId;
    long intent;
    final long ordinal;
    long observationOrdinal = 0;
    JSONObject event;
    JSONObject observation;
    final ArrayList<Promise> promises = new ArrayList<>();
    boolean rejected;
    Ticket(String owner, long ordinal, long intent, String eventId) {
      this.id = owner + ":" + ordinal;
      this.ordinal = ordinal;
      this.intent = intent;
      this.eventId = eventId.isEmpty() ? this.id : eventId;
    }
  }
  static final class Proposal {
    final String id, userId, operationId;
    final long fence, deadline, controlRevision;
    Proposal(String id, long fence, long deadline, long controlRevision, String userId, String operationId) {
      this.id = id;
      this.fence = fence;
      this.deadline = deadline;
      this.controlRevision = controlRevision;
      this.userId = userId;
      this.operationId = operationId;
    }
  }
  static void pause(String point) { hooks.checkpoint(point); }
  static void record(String kind, JSONObject data, String detail) { hooks.event(kind, data, detail); }
  private JournalActor(Context context, String scope) {
    if (!scope.matches("[a-f0-9]{64}"))
      throw new Failure("invalid_scope");
    this.scope = scope;
    this.context = context.getApplicationContext();
    File directory = new File(context.getApplicationInfo().dataDir, "no_backup");
    file = new File(directory, "galinum-journal-" + scope + ".db");
    registryFile = new File(directory, "galinum-control-" + scope + ".json");
    keyFile = new File(directory, "galinum-control-" + scope + ".key");
    keyAlias = "galinum-journal-" + scope;
  }
  static synchronized JournalActor getOrCreate(Context context, String scope) {
    JournalActor actor = actors.get(scope);
    if (actor == null) {
      actor = new JournalActor(context, scope);
      actors.put(scope, actor);
    }
    return actor;
  }
  static synchronized JournalActor existing(String scope) {
    return actors.get(scope);
  }
  static String claim(Context context, String scope) {
    return getOrCreate(context, scope).attach();
  }
  synchronized String attach() {
    if (!released || leaseWork > 0)
      throw new Failure("journal_writer_busy");
    owner = UUID.randomUUID().toString();
    lastOperation = 0;
    released = false;
    intent = 0;
    initialResolved = false;
    ready = false;
    binding = null;
    displayFence++;
    for (Ticket ticket : tickets.values()) ticket.rejected = true;
    proposals.clear();
    record("attach", new JSONObject(), owner);
    executor.execute(this::drain);
    return owner;
  }
  static synchronized JournalActor get(String scope, String owner) {
    JournalActor actor = actors.get(scope);
    if (actor == null || actor.released || !owner.equals(actor.owner))
      throw new Failure("journal_owner_stale");
    return actor;
  }
  synchronized String reserve(long capture, String eventId) {
    if (released || capture != intent)
      throw new Failure("superseded");
    if (!eventId.isEmpty())
      for (Ticket prior : tickets.values())
        if (!prior.rejected && prior.intent == capture && prior.eventId.equals(eventId)) {
          try {
            return new JSONObject().put("id", prior.id).put("eventId", prior.eventId).put("reused", true).toString();
          } catch (Exception error) {
            throw new Failure("invalid_event");
          }
        }
    Ticket ticket = new Ticket(owner, ++nextTicket, capture, eventId);
    tickets.put(ticket.id, ticket);
    try {
      record("reserve", new JSONObject().put("ordinal", ticket.ordinal).put("eventId", ticket.eventId), ticket.id);
      return new JSONObject().put("id", ticket.id).put("eventId", ticket.eventId).toString();
    } catch (Exception error) {
      throw new Failure("invalid_event");
    }
  }
  synchronized long setIntent(long value) {
    if (value < intent)
      throw new Failure("superseded");
    intent = value;
    ready = false;
    displayOpen = false;
    displayFence++;
    restrictions++;
    for (Ticket ticket : tickets.values())
      if (ticket.intent < value && (ticket.intent != 0 || initialResolved))
        ticket.rejected = true;
    record("set-intent", new JSONObject(), "" + value);
    executor.execute(this::drain);
    return displayFence;
  }
  synchronized long restrictDisplay() {
    displayOpen = false;
    displayFence++;
    restrictions++;
    record("restrict-display", new JSONObject(), "" + displayFence);
    return displayFence;
  }
  synchronized String proposeDisplay(String encoded) {
    if (released)
      throw new Failure("journal_owner_stale");
    try {
      JSONObject proposal = new JSONObject(encoded);
      String id = owner + ":proposal:" + (++nextProposal);
      long deadline = SystemClock.elapsedRealtimeNanos() + (long) (proposal.getDouble("deadlineMs") * 1000000.0);
      proposals.put(id, new Proposal(id, displayFence, deadline, proposal.getLong("controlRevision"), proposal.getString("userId"), proposal.getString("operationId")));
      record("propose-display", new JSONObject().put("fence", displayFence), id);
      return id;
    } catch (Failure failure) {
      throw failure;
    } catch (Exception error) {
      throw new Failure("invalid_proposal");
    }
  }
  synchronized void resolveInitial(long destination) {
    if (initialResolved)
      return;
    initialResolved = true;
    for (Ticket ticket : tickets.values())
      if (ticket.intent == 0) {
        if (destination == intent)
          ticket.intent = destination;
        else
          ticket.rejected = true;
      }
    executor.execute(this::drain);
  }
  synchronized void reject(String id) {
    Ticket ticket = tickets.get(id);
    if (ticket != null)
      ticket.rejected = true;
    executor.execute(this::drain);
  }
  private synchronized void current(long capture) {
    if (released || capture != intent)
      throw new Failure("superseded");
  }
  private synchronized void leaseCurrent(String lease) {
    if (released || !lease.equals(owner))
      throw new Failure("journal_owner_stale");
  }
  private void opened() {
    if (db == null)
      throw new Failure("journal_not_open");
  }
  void work(Promise promise, Callable<Object> action) {
    synchronized (this) {
      leaseWork++;
    }
    executor.execute(() -> {
      try {
        Object result = action.call();
        if (promise != null)
          promise.resolve(result);
      } catch (Throwable error) {
        if (promise != null)
          fail(promise, error);
      } finally {
        synchronized (this) {
          leaseWork--;
        }
      }
    });
  }
  static void fail(Promise promise, Throwable error) {
    String code = error instanceof Failure ? ((Failure) error).code
        : (error instanceof SQLiteFullException
              || error instanceof android.database.sqlite.SQLiteException
                  && String.valueOf(error.getMessage()).matches("(?s).*\\bcode 13\\b.*"))
        ? "journal_storage_full"
        : "journal_storage_failure";
    promise.reject(code, "Galinum " + code);
  }
  <T> T transaction(Callable<T> body) throws Exception {
    db.beginTransaction();
    Throwable primary = null;
    try {
      T value = body.call();
      db.setTransactionSuccessful();
      return value;
    } catch (Throwable error) {
      primary = error;
      throw error;
    } finally {
      try {
        db.endTransaction();
      } catch (Throwable cleanup) {
        if (primary != null)
          primary.addSuppressed(cleanup);
        else
          throw cleanup;
      }
    }
  }
  private long number(String sql, String... args) {
    try (Cursor cursor = db.rawQuery(sql, args)) {
      if (!cursor.moveToFirst())
        throw new Failure("journal_corrupt");
      return cursor.getLong(0);
    }
  }

  private static String hex(byte[] bytes) {
    StringBuilder builder = new StringBuilder();
    for (byte value : bytes) builder.append(String.format("%02x", value));
    return builder.toString();
  }
  private static byte[] readAll(File target) throws Exception {
    try (FileInputStream input = new FileInputStream(target)) {
      byte[] buffer = new byte[(int) target.length()];
      int offset = 0;
      while (offset < buffer.length) {
        int count = input.read(buffer, offset, buffer.length - offset);
        if (count < 0)
          throw new Failure("journal_storage_failure");
        offset += count;
      }
      return buffer;
    }
  }
  private static void writeDurable(File target, byte[] bytes) throws Exception {
    File temporary = new File(target.getParentFile(), target.getName() + ".tmp");
    try (FileOutputStream output = new FileOutputStream(temporary)) {
      output.write(bytes);
      output.getFD().sync();
    }
    if (!temporary.renameTo(target))
      throw new Failure("journal_storage_failure");
    FileDescriptor directory = Os.open(target.getParentFile().getAbsolutePath(), OsConstants.O_RDONLY, 0);
    try {
      Os.fsync(directory);
    } finally {
      Os.close(directory);
    }
  }
  private JSONObject readRegistry() throws Exception {
    if (!registryFile.exists())
      return null;
    try {
      JSONObject registry = new JSONObject(new String(readAll(registryFile), StandardCharsets.UTF_8));
      if (registry.getInt("schema") != 2 || !registry.getString("incarnation").matches("[a-f0-9]{32}"))
        throw new Failure("journal_corrupt");
      return registry;
    } catch (Failure failure) {
      throw failure;
    } catch (Exception error) {
      throw new Failure("journal_corrupt");
    }
  }
  boolean aliasExists() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    return store.containsAlias(keyAlias);
  }
  private byte[] generateWrappedKey() throws Exception {
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    generator.init(new KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                       .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                       .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                       .setKeySize(256)
                       .build());
    SecretKey wrapping = generator.generateKey();
    byte[] key = new byte[32];
    new SecureRandom().nextBytes(key);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, wrapping);
    byte[] iv = cipher.getIV(), sealed = cipher.doFinal(key);
    Arrays.fill(key, (byte) 0);
    byte[] wrapped = new byte[iv.length + sealed.length];
    System.arraycopy(iv, 0, wrapped, 0, iv.length);
    System.arraycopy(sealed, 0, wrapped, iv.length, sealed.length);
    return wrapped;
  }
  private byte[] unwrapKey(byte[] wrapped) throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    KeyStore.Entry entry = store.getEntry(keyAlias, null);
    if (!(entry instanceof KeyStore.SecretKeyEntry))
      throw new Failure("journal_key_missing");
    if (wrapped.length < 13)
      throw new Failure("journal_corrupt");
    try {
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE, ((KeyStore.SecretKeyEntry) entry).getSecretKey(), new GCMParameterSpec(128, Arrays.copyOfRange(wrapped, 0, 12)));
      byte[] key = cipher.doFinal(Arrays.copyOfRange(wrapped, 12, wrapped.length));
      if (key.length != 32)
        throw new Failure("journal_corrupt");
      return key;
    } catch (Failure failure) {
      throw failure;
    } catch (Exception error) {
      throw new Failure("journal_key_unavailable");
    }
  }
  void bootstrap() throws Exception {
    if (db != null)
      return;
    File directory = file.getParentFile();
    if (!directory.isDirectory() && !directory.mkdirs())
      throw new Failure("journal_storage_failure");
    JSONObject registry = readRegistry();
    boolean dbExists = file.exists();
    if (registry == null) {
      if (dbExists)
        throw new Failure("legacy_format");
      if (keyFile.exists() || aliasExists()) throw new Failure("journal_state_loss");
      byte[] random = new byte[16];
      new SecureRandom().nextBytes(random);
      registry = new JSONObject().put("schema", 2).put("stage", "pending").put("incarnation", hex(random));
      writeDurable(registryFile, registry.toString().getBytes(StandardCharsets.UTF_8));
      record("provision", new JSONObject().put("stage", "pending"), registry.getString("incarnation"));
      writeDurable(keyFile, generateWrappedKey());
      record("provision", new JSONObject().put("stage", "key"), registry.getString("incarnation"));
    } else if (registry.getString("stage").equals("ready")) {
      if (!dbExists)
        throw new Failure("journal_state_loss");
      if (!keyFile.exists() || !aliasExists())
        throw new Failure("journal_key_missing");
    } else {
      if (!keyFile.exists() || (!aliasExists() && !dbExists)) {
        if (dbExists && !keyFile.exists())
          throw new Failure("journal_key_missing");
        writeDurable(keyFile, generateWrappedKey());
        record("provision", new JSONObject().put("stage", "key-resumed"), registry.getString("incarnation"));
      } else if (!aliasExists())
        throw new Failure("journal_key_missing");
    }
    pause("bootstrap");
    byte[] key = unwrapKey(readAll(keyFile));
    String expected = registry.getString("incarnation");
    try {
      openDatabase(hex(key), expected);
    } finally {
      Arrays.fill(key, (byte) 0);
    }
    if (!registry.getString("stage").equals("ready")) {
      registry.put("stage", "ready");
      writeDurable(registryFile, registry.toString().getBytes(StandardCharsets.UTF_8));
      record("provision", new JSONObject().put("stage", "ready"), expected);
    }
    incarnation = expected;
    JSONObject row = controlRow();
    cancelOtherUsers(row == null || row.getJSONObject("state").getJSONObject("session").isNull("userId") ? null : row.getJSONObject("state").getJSONObject("session").getString("userId"));
    synchronized (this) {
      if (restrictions == 0)
        displayOpen = row != null && !row.isNull("publication");
      record("bootstrap", new JSONObject().put("memoryDisplayOpen", displayOpen).put("restrictions", restrictions), expected);
    }
  }
  private void openDatabase(String key, String expectedIncarnation) throws Exception {
    System.loadLibrary("sqlcipher");
    try {
      db = SQLiteDatabase.openOrCreateDatabase(
          file, key, null, (database, error) -> { throw new Failure("journal_corrupt"); }, null);
      db.enableWriteAheadLogging();
      db.execSQL("PRAGMA synchronous=FULL");
      db.execSQL(
          "CREATE TABLE IF NOT EXISTS metadata(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,installation TEXT,incarnation TEXT NOT NULL)");
      db.execSQL("INSERT OR IGNORE INTO metadata(id,version,installation,incarnation) VALUES(1,2,NULL,?)", new Object[] {expectedIncarnation});
      if (number("SELECT version FROM metadata WHERE id=1") != 2)
        throw new Failure("journal_version");
      try (Cursor row = db.rawQuery("SELECT incarnation FROM metadata WHERE id=1", null)) {
        row.moveToFirst();
        if (!row.getString(0).equals(expectedIncarnation))
          throw new Failure("journal_incarnation_mismatch");
      }
      db.execSQL(
          "CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,foundation_scope TEXT NOT NULL,installation_id TEXT NOT NULL,user_id TEXT,consent INTEGER NOT NULL,binding_revision INTEGER NOT NULL,acknowledged_binding_revision INTEGER,pending TEXT,token_hash TEXT,token_revision INTEGER,display TEXT NOT NULL)");
      db.execSQL(
          "CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,kind TEXT NOT NULL,disposition TEXT NOT NULL)");
      db.execSQL(
          "CREATE TABLE IF NOT EXISTS streams(generation INTEGER PRIMARY KEY,user_id TEXT,next_sequence INTEGER NOT NULL,acknowledged INTEGER NOT NULL)");
      db.execSQL(
          "CREATE TABLE IF NOT EXISTS commands(generation INTEGER NOT NULL,sequence INTEGER NOT NULL,id TEXT NOT NULL UNIQUE,body TEXT NOT NULL,PRIMARY KEY(generation,sequence)) WITHOUT ROWID");
      db.execSQL(
          "CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,event TEXT NOT NULL,props TEXT NOT NULL,generation INTEGER NOT NULL,sequence INTEGER NOT NULL)");
      db.execSQL(
          "CREATE TABLE IF NOT EXISTS batches(generation INTEGER PRIMARY KEY,through INTEGER NOT NULL,body TEXT NOT NULL)");
      db.execSQL(
          "CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),foreground TEXT NOT NULL,channels TEXT NOT NULL,actions TEXT NOT NULL)");
      db.execSQL("CREATE TABLE IF NOT EXISTS notification_options(id INTEGER PRIMARY KEY CHECK(id=1),small_icon TEXT NOT NULL)");
      db.execSQL(
          "CREATE TABLE IF NOT EXISTS observations(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,process TEXT NOT NULL,ticket TEXT,kind TEXT NOT NULL,target_id TEXT NOT NULL,attempt_id TEXT NOT NULL,action_id TEXT,installation_id TEXT NOT NULL,binding_generation INTEGER NOT NULL,user_id TEXT,control_revision INTEGER,status TEXT NOT NULL,created_at INTEGER NOT NULL)");
      db.execSQL(
          "CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL,kind TEXT NOT NULL,action_id TEXT,target_id TEXT NOT NULL,attempt_id TEXT NOT NULL,user_id TEXT NOT NULL,binding_generation INTEGER NOT NULL,envelope TEXT NOT NULL,received_at INTEGER NOT NULL,interacted_at INTEGER NOT NULL,status TEXT NOT NULL)");
      db.execSQL(
          "CREATE TABLE IF NOT EXISTS notifications(target_id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,handle TEXT NOT NULL UNIQUE,notification_id INTEGER NOT NULL,user_id TEXT NOT NULL,binding_generation INTEGER NOT NULL,envelope TEXT NOT NULL,received_at INTEGER NOT NULL,posted_at INTEGER NOT NULL)");
      db.execSQL(
          "CREATE TABLE IF NOT EXISTS feedback(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,feedback_id TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL,delivery_id TEXT NOT NULL,type TEXT NOT NULL,shown_feedback_id TEXT,status TEXT NOT NULL,receipt TEXT,created_at INTEGER NOT NULL)");
      db.execSQL(
          "CREATE TABLE IF NOT EXISTS completions(user_id TEXT NOT NULL,delivery_id TEXT NOT NULL,feedback_id TEXT NOT NULL,completed_at INTEGER NOT NULL,PRIMARY KEY(user_id,delivery_id))");
      boolean hasBinding = false;
      try (Cursor columns = db.rawQuery("PRAGMA table_info(metadata)", null)) {
        while (columns.moveToNext())
          if (columns.getString(1).equals("binding"))
            hasBinding = true;
      }
      if (!hasBinding)
        db.execSQL("ALTER TABLE metadata ADD COLUMN binding TEXT");
    } catch (Throwable primary) {
      if (db != null) {
        try {
          db.close();
        } catch (Throwable cleanup) {
          primary.addSuppressed(cleanup);
        }
        db = null;
      }
      throw primary;
    }
  }
  void open(String lease, Promise promise) {
    work(promise, () -> {
      leaseCurrent(lease);
      bootstrap();
      finishNotificationCleanup();
      return null;
    });
  }
  JSONObject controlRow() throws Exception {
    try (Cursor row = db.rawQuery(
             "SELECT revision,foundation_scope,installation_id,user_id,consent,binding_revision,acknowledged_binding_revision,pending,token_hash,token_revision,display FROM control WHERE id=1",
             null)) {
      if (!row.moveToFirst())
        return null;
      JSONObject state = new JSONObject()
                             .put("version", 2)
                             .put("scope", row.getString(1))
                             .put("installationId", row.getString(2))
                             .put("session", new JSONObject().put("userId", row.isNull(3) ? JSONObject.NULL : row.getString(3)).put("consent", row.getLong(4) == 1))
                             .put("bindingRevision", row.getLong(5))
                             .put("acknowledgedBindingRevision", row.isNull(6) ? JSONObject.NULL : row.getLong(6))
                             .put("pending", row.isNull(7) ? JSONObject.NULL : new JSONObject(row.getString(7)))
                             .put("token", row.isNull(8) ? JSONObject.NULL : new JSONObject().put("hash", row.getString(8)).put("revision", row.getLong(9)));
      String display = row.getString(10);
      return new JSONObject()
          .put("revision", row.getLong(0))
          .put("state", state)
          .put("display", display.equals("closed") ? "closed" : "open")
          .put("publication", display.equals("closed") ? JSONObject.NULL : new JSONObject(display));
    }
  }
  void readControl(String lease, Promise promise) {
    work(promise, () -> {
      opened();
      leaseCurrent(lease);
      JSONObject row = controlRow();
      if (row == null)
        return "null";
      cancelOtherUsers(row.getJSONObject("state").getJSONObject("session").isNull("userId") ? null : row.getJSONObject("state").getJSONObject("session").getString("userId"));
      row.remove("publication");
      return row.toString();
    });
  }
  void commitControl(String lease, String operationId, long expectedRevision, String encoded, boolean restrict, Promise promise) {
    work(promise, () -> {
      opened();
      leaseCurrent(lease);
      JSONObject state = new JSONObject(encoded);
      JSONObject session = state.getJSONObject("session");
      String foundationScope = state.getString("scope"), installation = state.getString("installationId");
      String user = session.isNull("userId") ? null : session.getString("userId");
      boolean consent = session.getBoolean("consent");
      long bindingRevision = state.getLong("bindingRevision");
      Long acknowledged = state.isNull("acknowledgedBindingRevision") ? null : state.getLong("acknowledgedBindingRevision");
      String pending = state.isNull("pending") ? null : state.getJSONObject("pending").toString();
      JSONObject token = state.isNull("token") ? null : state.getJSONObject("token");
      if (!foundationScope.matches("[a-f0-9]{64}") || !installation.matches("[a-f0-9]{32}") || bindingRevision < 0 || user != null && user.isEmpty() || acknowledged != null && (acknowledged < 0 || acknowledged > bindingRevision) || token != null && !token.getString("hash").matches("[a-f0-9]{64}"))
        throw new Failure("invalid_control");
      if (!operationId.startsWith(lease + ":")) throw new Failure("operation_retired");
      long operationSequence = Long.parseLong(operationId.substring(lease.length() + 1));
      if (operationSequence <= lastOperation) throw new Failure("operation_retired");
      lastOperation = operationSequence;
      final boolean[] restrictive = {restrict};
      JSONObject receipt = transaction(() -> {
        long currentRevision = -1;
        String display = "closed";
        try (Cursor row = db.rawQuery("SELECT revision,user_id,consent,binding_revision,display FROM control WHERE id=1", null)) {
          if (row.moveToFirst()) {
            currentRevision = row.getLong(0);
            String priorUser = row.isNull(1) ? null : row.getString(1);
            if (!Objects.equals(priorUser, user) || (row.getLong(2) == 1) != consent || row.getLong(3) != bindingRevision)
              restrictive[0] = true;
            display = row.getString(4);
          }
        }
        if (currentRevision != expectedRevision)
          throw new Failure("control_stale");
        if (restrictive[0])
          display = "closed";
        long next = currentRevision < 0 ? 1 : currentRevision + 1;
        db.execSQL("INSERT OR REPLACE INTO control VALUES(1,?,?,?,?,?,?,?,?,?,?,?)",
            new Object[] {next, foundationScope, installation, user, consent ? 1 : 0, bindingRevision, acknowledged, pending, token == null ? null : token.getString("hash"), token == null ? null : token.getLong("revision"), display});
        db.execSQL("DELETE FROM operations WHERE kind<>'notification-cleanup'");
        db.execSQL("INSERT INTO operations VALUES(?,?,?,?)", new Object[] {operationId, next, "control", restrictive[0] ? "closed" : "kept"});
        db.execSQL("INSERT OR IGNORE INTO operations SELECT handle,?,'notification-cleanup','pending' FROM notifications WHERE ?=1 OR ? IS NULL OR user_id<>? OR EXISTS (SELECT 1 FROM interactions WHERE id=notifications.handle)", new Object[] {next, restrict ? 1 : 0, user, user});
        pause("control-commit-before");
        if (restrictive[0])
          pause("close-commit-before");
        return new JSONObject().put("operationId", operationId).put("revision", next).put("display", display.equals("closed") ? "closed" : "open").put("restrictive", restrictive[0]);
      });
      pause("control-commit-after");
      if (restrictive[0])
        pause("close-commit-after");
      synchronized (this) {
        if (restrictive[0])
          displayOpen = false;
        receipt.put("submissionsBeforeClose", submittedCount);
      }
      cancelOtherUsers(user);
      record("control-commit", receipt, operationId);
      return receipt.toString();
    });
  }
  void operation(String lease, String operationId, Promise promise) {
    work(promise, () -> {
      opened();
      leaseCurrent(lease);
      try (Cursor row = db.rawQuery("SELECT revision,kind,disposition FROM operations WHERE id=?", new String[] {operationId})) {
        if (!row.moveToFirst())
          return new JSONObject().put("state", "unknown").toString();
        return new JSONObject().put("state", "committed").put("revision", row.getLong(0)).put("kind", row.getString(1)).put("disposition", row.getString(2)).toString();
      }
    });
  }
  void publishDisplay(String lease, String proposalId, Promise promise) {
    work(promise, () -> {
      Proposal proposal;
      synchronized (this) {
        proposal = proposals.remove(proposalId);
        if (proposal == null)
          throw new Failure("invalid_proposal");
        leaseCurrent(lease);
        if (proposal.fence != displayFence)
          throw new Failure("publication_stale");
        if (SystemClock.elapsedRealtimeNanos() > proposal.deadline)
          throw new Failure("publication_expired");
      }
      opened();
      finishNotificationCleanup();
      JSONObject receipt = transaction(() -> {
        long revision;
        try (Cursor row = db.rawQuery("SELECT revision,user_id,consent,binding_revision,acknowledged_binding_revision FROM control WHERE id=1", null)) {
          if (!row.moveToFirst())
            throw new Failure("display_ineligible");
          revision = row.getLong(0);
          String user = row.isNull(1) ? null : row.getString(1);
          if (revision != proposal.controlRevision || !proposal.userId.equals(user) || row.getLong(2) != 1 || row.isNull(4) || row.getLong(3) != row.getLong(4))
            throw new Failure("display_ineligible");
        }
        try (Cursor row = db.rawQuery("SELECT revision FROM operations WHERE id=?", new String[] {proposal.operationId})) {
          if (!row.moveToFirst() || row.getLong(0) != proposal.controlRevision)
            throw new Failure("publication_stale");
        }
        JSONObject publication = new JSONObject().put("publicationId", proposal.id).put("controlRevision", revision);
        db.execSQL("UPDATE control SET display=? WHERE id=1", new Object[] {publication.toString()});
        db.execSQL("DELETE FROM operations WHERE kind='open'");
        db.execSQL("INSERT INTO operations VALUES(?,?,?,?)", new Object[] {proposal.id, revision, "open", "open"});
        pause("open-commit-before");
        return publication;
      });
      pause("open-commit-after");
      synchronized (this) {
        boolean current = proposal.fence == displayFence && !released;
        if (current)
          displayOpen = true;
        receipt.put("state", current ? "open" : "open-then-restricted");
      }
      record("open-commit", receipt, proposal.id);
      return receipt.toString();
    });
  }
  void submitIfCurrent(Submission submission, Promise promise) {
    work(promise, () -> {
      opened();
      JSONObject row = controlRow();
      JSONObject result = new JSONObject();
      if (row == null || row.isNull("publication"))
        return result.put("state", "suppressed").put("reason", "closed-on-disk").toString();
      long fence;
      synchronized (this) {
        if (!displayOpen)
          return result.put("state", "suppressed").put("reason", "memory-closed").toString();
        fence = displayFence;
      }
      record("submission-evaluated", row.getJSONObject("publication"), "" + fence);
      pause("submission-gap");
      JSONObject recordEntry;
      synchronized (this) {
        if (fence != displayFence || !displayOpen)
          return result.put("state", "suppressed").put("reason", "restricted-after-evaluation").put("fence", fence).put("currentFence", displayFence).toString();
        recordEntry = new JSONObject(row.getJSONObject("publication").toString()).put("ordinal", submittedCount + 1).put("nanos", SystemClock.elapsedRealtimeNanos());
        submittedCount++;
      }
      record("submission-initiated", recordEntry, "" + fence);
      submission.submit(recordEntry);
      record("submission-settled", recordEntry, "" + fence);
      return result.put("state", "submitted").put("submission", recordEntry).toString();
    });
  }

  void closeGate(long requested, Promise promise) {
    work(promise, () -> {
      opened();
      synchronized (this) {
        if (requested > intent)
          throw new Failure("superseded");
        ready = false;
      }
      transaction(() -> {

        return null;
      });
      return null;
    });
  }
  void publish(long capture, String encoded, Promise promise) {
    work(promise, () -> {
      opened();
      current(capture);
      JSONObject proof = new JSONObject(encoded);
      if (proof.getLong("bindingRevision") != proof.getLong("acknowledgedBindingRevision"))
        throw new Failure("binding_unacknowledged");
      String installation = proof.getString("installationId");
      installationKey = installation;
      long generation = proof.getLong("generation");
      if (generation < 0 || generation > 9007199254740991L)
        throw new Failure("invalid_binding");
      String user = proof.isNull("userId") ? null : proof.getString("userId");
      transaction(() -> {
        try (Cursor row = db.rawQuery("SELECT installation FROM metadata WHERE id=1", null)) {
          row.moveToFirst();
          if (!row.isNull(0) && !row.getString(0).equals(installation))
            throw new Failure("journal_installation_mismatch");
        }
        try (Cursor row = db.rawQuery("SELECT installation_id,user_id,binding_revision,acknowledged_binding_revision FROM control WHERE id=1", null)) {
          if (!row.moveToFirst() || !row.getString(0).equals(installation) || !Objects.equals(row.isNull(1) ? null : row.getString(1), user) || row.isNull(3) || row.getLong(2) != proof.getLong("bindingRevision") || row.getLong(3) != proof.getLong("acknowledgedBindingRevision"))
            throw new Failure("binding_unacknowledged");
        }
        db.execSQL(
            "INSERT OR IGNORE INTO streams VALUES(?,?,1,0)", new Object[] {generation, user});
        try (Cursor row = db.rawQuery("SELECT user_id FROM streams WHERE generation=?",
                 new String[] {"" + generation})) {
          row.moveToFirst();
          String prior = row.isNull(0) ? null : row.getString(0);
          if (!Objects.equals(prior, user))
            throw new Failure("binding_generation_conflict");
        }
        db.execSQL("UPDATE metadata SET installation=?,binding=? WHERE id=1", new Object[] {installation, proof.toString()});
        return null;
      });
      synchronized (this) {
        current(capture);
        binding = proof;
        ready = true;
      }
      drain();
      return null;
    });
  }
  void admit(String id, String encoded, Promise promise) {
    synchronized (this) {
      Ticket ticket = tickets.get(id);
      if (ticket == null) {
        fail(promise, new Failure("ticket_missing"));
        return;
      }
      try {
        JSONObject event = new JSONObject(encoded);
        if (ticket.event != null && !ticket.event.toString().equals(event.toString()))
          throw new Failure("event_conflict");
        ticket.event = event;
        ticket.promises.add(promise);
      } catch (Exception error) {
        if (ticket.event == null) ticket.rejected = true;
        fail(promise, error);
      }
    }
    executor.execute(this::drain);
  }
  synchronized String reserveNative(JSONObject observation) {
    JSONObject immutable;
    try {
      immutable = new JSONObject(observation.toString());
      immutable.getString("targetId");
      immutable.getString("attemptId");
      immutable.getString("installationId");
      immutable.getLong("bindingGeneration");
    } catch (Exception error) {
      throw new Failure("invalid_observation");
    }
    if (released)
      throw new Failure("journal_owner_stale");
    Ticket ticket = new Ticket(owner, ++nextTicket, intent, "");
    ticket.observation = immutable;
    tickets.put(ticket.id, ticket);
    try {
      record("reserve-native", new JSONObject().put("ordinal", ticket.ordinal), ticket.id);
    } catch (Exception ignored) {
    }
    executor.execute(this::drain);
    return ticket.id;
  }
  private void drain() {
    while (true) {
      Ticket ticket;
      JSONObject proof;
      synchronized (this) {
        proof = ready && db != null ? binding : null;
      }
      if (proof != null) {
        try {
          admitOrphans(proof);
        } catch (Throwable error) {
          if (!(error instanceof Failure))
            return;
        }
      }
      synchronized (this) {
        if (tickets.isEmpty())
          return;
        ticket = tickets.values().iterator().next();
        if (!released && !ticket.rejected && ticket.intent == 0 && !initialResolved)
          return;
        if (ticket.rejected || ticket.intent != intent || released) {
          tickets.remove(ticket.id);
          for (Promise waiter : ticket.promises) fail(waiter, new Failure("superseded"));
          if (ticket.observationOrdinal > 0 && db != null)
            db.execSQL("UPDATE observations SET ticket=NULL WHERE ordinal=? AND ticket=?", new Object[] {ticket.observationOrdinal, ticket.id});
          continue;
        }
        if (db == null || !ready || ticket.event == null && ticket.observation == null || ticket.observationOrdinal < 0)
          return;
        proof = binding;
      }
      try {
        final JSONObject captured = proof;
        String receipt = transaction(() -> persist(ticket, captured));
        synchronized (this) {
          tickets.remove(ticket.id);
          current(ticket.intent);
        }
        record("admitted", new JSONObject(receipt), ticket.id);
        for (Promise waiter : ticket.promises) waiter.resolve(receipt);
      } catch (Throwable error) {
        synchronized (this) {
          for (Promise waiter : ticket.promises) fail(waiter, error);
          ticket.promises.clear();
          if (error instanceof Failure)
            tickets.remove(ticket.id);
          else
            return;
        }
      }
    }
  }
  private void admitOrphans(JSONObject proof) throws Exception {
    while (true) {
      JSONObject row = null;
      try (Cursor cursor = db.rawQuery(
               "SELECT ordinal,kind,target_id,attempt_id,action_id,installation_id,binding_generation,user_id,ticket,process FROM observations WHERE status='pending' ORDER BY ordinal",
               null)) {
        while (cursor.moveToNext()) {
          String ticketId = cursor.isNull(8) ? null : cursor.getString(8);
          boolean live;
          synchronized (this) {
            live = ticketId != null && cursor.getString(9).equals(processIncarnation) && tickets.containsKey(ticketId);
          }
          if (live)
            return;
          row = new JSONObject()
                    .put("ordinal", cursor.getLong(0))
                    .put("kind", cursor.getString(1))
                    .put("targetId", cursor.getString(2))
                    .put("attemptId", cursor.getString(3))
                    .put("actionId", cursor.isNull(4) ? JSONObject.NULL : cursor.getString(4))
                    .put("installationId", cursor.getString(5))
                    .put("bindingGeneration", cursor.getLong(6))
                    .put("userId", cursor.isNull(7) ? JSONObject.NULL : cursor.getString(7));
          break;
        }
      }
      if (row == null)
        return;
      final JSONObject captured = row;
      String receipt = transaction(() -> persistObservation("o" + captured.getLong("ordinal"), captured, proof));
      record("admitted", new JSONObject(receipt), "o" + captured.getLong("ordinal"));
    }
  }
  private String persistObservation(String commandId, JSONObject observation, JSONObject proof) throws Exception {
    long ordinal = observation.getLong("ordinal");
    boolean match = !proof.isNull("userId") && observation.getString("installationId").equals(proof.getString("installationId"))
        && observation.getLong("bindingGeneration") == proof.getLong("generation")
        && !observation.isNull("userId") && observation.getString("userId").equals(proof.getString("userId"));
    if (!match) {
      db.execSQL("UPDATE observations SET status='retired' WHERE ordinal=?", new Object[] {ordinal});
      db.execSQL("UPDATE interactions SET status='retired' WHERE ordinal=? AND status='pending'", new Object[] {ordinal});
      return new JSONObject().put("ordinal", ordinal).put("state", "retired").toString();
    }
    long generation = proof.getLong("generation");
    long sequence = number("SELECT next_sequence FROM streams WHERE generation=?", "" + generation);
    if (sequence >= 9007199254740991L)
      throw new Failure("sequence_exhausted");
    JSONObject body = new JSONObject().put("kind", observation.getString("kind")).put("targetId", observation.getString("targetId")).put("attemptId", observation.getString("attemptId"));
    if (!observation.isNull("actionId"))
      body.put("actionId", observation.getString("actionId"));
    body.put("id", commandId).put("sequence", sequence);
    db.execSQL("INSERT INTO commands VALUES(?,?,?,?)", new Object[] {generation, sequence, commandId, body.toString()});
    db.execSQL("UPDATE streams SET next_sequence=next_sequence+1 WHERE generation=?", new Object[] {generation});
    db.execSQL("UPDATE observations SET status='admitted' WHERE ordinal=?", new Object[] {ordinal});
    return new JSONObject().put("ordinal", ordinal).put("state", "queued").put("sequence", sequence).toString();
  }
  private String persist(Ticket ticket, JSONObject proof) throws Exception {
    current(ticket.intent);
    if (ticket.observationOrdinal != 0)
      return persistObservation(ticket.id, ticket.observation, proof);
    if (proof.isNull("userId"))
      throw new Failure("identify_required");
    long generation = proof.getLong("generation");
    String user = proof.getString("userId");
    JSONObject body;
    String props = null, eventName = null;
    if (ticket.event != null) {
      JSONObject event = ticket.event;
      if (!event.getString("eventId").equals(ticket.eventId))
        throw new Failure("superseded");
      eventName = event.getString("event");
      props = event.getString("propsJson");
      if (eventName.codePointCount(0, eventName.length()) < 1
          || eventName.codePointCount(0, eventName.length()) > 80 || ticket.eventId.length() < 1
          || ticket.eventId.codePointCount(0, ticket.eventId.length()) > 128
          || props.getBytes(StandardCharsets.UTF_8).length > 4096)
        throw new Failure("invalid_event");
      JSONObject properties = new JSONObject(props);
      try (Cursor row = db.rawQuery(
               "SELECT user_id,event,props,generation,sequence FROM events WHERE event_id=?",
               new String[] {ticket.eventId})) {
        if (row.moveToFirst()) {
          if (!row.getString(0).equals(user) || !row.getString(1).equals(eventName)
              || !row.getString(2).equals(props))
            throw new Failure("event_conflict");
          long originalGeneration = row.getLong(3), sequence = row.getLong(4),
               ack = number(
                   "SELECT acknowledged FROM streams WHERE generation=?", "" + originalGeneration);
          if (originalGeneration != generation && sequence > ack)
            throw new Failure("event_pending_old_binding");
          return new JSONObject()
              .put("eventId", ticket.eventId)
              .put("state", sequence <= ack ? "acknowledged" : "queued")
              .toString();
        }
      }
      body = new JSONObject()
                 .put("kind", "event")
                 .put("event", eventName)
                 .put("eventId", ticket.eventId)
                 .put("props", properties);
    } else {
      body = new JSONObject(ticket.observation.toString());
      if (body.getLong("bindingGeneration") != generation
          || !body.getString("installationId").equals(proof.getString("installationId")))
        throw new Failure("superseded");
      body.remove("bindingGeneration");
      body.remove("installationId");
      String kind = body.getString("kind");
      if (!kind.equals("receipt") && !kind.equals("tap") && !kind.equals("action"))
        throw new Failure("invalid_observation");
      if (body.getString("targetId").isEmpty() || body.getString("attemptId").isEmpty())
        throw new Failure("invalid_observation");
    }
    long sequence = number("SELECT next_sequence FROM streams WHERE generation=?", "" + generation);
    if (sequence >= 9007199254740991L)
      throw new Failure("sequence_exhausted");
    body.put("id", ticket.id).put("sequence", sequence);
    db.execSQL("INSERT INTO commands VALUES(?,?,?,?)",
        new Object[] {generation, sequence, ticket.id, body.toString()});
    if (ticket.event != null)
      db.execSQL("INSERT INTO events VALUES(?,?,?,?,?,?)",
          new Object[] {ticket.eventId, user, eventName, props, generation, sequence});
    db.execSQL("UPDATE streams SET next_sequence=next_sequence+1 WHERE generation=?",
        new Object[] {generation});
    return new JSONObject().put("eventId", ticket.eventId).put("state", "queued").toString();
  }
  void peek(long capture, Promise promise) {
    work(promise, () -> {
      opened();
      current(capture);
      JSONObject proof;
      synchronized (this) {
        if (!ready)
          throw new Failure("binding_unacknowledged");
        proof = binding;
      }
      long generation = proof.getLong("generation");
      long ack = number("SELECT acknowledged FROM streams WHERE generation=?", "" + generation);
      JSONArray commands = transaction(() -> {
        try (Cursor saved = db.rawQuery(
                 "SELECT body FROM batches WHERE generation=?", new String[] {"" + generation})) {
          if (saved.moveToFirst())
            return new JSONArray(saved.getString(0));
        }
        JSONArray batch = new JSONArray();
        long through = ack;
        try (
            Cursor row = db.rawQuery(
                "SELECT body FROM commands WHERE generation=? AND sequence>? ORDER BY sequence LIMIT 32",
                new String[] {"" + generation, "" + ack})) {
          while (row.moveToNext()) {
            JSONObject command = new JSONObject(row.getString(0));
            batch.put(command);
            if (new JSONObject()
                    .put("bindingGeneration", generation)
                    .put("commands", batch)
                    .toString()
                    .getBytes(StandardCharsets.UTF_8)
                    .length
                > 65536) {
              batch.remove(batch.length() - 1);
              break;
            }
            through = command.getLong("sequence");
          }
        }
        if (batch.length() > 0)
          db.execSQL("INSERT INTO batches VALUES(?,?,?)",
              new Object[] {generation, through, batch.toString()});
        return batch;
      });
      return new JSONObject()
          .put("generation", generation)
          .put("acknowledgedThrough", ack)
          .put("lastSequence",
              number("SELECT next_sequence-1 FROM streams WHERE generation=?", "" + generation))
          .put("commands", commands)
          .put("pendingAdmissions", pendingCount(capture))
          .put("appConfirmed", proof.getBoolean("appConfirmed") && !proof.isNull("userId"))
          .toString();
    });
  }
  private synchronized int pendingCount(long capture) {
    int count = 0;
    for (Ticket ticket : tickets.values())
      if (!ticket.rejected && ticket.intent == capture)
        count++;
    return count;
  }
  void acknowledge(long capture, long generation, long through, Promise promise) {
    work(promise, () -> {
      opened();
      current(capture);
      transaction(() -> {
        if (!ready || binding.getLong("generation") != generation)
          throw new Failure("superseded");
        long next = number("SELECT next_sequence FROM streams WHERE generation=?", "" + generation);
        if (through < 0 || through >= next)
          throw new Failure("invalid_acknowledgement");
        if (number("SELECT through FROM batches WHERE generation=?", "" + generation) != through)
          throw new Failure("invalid_acknowledgement");
        db.execSQL("UPDATE streams SET acknowledged=MAX(acknowledged,?) WHERE generation=?",
            new Object[] {through, generation});
        db.execSQL("DELETE FROM batches WHERE generation=?", new Object[] {generation});
        return null;
      });
      return null;
    });
  }
  static final class Locator {
    static JournalActor locate(Context context, String installationId, boolean bounded) throws Exception {
      synchronized (JournalActor.class) {
        for (JournalActor actor : actors.values())
          if (installationId.equals(actor.installationKey)) return actor;
      }
      File directory = new File(context.getApplicationInfo().dataDir, "no_backup");
      String[] names = directory.list();
      if (names == null)
        return null;
      Arrays.sort(names);
      for (String name : names) {
        if (!name.startsWith("galinum-control-") || !name.endsWith(".json"))
          continue;
        String scope = name.substring("galinum-control-".length(), name.length() - ".json".length());
        if (!scope.matches("[a-f0-9]{64}"))
          continue;
        JournalActor actor = getOrCreate(context, scope);
        String installation;
        try {
          java.util.concurrent.Future<String> lookup = actor.executor.submit(() -> {
            actor.bootstrap();
            try (Cursor row = actor.db.rawQuery("SELECT installation FROM metadata WHERE id=1", null)) {
              return row.moveToFirst() && !row.isNull(0) ? row.getString(0) : "";
            }
          });
          installation = bounded ? lookup.get(10, java.util.concurrent.TimeUnit.SECONDS) : lookup.get();
        } catch (java.util.concurrent.ExecutionException | java.util.concurrent.TimeoutException failure) {
          record("locate-skipped", new JSONObject(), scope);
          continue;
        }
        actor.installationKey = installation;
        if (installation.equals(installationId))
          return actor;
      }
      return null;
    }
  }
  static String ingress(Context context, String encoded, boolean foreground) throws Exception {
    return ingress(context, encoded, foreground, () -> {}, true);
  }
  static String ingress(Context context, String encoded, boolean foreground, Runnable receiptDurable, boolean bounded) throws Exception {
    JSONObject envelope = GalinumNotifications.parseEnvelope(encoded);
    JournalActor actor = Locator.locate(context, envelope.getString("installationId"), bounded);
    if (actor == null) {
      record("ingress-ignored", new JSONObject().put("reason", "unknown_installation"), envelope.getString("targetId"));
      return new JSONObject().put("state", "ignored").put("reason", "unknown_installation").toString();
    }
    Ticket ticket = actor.reserveIngress(envelope, "receipt", null);
    synchronized (actor) {
      actor.nativeJobs++;
    }
    java.util.concurrent.Future<String> received = actor.executor.submit(() -> {
      try {
        pause("ingress-before-receive");
        return actor.receive(envelope, ticket, foreground, receiptDurable);
      }
      finally { synchronized (actor) { actor.nativeJobs--; } }
    });
    return bounded ? received.get(15, java.util.concurrent.TimeUnit.SECONDS) : received.get();
  }
  private synchronized Ticket reserveIngress(JSONObject envelope, String kind, String actionId) throws Exception {
    JSONObject observation = new JSONObject()
                                 .put("kind", kind)
                                 .put("targetId", envelope.getString("targetId"))
                                 .put("attemptId", envelope.getString("attemptId"))
                                 .put("installationId", envelope.getString("installationId"))
                                 .put("bindingGeneration", envelope.getLong("bindingGeneration"))
                                 .put("actionId", actionId == null ? JSONObject.NULL : actionId);
    if (released) {
      record("reserve-ingress", new JSONObject().put("kind", kind).put("memory", false), envelope.getString("targetId"));
      return null;
    }
    Ticket ticket = new Ticket(owner, ++nextTicket, intent, "");
    ticket.observation = observation;
    ticket.observationOrdinal = -1;
    tickets.put(ticket.id, ticket);
    record("reserve-ingress", new JSONObject().put("kind", kind).put("memory", true).put("ordinal", ticket.ordinal), ticket.id);
    return ticket;
  }
  private JSONObject bindingProof() throws Exception {
    try (Cursor row = db.rawQuery("SELECT binding FROM metadata WHERE id=1", null)) {
      return row.moveToFirst() && !row.isNull(0) ? new JSONObject(row.getString(0)) : null;
    }
  }
  private static boolean bindingCurrent(JSONObject proof, JSONObject control, String installationId, long generation, String user) throws Exception {
    if (proof == null || control == null || user == null)
      return false;
    JSONObject state = control.getJSONObject("state");
    JSONObject session = state.getJSONObject("session");
    return proof.getString("installationId").equals(installationId) && proof.getLong("generation") == generation
        && !proof.isNull("userId") && proof.getString("userId").equals(user)
        && !session.isNull("userId") && session.getString("userId").equals(user)
        && !state.isNull("acknowledgedBindingRevision") && state.getLong("acknowledgedBindingRevision") == state.getLong("bindingRevision");
  }
  private long insertObservation(String kind, Ticket ticket, JSONObject envelope, String actionId, String user, Long controlRevision, boolean current) throws Exception {
    db.execSQL("INSERT INTO observations(process,ticket,kind,target_id,attempt_id,action_id,installation_id,binding_generation,user_id,control_revision,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        new Object[] {processIncarnation, ticket == null ? null : ticket.id, kind, envelope.getString("targetId"), envelope.getString("attemptId"), actionId, envelope.getString("installationId"), envelope.getLong("bindingGeneration"), user, controlRevision, current ? "pending" : "retired", System.currentTimeMillis()});
    return number("SELECT last_insert_rowid()");
  }
  private void bindTicket(Ticket ticket, long ordinal, String user, boolean current) throws Exception {
    if (ticket == null)
      return;
    synchronized (this) {
      if (!current) {
        ticket.rejected = true;
        return;
      }
      ticket.observation.put("ordinal", ordinal).put("userId", user);
      ticket.observationOrdinal = ordinal;
    }
  }
  private String receive(JSONObject envelope, Ticket ticket, boolean foreground, Runnable receiptDurable) throws Exception {
    JSONObject result = new JSONObject().put("targetId", envelope.getString("targetId")).put("pid", android.os.Process.myPid());
    try {
      bootstrap();
      JSONObject control = controlRow();
      JSONObject proof = bindingProof();
      String user = control == null || control.getJSONObject("state").getJSONObject("session").isNull("userId") ? null : control.getJSONObject("state").getJSONObject("session").getString("userId");
      boolean current = bindingCurrent(proof, control, envelope.getString("installationId"), envelope.getLong("bindingGeneration"), user);
      long ordinal = transaction(() -> insertObservation("receipt", ticket, envelope, null, user, control == null ? null : control.getLong("revision"), current));
      bindTicket(ticket, ordinal, user, current);
      result.put("ordinal", ordinal).put("receipt", current ? "pending" : "retired");
      record("ingress-receipt", new JSONObject(result.toString()), envelope.getString("targetId"));
      receiptDurable.run();
      if (!current) {
        drain();
        return result.put("state", "suppressed").put("reason", "binding_mismatch").toString();
      }
      String reason = displayReason(control, envelope, foreground);
      if (reason != null) {
        record("display-suppressed", new JSONObject().put("reason", reason), envelope.getString("targetId"));
        drain();
        return result.put("state", "suppressed").put("reason", reason).toString();
      }
      long fence;
      synchronized (this) {
        fence = displayFence;
      }
      record("submission-evaluated", control.getJSONObject("publication"), "" + fence);
      pause("submission-gap");
      android.graphics.Bitmap image;
      try { image = GalinumNotifications.image(context, envelope); }
      catch (Exception error) {
        record("display-suppressed", new JSONObject().put("reason", "image-unavailable"), envelope.getString("targetId"));
        drain();
        return result.put("state", "suppressed").put("reason", "image-unavailable").toString();
      }
      byte[] random = new byte[16];
      new SecureRandom().nextBytes(random);
      String handle = hex(random);
      int notificationId = envelope.getString("targetId").hashCode();
      long now = System.currentTimeMillis();
      transaction(() -> {
        db.execSQL("INSERT OR REPLACE INTO notifications VALUES(?,?,?,?,?,?,?,?,?)",
            new Object[] {envelope.getString("targetId"), envelope.getString("attemptId"), handle, notificationId, user, envelope.getLong("bindingGeneration"), envelope.toString(), now, now});
        return null;
      });
      JSONObject submission = null;
      synchronized (this) {
        if (fence == displayFence && displayOpen) {
          submission = new JSONObject().put("ordinal", submittedCount + 1).put("nanos", SystemClock.elapsedRealtimeNanos()).put("notificationId", notificationId);
          submittedCount++;
        }
      }
      if (submission == null) {
        if (image != null) image.recycle();
        record("display-suppressed", new JSONObject().put("reason", "restricted-after-evaluation"), envelope.getString("targetId"));
        transaction(() -> {
          db.execSQL("DELETE FROM notifications WHERE handle=?", new Object[] {handle});
          return null;
        });
        drain();
        return result.put("state", "suppressed").put("reason", "restricted-after-evaluation").toString();
      }
      record("submission-initiated", submission, "" + fence);
      pause("submission-before-post");
      try { GalinumNotifications.post(context, scope, envelope, handle, notificationId, settings(), image); }
      finally { if (image != null) image.recycle(); }
      record("submission-settled", submission, "" + fence);
      drain();
      return result.put("state", "displayed").put("notificationId", notificationId).toString();
    } catch (Exception error) {
      if (ticket != null)
        synchronized (this) {
          ticket.rejected = true;
        }
      drain();
      Failure failure = error instanceof Failure ? (Failure) error : new Failure("journal_storage_failure");
      record("ingress-failed", new JSONObject().put("code", failure.code), envelope.getString("targetId"));
      throw failure;
    } finally {
      try { interactionSink.interaction(scope); } catch (Throwable ignored) {}
    }
  }
  private JSONObject settings() throws Exception {
    try (Cursor row = db.rawQuery("SELECT foreground,channels,actions FROM settings WHERE id=1", null)) {
      if (!row.moveToFirst())
        return new JSONObject().put("foreground", "display").put("channels", new JSONArray()).put("actions", new JSONArray());
      JSONObject settings = new JSONObject().put("foreground", row.getString(0)).put("channels", new JSONArray(row.getString(1))).put("actions", new JSONArray(row.getString(2)));
      try (Cursor icon = db.rawQuery("SELECT small_icon FROM notification_options WHERE id=1", null)) {
        if (icon.moveToFirst()) settings.put("smallIcon", icon.getString(0));
      }
      return settings;
    }
  }
  private String displayReason(JSONObject control, JSONObject envelope, boolean foreground) throws Exception {
    if (!control.getJSONObject("state").getJSONObject("session").getBoolean("consent"))
      return "no-consent";
    if (control.isNull("publication"))
      return "closed-on-disk";
    synchronized (this) {
      if (!displayOpen)
        return "memory-closed";
    }
    JSONObject settings = settings();
    if (foreground && settings.getString("foreground").equals("suppress"))
      return "foreground-suppressed";
    return GalinumNotifications.platformReason(context, envelope, settings);
  }
  private static synchronized void registerCaptureState(android.app.Activity activity) {
    if (captureCallbacksRegistered) return;
    activity.getApplication().registerActivityLifecycleCallbacks(new android.app.Application.ActivityLifecycleCallbacks() {
      public void onActivityCreated(android.app.Activity value, android.os.Bundle state) {}
      public void onActivityStarted(android.app.Activity value) {}
      public void onActivityResumed(android.app.Activity value) {}
      public void onActivityPaused(android.app.Activity value) {}
      public void onActivityStopped(android.app.Activity value) {}
      public void onActivityDestroyed(android.app.Activity value) {
        synchronized (JournalActor.class) { pendingCaptures.remove(value); }
      }
      public void onActivitySaveInstanceState(android.app.Activity value, android.os.Bundle state) {
        synchronized (JournalActor.class) {
          LinkedHashMap<String, PendingCapture> pending = pendingCaptures.get(value);
          if (pending == null || pending.isEmpty()) return;
          JSONArray saved = new JSONArray();
          try { for (PendingCapture capture : pending.values()) saved.put(capture.json()); }
          catch (Exception error) { throw new IllegalStateException(error); }
          state.putString(CAPTURES_STATE, saved.toString());
        }
      }
    });
    captureCallbacksRegistered = true;
  }
  private static void queueCapture(android.app.Activity activity, PendingCapture capture) {
    if (capture.scope == null || !capture.scope.matches("[a-f0-9]{64}") || capture.handle == null || !capture.handle.matches("[a-f0-9]{32}")) return;
    final PendingCapture attempt;
    synchronized (JournalActor.class) {
      LinkedHashMap<String, PendingCapture> pending = pendingCaptures.computeIfAbsent(activity, key -> new LinkedHashMap<>());
      attempt = pending.computeIfAbsent(capture.key(), key -> capture);
      if (attempt.active) return;
      attempt.active = true;
    }
    JournalActor actor = getOrCreate(activity, attempt.scope);
    actor.captureInteraction(attempt.handle, attempt.actionId, consumed -> {
      synchronized (JournalActor.class) {
        attempt.active = false;
        LinkedHashMap<String, PendingCapture> pending = pendingCaptures.get(activity);
        if (consumed && pending != null) pending.remove(attempt.key(), attempt);
      }
    });
  }
  static boolean capture(android.app.Activity activity, android.content.Intent intent, boolean fresh) {
    return capture(activity, intent, (android.os.Bundle) null);
  }
  static boolean capture(android.app.Activity activity, android.content.Intent intent, android.os.Bundle savedState) {
    registerCaptureState(activity);
    if (savedState != null && savedState.containsKey(CAPTURES_STATE)) {
      try {
        JSONArray saved = new JSONArray(savedState.getString(CAPTURES_STATE));
        for (int index = 0; index < saved.length(); index++) {
          JSONObject entry = saved.getJSONObject(index);
          queueCapture(activity, new PendingCapture(entry.getString("scope"), entry.getString("handle"), entry.isNull("actionId") ? null : entry.getString("actionId")));
        }
      } catch (Exception error) { record("capture-state-invalid", new JSONObject(), ""); }
    }
    String handle = intent == null ? null : intent.getStringExtra("galinum.handle");
    if (handle == null) return false;
    String scope = intent.getStringExtra("galinum.scope");
    String actionId = intent.getStringExtra("galinum.action");
    queueCapture(activity, new PendingCapture(scope, handle, actionId == null || actionId.isEmpty() ? null : actionId));
    intent.removeExtra("galinum.handle");
    intent.removeExtra("galinum.scope");
    intent.removeExtra("galinum.action");
    activity.setIntent(intent);
    return true;
  }
  private void captureInteraction(String handle, String actionId, CaptureCompletion completion) {
    Ticket placeholder;
    synchronized (this) {
      if (released)
        placeholder = null;
      else {
        placeholder = new Ticket(owner, ++nextTicket, intent, "");
        placeholder.observationOrdinal = -1;
        placeholder.observation = new JSONObject();
        tickets.put(placeholder.id, placeholder);
      }
      nativeJobs++;
      record("reserve-interaction", new JSONObject(java.util.Collections.singletonMap("memory", placeholder != null)), handle);
    }
    executor.execute(() -> {
      boolean consumed = false;
      try {
        pause("capture-before-bootstrap");
        bootstrap();
        JSONObject posted;
        try (Cursor row = db.rawQuery("SELECT target_id,attempt_id,notification_id,user_id,binding_generation,envelope,received_at FROM notifications WHERE handle=? AND NOT EXISTS (SELECT 1 FROM interactions WHERE id=notifications.handle)", new String[] {handle})) {
          posted = !row.moveToFirst() ? null
              : new JSONObject().put("targetId", row.getString(0)).put("attemptId", row.getString(1)).put("notificationId", row.getLong(2)).put("userId", row.getString(3)).put("bindingGeneration", row.getLong(4)).put("envelope", new JSONObject(row.getString(5))).put("receivedAt", row.getLong(6));
        }
        if (posted == null) {
          synchronized (this) {
            if (placeholder != null)
              placeholder.rejected = true;
          }
          consumed = true;
          record("interaction-invalid", new JSONObject(), handle);
          drain();
          cancelPosted("handle=?", new String[] {handle});
          return;
        }
        JSONObject envelope = posted.getJSONObject("envelope");
        String kind = actionId == null ? "tap" : "action";
        if (actionId != null) {
          boolean known = false;
          JSONArray actions = envelope.getJSONObject("content").optJSONArray("actions");
          for (int index = 0; actions != null && index < actions.length(); index++)
            if (actions.getJSONObject(index).getString("id").equals(actionId))
              known = true;
          if (!known) {
            synchronized (this) {
              if (placeholder != null)
                placeholder.rejected = true;
            }
            consumed = true;
            record("interaction-invalid", new JSONObject().put("action", actionId), handle);
            drain();
            return;
          }
        }
        JSONObject control = controlRow();
        JSONObject proof = bindingProof();
        String user = posted.getString("userId");
        boolean current = bindingCurrent(proof, control, envelope.getString("installationId"), posted.getLong("bindingGeneration"), user);
        if (placeholder != null)
          synchronized (this) {
            placeholder.observation = new JSONObject()
                                          .put("kind", kind)
                                          .put("targetId", envelope.getString("targetId"))
                                          .put("attemptId", envelope.getString("attemptId"))
                                          .put("installationId", envelope.getString("installationId"))
                                          .put("bindingGeneration", posted.getLong("bindingGeneration"))
                                          .put("actionId", actionId == null ? JSONObject.NULL : actionId);
          }
        String interactionId = handle;
        long now = System.currentTimeMillis();
        long ordinal = transaction(() -> {
          long inserted = insertObservation(kind, placeholder, envelope, actionId, user, control == null ? null : control.getLong("revision"), current);
          db.execSQL("INSERT INTO interactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
              new Object[] {interactionId, inserted, kind, actionId, envelope.getString("targetId"), envelope.getString("attemptId"), user, posted.getLong("bindingGeneration"), envelope.toString(), posted.getLong("receivedAt"), now, current ? "pending" : "retired"});
          pause("capture-commit-before");
          return inserted;
        });
        consumed = true;
        pause("capture-commit-after");
        bindTicket(placeholder, ordinal, user, current);
        try {
          cancelPosted("handle=?", new String[] {handle});
        } catch (Throwable error) {
          record("notification-cleanup-failed", new JSONObject(), handle);
        }
        record("interaction-captured", new JSONObject().put("kind", kind).put("ordinal", ordinal).put("current", current).put("pid", android.os.Process.myPid()), interactionId);
        drain();
        try {
          interactionSink.interaction(scope);
        } catch (Throwable ignored) {
        }
      } catch (Throwable error) {
        synchronized (this) {
          if (placeholder != null)
            placeholder.rejected = true;
        }
        record("interaction-failed", new JSONObject(java.util.Collections.singletonMap("code", error instanceof Failure ? ((Failure) error).code : "journal_storage_failure")), handle);
        drain();
      } finally {
        completion.settled(consumed);
        synchronized (this) {
          nativeJobs--;
        }
      }
    });
  }
  void configureNotifications(String lease, String encoded, Promise promise) {
    work(promise, () -> {
      opened();
      leaseCurrent(lease);
      JSONObject setup = GalinumNotifications.parseSetup(encoded);
      JSONObject capabilities = GalinumNotifications.setup(context, setup);
      transaction(() -> {
        db.execSQL("INSERT OR REPLACE INTO settings VALUES(1,?,?,?)", new Object[] {setup.getString("foreground"), capabilities.getJSONArray("channels").toString(), setup.getJSONArray("actions").toString()});
        db.execSQL("INSERT OR REPLACE INTO notification_options VALUES(1,?)", new Object[] {setup.getString("smallIcon")});
        return null;
      });
      record("notifications-configured", capabilities, lease);
      return capabilities.toString();
    });
  }
  void readInteractions(long capture, Promise promise) {
    work(promise, () -> {
      opened();
      current(capture);
      JSONObject proof;
      synchronized (this) {
        if (!ready)
          throw new Failure("binding_unacknowledged");
        proof = binding;
      }
      if (!proof.getBoolean("appConfirmed") || proof.isNull("userId"))
        throw new Failure("binding_unacknowledged");
      JSONArray interactions = new JSONArray();
      try (Cursor row = db.rawQuery(
               "SELECT i.id,i.kind,i.action_id,i.target_id,i.attempt_id,i.user_id,i.binding_generation,i.envelope,i.received_at,i.interacted_at FROM interactions i JOIN observations o ON o.ordinal=i.ordinal WHERE i.status='pending' AND o.status='admitted' AND i.user_id=? AND i.binding_generation=? ORDER BY i.ordinal",
               new String[] {proof.getString("userId"), "" + proof.getLong("generation")})) {
        while (row.moveToNext()) {
          JSONObject envelope = new JSONObject(row.getString(7));
          JSONObject content = envelope.getJSONObject("content");
          JSONObject entry = new JSONObject()
                                 .put("id", row.getString(0))
                                 .put("kind", row.getString(1))
                                 .put("targetId", row.getString(3))
                                 .put("attemptId", row.getString(4))
                                 .put("test", envelope.optBoolean("test", false))
                                 .put("userId", row.getString(5))
                                 .put("bindingGeneration", row.getLong(6))
                                 .put("destination", content.getJSONObject("destination"))
                                 .put("data", content.optJSONObject("data") == null ? new JSONObject() : content.getJSONObject("data"))
                                 .put("title", content.getString("title"))
                                 .put("body", content.getString("body"))
                                 .put("receivedAt", row.getLong(8))
                                 .put("interactedAt", row.getLong(9));
          if (!row.isNull(2))
            entry.put("actionId", row.getString(2));
          interactions.put(entry);
        }
      }
      return interactions.toString();
    });
  }
  void acknowledgeInteraction(long capture, String interactionId, String disposition, Promise promise) {
    work(promise, () -> {
      opened();
      current(capture);
      if (!disposition.equals("handled") && !disposition.equals("retired"))
        throw new Failure("invalid_disposition");
      transaction(() -> {
        db.execSQL("UPDATE interactions SET status=? WHERE id=? AND status='pending'", new Object[] {disposition, interactionId});
        return null;
      });
      record("interaction-acknowledged", new JSONObject().put("disposition", disposition), interactionId);
      return null;
    });
  }
  private void cancelOtherUsers(String user) throws Exception {
    cancelPosted(user == null ? "1" : "user_id<>? OR EXISTS (SELECT 1 FROM interactions WHERE id=notifications.handle) OR EXISTS (SELECT 1 FROM operations WHERE kind='notification-cleanup' AND id=notifications.handle)", user == null ? new String[] {} : new String[] {user});
    db.execSQL("DELETE FROM operations WHERE kind='notification-cleanup' AND NOT EXISTS (SELECT 1 FROM notifications WHERE handle=operations.id)");
  }
  private void finishNotificationCleanup() throws Exception {
    JSONObject row = controlRow();
    cancelOtherUsers(row == null || row.getJSONObject("state").getJSONObject("session").isNull("userId") ? null : row.getJSONObject("state").getJSONObject("session").getString("userId"));
  }
  private void cancelPosted(String selection, String[] arguments) throws Exception {
    ArrayList<String[]> posted = new ArrayList<>();
    try (Cursor row = db.rawQuery("SELECT target_id,notification_id FROM notifications WHERE " + selection, arguments)) {
      while (row.moveToNext()) posted.add(new String[] {row.getString(0), row.getString(1)});
    }
    for (String[] entry : posted) {
      GalinumNotifications.cancel(context, entry[0], Integer.parseInt(entry[1]));
      pause("notification-cancel-after");
    }
    if (!posted.isEmpty()) {
      transaction(() -> {
        db.execSQL("DELETE FROM notifications WHERE " + selection, arguments);
        return null;
      });
      record("notifications-cancelled", new JSONObject().put("count", posted.size()), selection);
    }
  }
  void cancelNotifications(String lease, Promise promise) {
    work(promise, () -> {
      opened();
      leaseCurrent(lease);
      finishNotificationCleanup();
      return null;
    });
  }
  void readCompletion(String lease, String userId, String deliveryId, Promise promise) {
    work(promise, () -> {
      opened();
      leaseCurrent(lease);
      if (userId.isEmpty() || deliveryId.isEmpty())
        throw new Failure("invalid_feedback");
      try (Cursor row = db.rawQuery("SELECT 1 FROM completions WHERE user_id=? AND delivery_id=?", new String[] {userId, deliveryId})) {
        return row.moveToFirst();
      }
    });
  }
  void admitFeedback(String lease, String encoded, Promise promise) {
    work(promise, () -> {
      opened();
      leaseCurrent(lease);
      JSONObject feedback;
      try {
        feedback = new JSONObject(encoded);
      } catch (Exception error) {
        throw new Failure("invalid_feedback");
      }
      String user = feedback.optString("userId", ""), delivery = feedback.optString("deliveryId", ""), type = feedback.optString("type", ""), id = feedback.optString("feedbackId", "");
      String shown = feedback.isNull("shownFeedbackId") ? "" : feedback.optString("shownFeedbackId", "");
      boolean terminal = type.equals("clicked") || type.equals("dismissed") || type.equals("converted");
      if (user.isEmpty() || user.length() > 256 || delivery.isEmpty() || delivery.length() > 256 || id.isEmpty() || id.length() > 256 || !(type.equals("shown") || terminal) || (terminal ? shown.isEmpty() : !shown.isEmpty() && !shown.equals(id)))
        throw new Failure("invalid_feedback");
      String receipt = transaction(() -> {
        try (Cursor row = db.rawQuery("SELECT user_id,delivery_id,type,shown_feedback_id,status FROM feedback WHERE feedback_id=?", new String[] {id})) {
          if (row.moveToFirst()) {
            if (!row.getString(0).equals(user) || !row.getString(1).equals(delivery) || !row.getString(2).equals(type) || !Objects.equals(row.isNull(3) ? "" : row.getString(3), terminal ? shown : ""))
              throw new Failure("feedback_conflict");
            return new JSONObject().put("feedbackId", id).put("state", row.getString(4).equals("acknowledged") ? "acknowledged" : "queued").toString();
          }
        }
        if (terminal) {
          try (Cursor row = db.rawQuery("SELECT 1 FROM feedback WHERE feedback_id=? AND user_id=? AND delivery_id=? AND type='shown'", new String[] {shown, user, delivery})) {
            if (!row.moveToFirst())
              throw new Failure("feedback_shown_required");
          }
          db.execSQL("INSERT OR IGNORE INTO completions VALUES(?,?,?,?)", new Object[] {user, delivery, id, System.currentTimeMillis()});
        }
        db.execSQL("INSERT INTO feedback(feedback_id,user_id,delivery_id,type,shown_feedback_id,status,receipt,created_at) VALUES(?,?,?,?,?,'pending',NULL,?)",
            new Object[] {id, user, delivery, type, terminal ? shown : null, System.currentTimeMillis()});
        pause("feedback-commit-before");
        return new JSONObject().put("feedbackId", id).put("state", "queued").toString();
      });
      record("feedback-admitted", new JSONObject(receipt).put("type", type), id);
      return receipt;
    });
  }
  void peekFeedback(String lease, Promise promise) {
    work(promise, () -> {
      opened();
      leaseCurrent(lease);
      JSONArray pending = new JSONArray();
      try (Cursor row = db.rawQuery("SELECT feedback_id,user_id,delivery_id,type,shown_feedback_id FROM feedback WHERE status='pending' ORDER BY ordinal LIMIT 32", null)) {
        while (row.moveToNext())
          pending.put(new JSONObject().put("feedbackId", row.getString(0)).put("userId", row.getString(1)).put("deliveryId", row.getString(2)).put("type", row.getString(3)).put("shownFeedbackId", row.isNull(4) ? row.getString(0) : row.getString(4)));
      }
      return pending.toString();
    });
  }
  void acknowledgeFeedback(String lease, String feedbackId, String encoded, Promise promise) {
    work(promise, () -> {
      opened();
      leaseCurrent(lease);
      JSONObject receipt;
      try {
        receipt = new JSONObject(encoded);
      } catch (Exception error) {
        throw new Failure("feedback_receipt_mismatch");
      }
      transaction(() -> {
        try (Cursor row = db.rawQuery("SELECT user_id,delivery_id,type,status FROM feedback WHERE feedback_id=?", new String[] {feedbackId})) {
          if (!row.moveToFirst())
            throw new Failure("feedback_receipt_mismatch");
          double at = receipt.optDouble("acknowledgedAt", Double.NaN);
          if (!receipt.optString("userId", "").equals(row.getString(0)) || !receipt.optString("deliveryId", "").equals(row.getString(1)) || !receipt.optString("type", "").equals(row.getString(2)) || !receipt.optString("receiptId", "").equals(feedbackId) || Double.isNaN(at) || Double.isInfinite(at) || at < 0)
            throw new Failure("feedback_receipt_mismatch");
        }
        db.execSQL("UPDATE feedback SET status='acknowledged',receipt=? WHERE feedback_id=?", new Object[] {receipt.toString(), feedbackId});
        return null;
      });
      record("feedback-acknowledged", new JSONObject(), feedbackId);
      return null;
    });
  }
  void release(boolean dispose, Promise promise) {
    synchronized (this) {
      ready = false;
      released = true;
      leaseWork++;
      displayFence++;
      if (dispose) {
        displayOpen = false;
        restrictions++;
      }
      for (Ticket ticket : tickets.values()) ticket.rejected = true;
      proposals.clear();
      record("release", new JSONObject(), dispose ? "dispose" : "reload");
    }
    pause("lease-detached");
    work(promise, () -> {
      try {
      drain();
      if (db != null) {
        transaction(() -> {

          if (dispose) {
            db.execSQL("UPDATE control SET display='closed' WHERE id=1");
          }
          return null;
        });
      }
      return null;
      } finally { synchronized (this) { leaseWork--; } }
    });
  }
}

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
  interface Hooks {
    default void checkpoint(String point) {}
    default void event(String kind, JSONObject data, String detail) {}
  }
  static Hooks hooks = new Hooks() {};
  interface Submission { void submit(JSONObject publication) throws Exception; }
  final ExecutorService executor = Executors.newSingleThreadExecutor();
  final File file, registryFile, keyFile;
  final String scope, keyAlias;
  final LinkedHashMap<String, Ticket> tickets = new LinkedHashMap<>();
  final Map<String, Proposal> proposals = new HashMap<>();
  long submittedCount = 0;
  String owner = null;
  boolean released = true;
  int inFlight = 0;
  long nextTicket = 0, nextProposal = 0, lastOperation = 0;
  long intent = 0;
  boolean initialResolved = false;
  boolean ready = false;
  boolean displayOpen = false;
  long displayFence = 0;
  long restrictions = 0;
  String incarnation;
  JSONObject binding;
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
  static String claim(Context context, String scope) {
    return getOrCreate(context, scope).attach();
  }
  synchronized String attach() {
    if (!released || inFlight > 0)
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
      inFlight++;
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
          inFlight--;
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
      db.execSQL("INSERT OR IGNORE INTO metadata VALUES(1,2,NULL,?)", new Object[] {expectedIncarnation});
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
        db.execSQL("DELETE FROM operations");
        db.execSQL("INSERT INTO operations VALUES(?,?,?,?)", new Object[] {operationId, next, "control", restrictive[0] ? "closed" : "kept"});
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
        db.execSQL("UPDATE metadata SET installation=? WHERE id=1", new Object[] {installation});
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
        if (tickets.isEmpty())
          return;
        ticket = tickets.values().iterator().next();
        if (!released && !ticket.rejected && ticket.intent == 0 && !initialResolved)
          return;
        if (ticket.rejected || ticket.intent != intent || released) {
          tickets.remove(ticket.id);
          for (Promise waiter : ticket.promises) fail(waiter, new Failure("superseded"));
          continue;
        }
        if (db == null || !ready || ticket.event == null && ticket.observation == null)
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
  private String persist(Ticket ticket, JSONObject proof) throws Exception {
    current(ticket.intent);
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
  void release(boolean dispose, Promise promise) {
    synchronized (this) {
      ready = false;
      released = true;
      inFlight++;
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
      } finally { synchronized (this) { inFlight--; } }
    });
  }
}

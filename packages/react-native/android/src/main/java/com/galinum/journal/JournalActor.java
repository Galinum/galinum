package com.galinum.journal;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteFullException;
import com.facebook.react.bridge.Promise;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import net.zetetic.database.sqlcipher.SQLiteDatabase;
import org.json.JSONArray;
import org.json.JSONObject;

final class JournalActor {
  private static final Map<String, JournalActor> actors = new HashMap<>();
  final String owner = UUID.randomUUID().toString();
  final ExecutorService executor = Executors.newSingleThreadExecutor();
  final File file;
  final String scope;
  final LinkedHashMap<String, Ticket> tickets = new LinkedHashMap<>();
  long nextTicket = 0;
  long intent = 0;
  boolean initialResolved = false;
  boolean released = false;
  boolean ready = false;
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
  private JournalActor(Context context, String scope) {
    if (!scope.matches("[a-f0-9]{64}"))
      throw new Failure("invalid_scope");
    this.scope = scope;
    file = new File(new File(context.getApplicationInfo().dataDir, "no_backup"),
        "galinum-journal-" + scope + ".db");
  }
  static synchronized String claim(Context context, String scope) {
    if (actors.containsKey(scope))
      throw new Failure("journal_writer_busy");
    JournalActor actor = new JournalActor(context, scope);
    actors.put(scope, actor);
    return actor.owner;
  }
  static synchronized JournalActor get(String scope, String owner) {
    JournalActor actor = actors.get(scope);
    if (actor == null || !actor.owner.equals(owner) || actor.released)
      throw new Failure("journal_owner_stale");
    return actor;
  }
  static void hasStore(Context context, String scope, Promise promise) {
    if (!scope.matches("[a-f0-9]{64}")) {
      promise.reject("invalid_scope", "Galinum invalid_scope");
      return;
    }
    JournalActor actor;
    synchronized (JournalActor.class) {
      actor = actors.get(scope);
    }
    if (actor == null) {
      promise.reject("journal_owner_stale", "Galinum journal_owner_stale");
      return;
    }
    actor.work(promise, () -> actor.file.exists());
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
      return new JSONObject().put("id", ticket.id).put("eventId", ticket.eventId).toString();
    } catch (Exception error) {
      throw new Failure("invalid_event");
    }
  }
  synchronized void setIntent(long value) {
    if (value < intent)
      throw new Failure("superseded");
    intent = value;
    ready = false;
    for (Ticket ticket : tickets.values())
      if (ticket.intent < value && (ticket.intent != 0 || initialResolved))
        ticket.rejected = true;
    executor.execute(this::drain);
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
  private void opened() {
    if (db == null)
      throw new Failure("journal_not_open");
  }
  private void work(Promise promise, Callable<Object> action) {
    executor.execute(() -> {
      try {
        Object result = action.call();
        if (promise != null)
          promise.resolve(result);
      } catch (Throwable error) {
        if (promise != null)
          fail(promise, error);
      }
    });
  }
  private static void fail(Promise promise, Throwable error) {
    String code = error instanceof Failure ? ((Failure) error).code
        : (error instanceof SQLiteFullException
              || error instanceof android.database.sqlite.SQLiteException
                  && String.valueOf(error.getMessage()).matches("(?s).*\\bcode 13\\b.*"))
        ? "journal_storage_full"
        : "journal_storage_failure";
    promise.reject(code, "Galinum " + code);
  }
  private <T> T transaction(Callable<T> body) throws Exception {
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
  void open(String key, Promise promise) {
    work(promise, () -> {
      if (db != null)
        return null;
      if (!key.matches("[a-f0-9]{64}"))
        throw new Failure("invalid_journal_key");
      if (!file.getParentFile().isDirectory() && !file.getParentFile().mkdirs())
        throw new Failure("journal_storage_failure");
      System.loadLibrary("sqlcipher");
      try {
        db = SQLiteDatabase.openOrCreateDatabase(
            file, key, null, (database, error) -> { throw new Failure("journal_corrupt"); }, null);
        db.enableWriteAheadLogging();
        db.execSQL("PRAGMA synchronous=FULL");
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS metadata(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,installation TEXT,intent INTEGER NOT NULL,gate TEXT NOT NULL)");
        db.execSQL("INSERT OR IGNORE INTO metadata VALUES(1,1,NULL,0,'closed')");
        if (number("SELECT version FROM metadata WHERE id=1") != 1)
          throw new Failure("journal_version");
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS streams(generation INTEGER PRIMARY KEY,user_id TEXT,next_sequence INTEGER NOT NULL,acknowledged INTEGER NOT NULL)");
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS commands(generation INTEGER NOT NULL,sequence INTEGER NOT NULL,id TEXT NOT NULL UNIQUE,body TEXT NOT NULL,PRIMARY KEY(generation,sequence)) WITHOUT ROWID");
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,event TEXT NOT NULL,props TEXT NOT NULL,generation INTEGER NOT NULL,sequence INTEGER NOT NULL)");
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS batches(generation INTEGER PRIMARY KEY,through INTEGER NOT NULL,body TEXT NOT NULL)");
        db.execSQL("UPDATE metadata SET gate='closed' WHERE id=1");
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
      return null;
    });
  }
  void closeGate(long requested, Promise promise) {
    work(promise, () -> {
      opened();
      long currentIntent;
      synchronized (this) {
        if (requested > intent)
          throw new Failure("superseded");
        ready = false;
        currentIntent = intent;
      }
      transaction(() -> {
        db.execSQL(
            "UPDATE metadata SET intent=?,gate='closed' WHERE id=1", new Object[] {currentIntent});
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
        db.execSQL(
            "INSERT OR IGNORE INTO streams VALUES(?,?,1,0)", new Object[] {generation, user});
        try (Cursor row = db.rawQuery("SELECT user_id FROM streams WHERE generation=?",
                 new String[] {"" + generation})) {
          row.moveToFirst();
          String prior = row.isNull(0) ? null : row.getString(0);
          if (!java.util.Objects.equals(prior, user))
            throw new Failure("binding_generation_conflict");
        }
        db.execSQL("UPDATE metadata SET installation=?,intent=?,gate=? WHERE id=1",
            new Object[] {installation, capture, encoded});
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
    Ticket ticket = new Ticket(owner, ++nextTicket, intent, "");
    ticket.observation = immutable;
    tickets.put(ticket.id, ticket);
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
  void release(Promise promise) {
    synchronized (this) {
      ready = false;
      released = true;
      for (Ticket ticket : tickets.values()) ticket.rejected = true;
    }
    work(promise, () -> {
      drain();
      if (db != null) {
        transaction(() -> {
          db.execSQL("UPDATE metadata SET gate='closed' WHERE id=1");
          return null;
        });
        db.close();
        db = null;
      }
      synchronized (JournalActor.class) {
        if (actors.get(scope) == this)
          actors.remove(scope);
      }
      executor.shutdown();
      return null;
    });
  }
}

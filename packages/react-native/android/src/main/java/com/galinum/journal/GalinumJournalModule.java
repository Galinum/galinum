package com.galinum.journal;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.module.annotations.ReactModule;

@ReactModule(name = GalinumJournalModule.NAME)
public final class GalinumJournalModule extends NativeGalinumJournalSpec {
  private final java.util.Map<String, String> owned = new java.util.HashMap<>();
  public static final String NAME = "GalinumJournal";
  public GalinumJournalModule(ReactApplicationContext context) {
    super(context);
  }
  @Override
  public void invalidate() {
    synchronized (owned) {
      for (java.util.Map.Entry<String, String> entry : owned.entrySet()) try {
          JournalActor.get(entry.getKey(), entry.getValue()).release(null);
        } catch (JournalActor.Failure stale) {
        }
      owned.clear();
    }
    super.invalidate();
  }
  @Override
  public String getName() {
    return NAME;
  }
  @Override
  public String claim(String scope) {
    String owner = JournalActor.claim(getReactApplicationContext(), scope);
    synchronized (owned) {
      owned.put(scope, owner);
    }
    return owner;
  }
  @Override
  public String reserve(String scope, String owner, double intent, String eventId) {
    return JournalActor.get(scope, owner).reserve((long) intent, eventId);
  }
  @Override
  public void resolveInitialIntent(String scope, String owner, double destination) {
    JournalActor.get(scope, owner).resolveInitial((long) destination);
  }
  @Override
  public void setIntent(String scope, String owner, double intent) {
    JournalActor.get(scope, owner).setIntent((long) intent);
  }
  @Override
  public void rejectTicket(String scope, String owner, String ticket) {
    JournalActor.get(scope, owner).reject(ticket);
  }
  @Override
  public void hasStore(String scope, Promise promise) {
    JournalActor.hasStore(getReactApplicationContext(), scope, promise);
  }
  @Override
  public void open(String scope, String owner, String key, Promise promise) {
    JournalActor.get(scope, owner).open(key, promise);
  }
  @Override
  public void closeGate(String scope, String owner, double intent, Promise promise) {
    JournalActor.get(scope, owner).closeGate((long) intent, promise);
  }
  @Override
  public void publishBinding(
      String scope, String owner, double intent, String binding, Promise promise) {
    JournalActor.get(scope, owner).publish((long) intent, binding, promise);
  }
  @Override
  public void admitEvent(String scope, String owner, String ticket, String event, Promise promise) {
    JournalActor.get(scope, owner).admit(ticket, event, promise);
  }
  @Override
  public void peek(String scope, String owner, double intent, Promise promise) {
    JournalActor.get(scope, owner).peek((long) intent, promise);
  }
  @Override
  public void acknowledge(String scope, String owner, double intent, double generation,
      double through, Promise promise) {
    JournalActor.get(scope, owner)
        .acknowledge((long) intent, (long) generation, (long) through, promise);
  }
  @Override
  public void release(String scope, String owner, Promise promise) {
    JournalActor.get(scope, owner).release(promise);
  }
}

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
          JournalActor.get(entry.getKey(), entry.getValue()).release(false, null);
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
  public boolean resolveInitialIntent(String scope, String owner, double destination) {
    JournalActor.get(scope, owner).resolveInitial((long) destination);
    return true;
  }
  @Override
  public double setIntent(String scope, String owner, double intent) {
    return JournalActor.get(scope, owner).setIntent((long) intent);
  }
  @Override
  public boolean rejectTicket(String scope, String owner, String ticket) {
    JournalActor.get(scope, owner).reject(ticket);
    return true;
  }
  @Override
  public double restrictDisplay(String scope, String owner) {
    return JournalActor.get(scope, owner).restrictDisplay();
  }
  @Override
  public String proposeDisplay(String scope, String owner, String proposal) {
    return JournalActor.get(scope, owner).proposeDisplay(proposal);
  }
  @Override
  public void open(String scope, String owner, Promise promise) {
    JournalActor.get(scope, owner).open(owner, promise);
  }
  @Override
  public void readControl(String scope, String owner, Promise promise) {
    JournalActor.get(scope, owner).readControl(owner, promise);
  }
  @Override
  public void commitControl(String scope, String owner, String operationId, double expectedRevision, String state, boolean restrict, Promise promise) {
    JournalActor.get(scope, owner).commitControl(owner, operationId, (long) expectedRevision, state, restrict, promise);
  }
  @Override
  public void operation(String scope, String owner, String operationId, Promise promise) {
    JournalActor.get(scope, owner).operation(owner, operationId, promise);
  }
  @Override
  public void publishDisplay(String scope, String owner, String proposal, Promise promise) {
    JournalActor.get(scope, owner).publishDisplay(owner, proposal, promise);
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
    synchronized (owned) {
      owned.remove(scope);
    }
    JournalActor.get(scope, owner).release(true, promise);
  }
}

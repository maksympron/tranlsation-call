const crypto = require("crypto");

function createDirectLoopState() {
  return {
    enabled: false,
    callSid: null,
    callStatus: "idle",
    inFlight: false,
    remoteTurnArmed: false,
    recordingSids: [],
    lastAppSourceText: null,
    lastAppTranslatedText: null,
    lastAppUpdatedAt: null,
    lastTwilioUpdateMs: null,
    lastRemoteSourceText: null,
    lastRemoteTranslatedText: null,
    lastRemoteMessageId: null,
    lastRemoteUpdatedAt: null,
    lastRemoteSttMs: null,
    lastError: null,
  };
}

class InMemorySessionStore {
  constructor({ defaultCallerId, maxEventLog, logger }) {
    this.defaultCallerId = defaultCallerId || null;
    this.maxEventLog = maxEventLog || 100;
    this.logger = logger;
    this.sessions = new Map();
  }

  create(payload = {}) {
    const id = crypto.randomUUID();
    const session = {
      id,
      createdAt: new Date().toISOString(),
      to: typeof payload.to === "string" ? payload.to.trim() : null,
      from:
        typeof payload.from === "string" && payload.from.trim()
          ? payload.from.trim()
          : this.defaultCallerId,
      sourceLanguage: payload.sourceLanguage || "uk-UA",
      targetLanguage: payload.targetLanguage || "en-US",
      notes: payload.notes || "",
      status: "created",
      directLoop: createDirectLoopState(),
      lastTwilioCall: null,
      events: [],
    };

    this.sessions.set(id, session);
    this.appendEvent(session, "session_created", {
      to: session.to,
      from: session.from,
      sourceLanguage: session.sourceLanguage,
      targetLanguage: session.targetLanguage,
    });

    return session;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  count() {
    return this.sessions.size;
  }

  appendEvent(session, type, details = {}) {
    const entry = {
      at: new Date().toISOString(),
      type,
      ...details,
    };

    session.events.push(entry);

    if (session.events.length > this.maxEventLog) {
      session.events.shift();
    }

    this.logger.sessionEvent(session.id, type, details);
  }

  serialize(session) {
    return {
      id: session.id,
      createdAt: session.createdAt,
      to: session.to,
      from: session.from,
      sourceLanguage: session.sourceLanguage,
      targetLanguage: session.targetLanguage,
      notes: session.notes,
      status: session.status,
      directLoop: {
        enabled: session.directLoop.enabled,
        callSid: session.directLoop.callSid,
        callStatus: session.directLoop.callStatus,
        inFlight: session.directLoop.inFlight,
        recordingCount: session.directLoop.recordingSids.length,
        lastAppSourceText: session.directLoop.lastAppSourceText,
        lastAppTranslatedText: session.directLoop.lastAppTranslatedText,
        lastAppUpdatedAt: session.directLoop.lastAppUpdatedAt,
        lastTwilioUpdateMs: session.directLoop.lastTwilioUpdateMs,
        lastRemoteSourceText: session.directLoop.lastRemoteSourceText,
        lastRemoteTranslatedText: session.directLoop.lastRemoteTranslatedText,
        lastRemoteMessageId: session.directLoop.lastRemoteMessageId,
        lastRemoteUpdatedAt: session.directLoop.lastRemoteUpdatedAt,
        lastRemoteSttMs: session.directLoop.lastRemoteSttMs,
        lastError: session.directLoop.lastError,
      },
      lastTwilioCall: session.lastTwilioCall,
      events: session.events,
    };
  }
}

module.exports = {
  InMemorySessionStore,
};

  const fs = require("fs");
  const http = require("http");
  const path = require("path");
  const crypto = require("crypto");
  const { URL } = require("url");
  const twilio = require("twilio");

  const { loadEnvFile } = require("./env");
  const azureAdapter = require("./azureAdapter");

  loadEnvFile();

  const PORT = Number(process.env.PORT || process.env.TWILIO_CALLS_PORT || 8787);
  const HOST = process.env.HOST || "0.0.0.0";
  const APP_API_TOKEN = process.env.APP_API_TOKEN || "";
  const MAX_EVENT_LOG = 100;
  const DIRECT_TURN_WAIT_TIMEOUT_MS = Number(
    process.env.TWILIO_DIRECT_TURN_WAIT_TIMEOUT_MS || 35000
  );
  const DIRECT_TURN_RECORD_MAX_LENGTH = Number(
    process.env.TWILIO_DIRECT_TURN_RECORD_MAX_LENGTH || 20
  );
const DIRECT_TURN_RECORD_TIMEOUT = Math.max(
  Number(process.env.TWILIO_DIRECT_TURN_RECORD_TIMEOUT || 0) || 0,
  2
);
  const DIRECT_INITIAL_RECORD_MAX_LENGTH = Number(
    process.env.TWILIO_DIRECT_INITIAL_RECORD_MAX_LENGTH || 30
  );
  const DIRECT_INITIAL_RECORD_TIMEOUT = Number(
    process.env.TWILIO_DIRECT_INITIAL_RECORD_TIMEOUT || 45
  );
  const DIRECT_RECORDING_POLL_INTERVAL_MS = Number(300);
  const REMOTE_STT_MIN_CONFIDENCE = Number(
    process.env.TWILIO_REMOTE_STT_MIN_CONFIDENCE || 0.55
  );
  const REMOTE_STT_MIN_MEDIUM_CONFIDENCE = Number(
    process.env.TWILIO_REMOTE_STT_MIN_MEDIUM_CONFIDENCE || 0.46
  );
  const REMOTE_STT_MIN_LONG_CONFIDENCE = Number(
    process.env.TWILIO_REMOTE_STT_MIN_LONG_CONFIDENCE || 0.42
  );
  const REMOTE_STT_MIN_SHORT_CONFIDENCE = Number(
    process.env.TWILIO_REMOTE_STT_MIN_SHORT_CONFIDENCE || 0.78
  );
  const REMOTE_STT_MIN_RECORDING_DURATION_S = Number(
    process.env.TWILIO_REMOTE_STT_MIN_RECORDING_DURATION_S || 1.1
  );
  const REMOTE_CAPTURE_RETRY_LIMIT = Number(
    process.env.TWILIO_REMOTE_CAPTURE_RETRY_LIMIT || 2
  );
  const DEBUG_ARTIFACTS_DIR =
    process.env.TWILIO_CALLS_DEBUG_DIR || "/tmp/twilio-calls-debug";
const SAVE_DEBUG_ARTIFACTS =
  process.env.TWILIO_CALLS_SAVE_DEBUG_ARTIFACTS !== "0";

const sessions = new Map();

function ensureDebugDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function saveDebugArtifact(session, recordingSid, suffix, content, encoding = null) {
  if (!SAVE_DEBUG_ARTIFACTS) {
    return null;
  }

  const sessionDir = path.join(DEBUG_ARTIFACTS_DIR, session.id);
  ensureDebugDir(sessionDir);
  const filePath = path.join(sessionDir, `${recordingSid}${suffix}`);

  if (encoding) {
    fs.writeFileSync(filePath, content, encoding);
  } else {
    fs.writeFileSync(filePath, content);
  }

  return filePath;
}

function resolveTurnCaptureWindowMs(waitTimeoutMs, recordMaxLength) {
  const requestedWindowMs = Number(waitTimeoutMs || 0);
  const captureWindowMs =
    (Number(recordMaxLength || DIRECT_TURN_RECORD_MAX_LENGTH) +
      DIRECT_TURN_RECORD_TIMEOUT +
      12) *
    1000;

  return Math.max(
    Number.isFinite(requestedWindowMs) && requestedWindowMs > 0
      ? requestedWindowMs
      : DIRECT_TURN_WAIT_TIMEOUT_MS,
    captureWindowMs
  );
}

  function corsHeaders() {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    };
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(payload, null, 2));
  }

  function badRequest(res, message) {
    sendJson(res, 400, { error: message });
  }

  function unauthorized(res) {
    sendJson(res, 401, { error: "Unauthorized" });
  }

  function notFound(res) {
    sendJson(res, 404, { error: "Not found" });
  }

  function escapeXml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function isAuthorized(req) {
    if (!APP_API_TOKEN) {
      return true;
    }

    const authHeader = String(req.headers.authorization || "");
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";
    const apiKey = String(req.headers["x-api-key"] || "").trim();

    return bearerToken === APP_API_TOKEN || apiKey === APP_API_TOKEN;
  }

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

function tokenizeSpeech(text) {
  return String(text || "")
    .replace(/[^\p{L}\p{N}\s'.-]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function shouldFilterRemoteSpeech({
  text,
  confidence,
  recordingDurationSeconds,
}) {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) {
    return { filter: true, reason: "empty_text" };
  }

  const tokens = tokenizeSpeech(normalizedText);
  const compact = normalizedText.replace(/[^\p{L}\p{N}]/gu, "");
  const isShortUtterance = tokens.length <= 1 && compact.length <= 6;
  const hasConfidence = Number.isFinite(confidence) && confidence > 0;
  const duration = Number(recordingDurationSeconds || 0);
  const isLongUtterance =
    tokens.length >= 5 || (Number.isFinite(duration) && duration >= 4);
  const isMediumUtterance =
    !isLongUtterance &&
    (tokens.length >= 3 || (Number.isFinite(duration) && duration >= 2.5));

  if (
    Number.isFinite(duration) &&
    duration > 0 &&
    duration < REMOTE_STT_MIN_RECORDING_DURATION_S &&
    (!hasConfidence || confidence < REMOTE_STT_MIN_SHORT_CONFIDENCE)
  ) {
    return {
      filter: true,
      reason: `recording_too_short_${duration}s`,
    };
  }

  if (isShortUtterance && (!hasConfidence || confidence < REMOTE_STT_MIN_SHORT_CONFIDENCE)) {
    return {
      filter: true,
      reason: `short_utterance_${confidence || "no_confidence"}`,
    };
  }

  return { filter: false, reason: "" };
}

function logEvent(session, type, details = {}) {
  const entry = {
    at: new Date().toISOString(),
    type,
    ...details,
  };

  session.events.push(entry);

  if (session.events.length > MAX_EVENT_LOG) {
    session.events.shift();
  }

  try {
    console.log(
      `[twilio-calls] event ${type} session=${session.id} ${JSON.stringify(details)}`
    );
  } catch (error) {
    console.log(`[twilio-calls] event ${type} session=${session.id}`);
  }
}

  function createSession(payload = {}) {
    const id = crypto.randomUUID();
    const session = {
      id,
      createdAt: new Date().toISOString(),
      to: typeof payload.to === "string" ? payload.to.trim() : null,
      from:
        typeof payload.from === "string" && payload.from.trim()
          ? payload.from.trim()
          : process.env.TWILIO_CALLER_ID || null,
      sourceLanguage: payload.sourceLanguage || "uk-UA",
      targetLanguage: payload.targetLanguage || "en-US",
      notes: payload.notes || "",
      status: "created",
      directLoop: createDirectLoopState(),
      lastTwilioCall: null,
      events: [],
    };

    sessions.set(id, session);
    logEvent(session, "session_created", {
      to: session.to,
      from: session.from,
      sourceLanguage: session.sourceLanguage,
      targetLanguage: session.targetLanguage,
    });

    return session;
  }

function serializeSession(session) {
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

function getTwilioSayLanguage(locale) {
  return azureAdapter.canonicalSpeechLocale(locale || "en-US") || "en-US";
}

function getLocalizedCallPrompt(locale, type) {
  const canonical = getTwilioSayLanguage(locale);
  const prompts = {
    connected: {
      "en-US": "Translated call connected. Please wait for the first translated message.",
      "en-GB": "Translated call connected. Please wait for the first translated message.",
      "uk-UA": "Перекладений дзвінок підключено. Будь ласка, зачекайте на перше перекладене повідомлення.",
      "ru-RU": "Переведённый звонок подключён. Пожалуйста, дождитесь первого переведённого сообщения.",
    },
    reprompt: {
      "en-US": "Sorry, please say that again after the tone.",
      "en-GB": "Sorry, please say that again after the tone.",
      "uk-UA": "Будь ласка, скажіть це ще раз після сигналу.",
      "ru-RU": "Пожалуйста, повторите это ещё раз после сигнала.",
    },
  };

  return prompts[type]?.[canonical] || prompts[type]?.["en-US"] || "";
}

function buildDirectConversationWaitTwiml(locale) {
  const sayLanguage = getTwilioSayLanguage(locale);

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${sayLanguage}">${escapeXml(
    getLocalizedCallPrompt(locale, "connected")
  )}</Say>
  <Pause length="600" />
</Response>`;
}

  function buildDirectConversationTurnTwiml(
    locale,
    translatedText,
    recordMaxLength = DIRECT_TURN_RECORD_MAX_LENGTH
  ) {
  const sayLanguage = getTwilioSayLanguage(locale);

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${sayLanguage}">${escapeXml(
    translatedText
  )}</Say>
  <Record playBeep="true" timeout="${DIRECT_TURN_RECORD_TIMEOUT}" maxLength="${recordMaxLength}" trim="do-not-trim" />
  <Pause length="600" />
</Response>`;
}

  function buildDirectConversationRepromptTwiml(
    locale,
    recordMaxLength = DIRECT_TURN_RECORD_MAX_LENGTH
  ) {
    const sayLanguage = getTwilioSayLanguage(locale);

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${sayLanguage}">${escapeXml(
      getLocalizedCallPrompt(locale, "reprompt")
    )}</Say>
  <Record playBeep="true" timeout="${DIRECT_TURN_RECORD_TIMEOUT}" maxLength="${recordMaxLength}" trim="do-not-trim" />
  <Pause length="600" />
</Response>`;
  }

  async function translateBetweenLocales(sourceText, sourceLocale, targetLocale) {
    const normalizedText = String(sourceText || "").trim();
    if (!normalizedText) {
      return "";
    }

    if (
      azureAdapter.canonicalTranslationLocale(sourceLocale) ===
      azureAdapter.canonicalTranslationLocale(targetLocale)
    ) {
      return normalizedText;
    }

    return azureAdapter.translateText(
      normalizedText,
      sourceLocale,
      targetLocale
    );
  }

  function twilioAuthHeader() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      throw new Error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");
    }

    return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
  }

  let twilioClient = null;

  function getTwilioClient() {
    if (twilioClient) {
      return twilioClient;
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      throw new Error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");
    }

    twilioClient = twilio(accountSid, authToken);
    return twilioClient;
  }

  function serializeTwilioError(error) {
    return {
      status: Number(error?.status || 0) || null,
      code: Number(error?.code || 0) || null,
      message: String(error?.message || "Unknown Twilio error"),
      moreInfo:
        typeof error?.moreInfo === "string" && error.moreInfo
          ? error.moreInfo
          : null,
    };
  }

  async function createTwilioDirectConversationCall(session) {
    const callerId = session.from || process.env.TWILIO_CALLER_ID;

    if (!callerId) {
      throw new Error(
        "Missing TWILIO_CALLER_ID for direct conversation call"
      );
    }

    if (!session.to) {
      throw new Error("Session has no destination phone number");
    }

    const startedAt = Date.now();
    const client = getTwilioClient();

    try {
      const twilioCall = await client.calls.create({
        to: session.to,
        from: callerId,
        twiml: buildDirectConversationWaitTwiml(session.targetLanguage),
      });

      session.lastTwilioCall = {
        requestedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        statusCode: 201,
        body: twilioCall,
      };

      logEvent(session, "direct_call_requested", {
        statusCode: 201,
        durationMs: session.lastTwilioCall.durationMs,
        sid: twilioCall?.sid || null,
      });

      return twilioCall;
    } catch (error) {
      const serializedError = serializeTwilioError(error);
      session.lastTwilioCall = {
        requestedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        statusCode: serializedError.status,
        body: serializedError,
      };

      logEvent(session, "direct_call_requested", {
        statusCode: serializedError.status,
        durationMs: session.lastTwilioCall.durationMs,
        sid: null,
        error: serializedError.message,
        code: serializedError.code,
      });

      throw new Error(
        `Twilio direct conversation call failed${
          serializedError.status ? ` with ${serializedError.status}` : ""
        }: ${serializedError.message}`
      );
    }
  }

  async function fetchTwilioCall(callSid) {
    try {
      return await getTwilioClient().calls(callSid).fetch();
    } catch (error) {
      const serializedError = serializeTwilioError(error);
      throw new Error(
        `Failed to fetch Twilio call ${callSid}${
          serializedError.status ? ` (${serializedError.status})` : ""
        }: ${serializedError.message}`
      );
    }
  }

  async function listTwilioRecordings(callSid) {
    try {
      return await getTwilioClient().recordings.list({
        callSid,
        limit: 20,
      });
    } catch (error) {
      const serializedError = serializeTwilioError(error);
      throw new Error(
        `Failed to list Twilio recordings for ${callSid}${
          serializedError.status ? ` (${serializedError.status})` : ""
        }: ${serializedError.message}`
      );
    }
  }

  async function downloadTwilioRecordingWav(recordingUrl) {
    const wavUrl = recordingUrl.endsWith(".wav")
      ? recordingUrl
      : `${recordingUrl}.wav`;
    const response = await fetch(wavUrl, {
      headers: {
        Authorization: twilioAuthHeader(),
      },
    });

    const arrayBuffer = await response.arrayBuffer();
    if (!response.ok) {
      throw new Error(
        `Failed to download Twilio recording with ${
          response.status
        }: ${Buffer.from(arrayBuffer).toString("utf8")}`
      );
    }

    return Buffer.from(arrayBuffer);
  }

  async function updateTwilioCallTwiml(callSid, twiml) {
    try {
      return await getTwilioClient().calls(callSid).update({ twiml });
    } catch (error) {
      const serializedError = serializeTwilioError(error);
      throw new Error(
        `Failed to update Twilio call ${callSid}${
          serializedError.status ? ` (${serializedError.status})` : ""
        }: ${serializedError.message}`
      );
    }
  }

  async function waitForNewTwilioRecording(
    callSid,
    knownRecordingSids = [],
    timeoutMs = DIRECT_TURN_WAIT_TIMEOUT_MS
  ) {
    const startedAt = Date.now();
    const knownSet = new Set(knownRecordingSids);

    while (Date.now() - startedAt < timeoutMs) {
      const [call, recordings] = await Promise.all([
        fetchTwilioCall(callSid),
        listTwilioRecordings(callSid),
      ]);

      const newRecording = recordings.find((recording) => {
        if (knownSet.has(recording.sid)) {
          return false;
        }

        const status = String(recording.status || "").toLowerCase();
        const duration = Number(recording.duration || 0);
        return status === "completed" || duration > 0;
      });

      if (newRecording) {
        return { call, recording: newRecording };
      }

      if (["busy", "failed", "no-answer", "canceled", "completed"].includes(call.status)) {
        throw new Error(
          `Call ended before a new recording was created. Final status: ${call.status}`
        );
      }

      await new Promise((resolve) =>
        setTimeout(resolve, DIRECT_RECORDING_POLL_INTERVAL_MS)
      );
    }

    throw new Error("Timed out waiting for a new Twilio recording");
  }

  async function runDirectConversationTurn(session, options = {}) {
    const callSid = session.directLoop.callSid;
    if (!callSid) {
      throw new Error("Direct conversation call has not been started");
    }

    const waitTimeoutMs = resolveTurnCaptureWindowMs(
      options.waitTimeoutMs || DIRECT_TURN_WAIT_TIMEOUT_MS,
      options.recordMaxLength || DIRECT_TURN_RECORD_MAX_LENGTH
    );
    const recordMaxLength = Number(
      options.recordMaxLength || DIRECT_TURN_RECORD_MAX_LENGTH
    );
    const startedAt = Date.now();
    let retriesRemaining = REMOTE_CAPTURE_RETRY_LIMIT;

    while (Date.now() - startedAt < waitTimeoutMs) {
      const { call, recording } = await waitForNewTwilioRecording(
        callSid,
        session.directLoop.recordingSids,
        waitTimeoutMs - (Date.now() - startedAt)
      );

      session.directLoop.callStatus = call.status;
      session.directLoop.recordingSids.push(recording.sid);
      const recordingDurationValue = recording.duration || null;
      logEvent(session, "remote_recording_ready", {
        callSid,
        recordingSid: recording.sid,
        recordingDuration: recordingDurationValue,
      });

      const sttStartedAt = Date.now();
      const wavBuffer = await downloadTwilioRecordingWav(
        `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${recording.sid}`
      );
      const wavPath = saveDebugArtifact(session, recording.sid, ".wav", wavBuffer);
      const sttResult = await azureAdapter.transcribeWavBuffer(
        wavBuffer,
        session.targetLanguage,
        8000
      );
      const sttJsonPath = saveDebugArtifact(
        session,
        recording.sid,
        ".stt.json",
        JSON.stringify(sttResult?.raw || {}, null, 2),
        "utf8"
      );
      const sttMs = Date.now() - sttStartedAt;
      const sourceText = sttResult?.text || "";
      const sttConfidence = Number(sttResult?.confidence || 0);
      const recognitionStatus =
        sttResult?.recognitionStatus || "Unknown";
      const recordingDurationSeconds = Number(recordingDurationValue || 0);

      logEvent(session, "remote_stt_debug", {
        callSid,
        recordingSid: recording.sid,
        sourceText,
        confidence: sttConfidence,
        recognitionStatus,
        recordingDuration: recordingDurationValue,
        wavPath,
        sttJsonPath,
      });

      if (!sourceText || sourceText === "NoMatch") {
        session.directLoop.lastRemoteSttMs = sttMs;
        logEvent(session, "remote_no_match", {
          callSid,
          recordingSid: recording.sid,
          sttMs,
          recognitionStatus,
          confidence: sttConfidence,
          recordingDuration: recordingDurationValue,
          wavPath,
          sttJsonPath,
        });
        if (retriesRemaining > 0) {
          retriesRemaining -= 1;
          session.directLoop.lastError = null;
          await updateTwilioCallTwiml(
            callSid,
            buildDirectConversationRepromptTwiml(
              session.targetLanguage,
              recordMaxLength
            )
          );
          logEvent(session, "remote_reprompt_requested", {
            callSid,
            recordingSid: recording.sid,
            reason: "no_match",
            retriesRemaining,
          });
        } else {
          session.directLoop.lastError = "Remote speech was not recognized";
        }
        continue;
      }

      const remoteSpeechFilter = shouldFilterRemoteSpeech({
        text: sourceText,
        confidence: sttConfidence,
        recordingDurationSeconds,
      });
      if (remoteSpeechFilter.filter) {
        session.directLoop.lastRemoteSttMs = sttMs;
        logEvent(session, "remote_speech_filtered", {
          callSid,
          recordingSid: recording.sid,
          sourceText,
          confidence: sttConfidence,
          recognitionStatus,
          recordingDuration: recordingDurationValue,
          sttMs,
          reason: remoteSpeechFilter.reason,
          wavPath,
          sttJsonPath,
        });
        if (retriesRemaining > 0) {
          retriesRemaining -= 1;
          session.directLoop.lastError = null;
          await updateTwilioCallTwiml(
            callSid,
            buildDirectConversationRepromptTwiml(
              session.targetLanguage,
              recordMaxLength
            )
          );
          logEvent(session, "remote_reprompt_requested", {
            callSid,
            recordingSid: recording.sid,
            reason: remoteSpeechFilter.reason,
            retriesRemaining,
          });
        } else {
          session.directLoop.lastError = `Remote speech ignored: ${remoteSpeechFilter.reason}`;
        }
        continue;
      }

      const translatedText = await translateBetweenLocales(
        sourceText,
        session.targetLanguage,
        session.sourceLanguage
      );

      session.directLoop.lastRemoteSourceText = sourceText;
      session.directLoop.lastRemoteTranslatedText = translatedText;
      session.directLoop.lastRemoteMessageId = crypto.randomUUID();
      session.directLoop.lastRemoteUpdatedAt = new Date().toISOString();
      session.directLoop.lastRemoteSttMs = sttMs;
      session.directLoop.lastError = null;

      logEvent(session, "remote_turn_recognized", {
        callSid,
        sourceText,
        translatedText,
        confidence: sttConfidence,
        recognitionStatus,
        recordingDuration: recordingDurationValue,
        sttMs,
        wavPath,
        sttJsonPath,
      });
      return;
    }

    throw new Error("Timed out waiting for recognizable remote speech");
  }

  function armDirectConversationRemoteTurn(session, options = {}) {
    if (!session.directLoop.callSid || session.directLoop.remoteTurnArmed) {
      return false;
    }

    session.directLoop.remoteTurnArmed = true;
    runDirectConversationTurn(session, options)
      .catch((error) => {
        session.directLoop.lastError = error.message;
        logEvent(session, "remote_turn_failed", {
          callSid: session.directLoop.callSid,
          error: error.message,
        });
      })
      .finally(() => {
        session.directLoop.remoteTurnArmed = false;
        session.directLoop.inFlight = false;
      });

    return true;
  }

  function getSessionIdFromPath(pathname) {
    const match = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/.*)?$/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  async function parseJsonBody(req) {
    const rawBody = await readBody(req);
    if (!rawBody) {
      return {};
    }

    try {
      return JSON.parse(rawBody);
    } catch (error) {
      throw new Error("Request body must be valid JSON");
    }
  }

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;
  const requestStartedAt = Date.now();

  console.log(
    `[twilio-calls] request ${req.method} ${pathname} host=${req.headers.host || "-"}`
  );

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "twilio-calls",
        sessions: sessions.size,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/provider-status") {
      sendJson(res, 200, {
        mode: "server-translates-text",
        azure: azureAdapter.getProviderStatus(),
      });
      return;
    }

    if (pathname.startsWith("/api/") && !isAuthorized(req)) {
      unauthorized(res);
      return;
    }

  try {
      if (req.method === "POST" && pathname === "/api/direct-call-session") {
        const payload = await parseJsonBody(req);
        const session = createSession(payload);
        const twilioCall = await createTwilioDirectConversationCall(session);

        session.directLoop.enabled = true;
        session.directLoop.callSid = twilioCall.sid;
        session.directLoop.callStatus = twilioCall.status || "queued";
        session.status = "direct_call_started";

        sendJson(res, 200, {
          ok: true,
          mode: "direct-conversation",
          twilioCall,
          session: serializeSession(session),
        });
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/api/sessions/")) {
        const sessionId = getSessionIdFromPath(pathname);
        const session = sessionId ? sessions.get(sessionId) : null;

        if (!session) {
          notFound(res);
          return;
        }

        if (
          requestUrl.searchParams.get("refreshCall") === "1" &&
          session.directLoop.callSid
        ) {
          try {
            const twilioCall = await fetchTwilioCall(session.directLoop.callSid);
            session.directLoop.callStatus = twilioCall.status;
          } catch (error) {
            session.directLoop.lastError = error.message;
          }
        }

        sendJson(res, 200, { session: serializeSession(session) });
        return;
      }

      if (
        req.method === "POST" &&
        pathname.startsWith("/api/sessions/") &&
        pathname.endsWith("/direct-speak")
      ) {
        const sessionId = getSessionIdFromPath(pathname);
        const session = sessionId ? sessions.get(sessionId) : null;

        if (!session) {
          notFound(res);
          return;
        }

        if (!session.directLoop.callSid) {
          badRequest(res, "Direct call session is not active");
          return;
        }

        if (session.directLoop.inFlight) {
          sendJson(res, 409, {
            ok: false,
            error: "Previous turn is still being processed",
            session: serializeSession(session),
          });
          return;
        }

        const payload = await parseJsonBody(req);
        const sourceText =
          typeof payload.sourceText === "string" ? payload.sourceText.trim() : "";
        const providedTranslatedText =
          typeof payload.translatedText === "string"
            ? payload.translatedText.trim()
            : typeof payload.text === "string"
              ? payload.text.trim()
              : "";
        const waitTimeoutMs = Number(
          payload.waitTimeoutMs || DIRECT_TURN_WAIT_TIMEOUT_MS
        );
        const recordMaxLength = Number(
          payload.recordMaxLength || DIRECT_TURN_RECORD_MAX_LENGTH
        );

        if (!sourceText && !providedTranslatedText) {
          badRequest(res, "sourceText is required");
          return;
        }

        const twilioCall = await fetchTwilioCall(session.directLoop.callSid);
        session.directLoop.callStatus = twilioCall.status;

        if (
          ["completed", "busy", "failed", "no-answer", "canceled"].includes(
            twilioCall.status
          )
        ) {
          sendJson(res, 409, {
            ok: false,
            error: `Call is no longer active: ${twilioCall.status}`,
            session: serializeSession(session),
          });
          return;
        }

        const translatedText =
          providedTranslatedText ||
          (await translateBetweenLocales(
            sourceText,
            session.sourceLanguage,
            session.targetLanguage
          ));

        session.directLoop.inFlight = true;
        session.directLoop.lastError = null;
        session.directLoop.lastAppSourceText = sourceText || translatedText;
        session.directLoop.lastAppTranslatedText = translatedText;
        session.directLoop.lastAppUpdatedAt = new Date().toISOString();

        const updateStartedAt = Date.now();
        await updateTwilioCallTwiml(
          session.directLoop.callSid,
          buildDirectConversationTurnTwiml(
            session.targetLanguage,
            translatedText,
            recordMaxLength
          )
        );
        session.directLoop.lastTwilioUpdateMs = Date.now() - updateStartedAt;

        logEvent(session, "app_turn_sent", {
          sourceText: sourceText || null,
          translatedText,
          twilioUpdateMs: session.directLoop.lastTwilioUpdateMs,
        });

        armDirectConversationRemoteTurn(session, {
          waitTimeoutMs,
          recordMaxLength,
        });

        sendJson(res, 200, {
          ok: true,
          translatedText,
          session: serializeSession(session),
        });
        return;
      }

    notFound(res);
  } catch (error) {
    console.error(
      `[twilio-calls] request_error ${req.method} ${pathname}: ${
        error?.stack || error?.message || error
      }`
    );
    sendJson(res, 500, {
      ok: false,
      error: error.message || "Unexpected server error",
    });
  } finally {
    console.log(
      `[twilio-calls] request_done ${req.method} ${pathname} durationMs=${
        Date.now() - requestStartedAt
      }`
    );
  }
});

  server.listen(PORT, HOST, () => {
    console.log(
      `[twilio-calls] listening on ${HOST}:${PORT} at ${new Date().toISOString()}`
    );
  });

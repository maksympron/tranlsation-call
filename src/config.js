const path = require("path");

function parseNumberEnv(name, fallback) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue === "") {
    return fallback;
  }

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBooleanEnv(name, fallback) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue === "") {
    return fallback;
  }

  return !["0", "false", "no", "off"].includes(
    String(rawValue).toLowerCase()
  );
}

function parseJsonEnv(name, fallback) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue === "") {
    return fallback;
  }

  try {
    return JSON.parse(rawValue);
  } catch (error) {
    return fallback;
  }
}

function normalizeBaseUrl(url) {
  const trimmed = String(url || "").trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.replace(/\/+$/, "");
}

const serviceName = "twilio-calls";

module.exports = {
  serviceName,
  server: {
    port: parseNumberEnv("PORT", parseNumberEnv("TWILIO_CALLS_PORT", 8787)),
    host: process.env.HOST || "0.0.0.0",
    publicBaseUrl: normalizeBaseUrl(
      process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "https://tranlsation-call.onrender.com"
    ),
  },
  auth: {
    appApiToken: process.env.APP_API_TOKEN || "",
  },
  logging: {
    maxEventLog: parseNumberEnv("TWILIO_CALLS_MAX_EVENT_LOG", 100),
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    authToken: process.env.TWILIO_AUTH_TOKEN || "",
    callerId: process.env.TWILIO_CALLER_ID || "",
    ttsVoiceMap: parseJsonEnv("TWILIO_TTS_VOICE_MAP", {}),
  },
  azure: {
    region: process.env.AZURE_REGION || "",
    speechKey: process.env.AZURE_SPEECH_KEY || "",
    translatorKey: process.env.AZURE_TRANSLATOR_KEY || "",
    translatorRegion:
      process.env.AZURE_TRANSLATOR_REGION || process.env.AZURE_REGION || "",
    ttsOutputFormat:
      process.env.AZURE_TTS_OUTPUT_FORMAT ||
      "audio-16khz-32kbitrate-mono-mp3",
    ttsVoiceMap: parseJsonEnv("AZURE_TTS_VOICE_MAP", {}),
  },
  directConversation: {
    turnWaitTimeoutMs: parseNumberEnv(
      "TWILIO_DIRECT_TURN_WAIT_TIMEOUT_MS",
      35000
    ),
    turnRecordMaxLength: parseNumberEnv(
      "TWILIO_DIRECT_TURN_RECORD_MAX_LENGTH",
      20
    ),
    turnRecordTimeout: Math.max(
      parseNumberEnv("TWILIO_DIRECT_TURN_RECORD_TIMEOUT", 0),
      2
    ),
    initialRecordMaxLength: parseNumberEnv(
      "TWILIO_DIRECT_INITIAL_RECORD_MAX_LENGTH",
      30
    ),
    initialRecordTimeout: parseNumberEnv(
      "TWILIO_DIRECT_INITIAL_RECORD_TIMEOUT",
      45
    ),
    recordingPollIntervalMs: parseNumberEnv(
      "TWILIO_DIRECT_RECORDING_POLL_INTERVAL_MS",
      300
    ),
    remoteSttMinRecordingDurationS: parseNumberEnv(
      "TWILIO_REMOTE_STT_MIN_RECORDING_DURATION_S",
      1.1
    ),
    remoteCaptureRetryLimit: parseNumberEnv(
      "TWILIO_REMOTE_CAPTURE_RETRY_LIMIT",
      2
    ),
  },
  tts: {
    usePlay: parseBooleanEnv("TWILIO_TTS_USE_PLAY", true),
    assetDir:
      process.env.TTS_ASSET_DIR || path.resolve("/tmp", "twilio-calls-tts"),
    assetTtlMs: parseNumberEnv("TTS_ASSET_TTL_MS", 6 * 60 * 60 * 1000),
  },
  debug: {
    artifactsDir:
      process.env.TWILIO_CALLS_DEBUG_DIR || "/tmp/twilio-calls-debug",
    saveArtifacts: parseBooleanEnv("TWILIO_CALLS_SAVE_DEBUG_ARTIFACTS", true),
  },
};

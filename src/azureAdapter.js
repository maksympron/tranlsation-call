const config = require("./config");

const DEFAULT_TRANSLATOR_REGION = config.azure.translatorRegion;
const DEFAULT_SPEECH_REGION = config.azure.region;
const SUPPORTED_SPEECH_LOCALES = [
  "uk-UA",
  "ru-RU",
  "en-US",
  "en-GB",
  "fr-FR",
  "fr-BE",
  "fr-CA",
  "fr-CH",
  "it-IT",
  "hi-IN",
  "he-IL",
  "zh-CN",
  "zh-HK",
  "zh-TW",
  "ja-JP",
];
const SUPPORTED_SPEECH_LOCALE_SET = new Set(SUPPORTED_SPEECH_LOCALES);
const DEFAULT_NO_MATCH_RESULT = {
  text: "",
  confidence: 0,
  recognitionStatus: "NoMatch",
  raw: null,
};
const DEFAULT_AZURE_TTS_VOICE_MAP = {
  "uk-UA": "uk-UA-PolinaNeural",
  "ru-RU": "ru-RU-DariyaNeural",
  "en-US": "en-US-JennyNeural",
  "en-GB": "en-GB-SoniaNeural",
  "fr-FR": "fr-FR-DeniseNeural",
  "fr-BE": "fr-BE-CharlineNeural",
  "fr-CA": "fr-CA-SylvieNeural",
  "fr-CH": "fr-CH-ArianeNeural",
  "it-IT": "it-IT-IsabellaNeural",
  "hi-IN": "hi-IN-SwaraNeural",
  "he-IL": "he-IL-HilaNeural",
  "zh-CN": "zh-CN-XiaoxiaoNeural",
  "zh-HK": "zh-HK-HiuGaaiNeural",
  "zh-TW": "zh-TW-HsiaoChenNeural",
  "ja-JP": "ja-JP-NanamiNeural",
};

function resolveTranslatorKey() {
  return config.azure.translatorKey;
}

function resolveSpeechKey() {
  return config.azure.speechKey;
}

function canonicalSpeechLocale(locale) {
  if (!locale) {
    return "en-US";
  }

  const lower = String(locale).toLowerCase();
  if (lower.startsWith("uk")) {
    return "uk-UA";
  }
  if (lower.startsWith("ru")) {
    return "ru-RU";
  }
  if (lower.startsWith("fr-be")) {
    return "fr-BE";
  }
  if (lower.startsWith("fr-ca")) {
    return "fr-CA";
  }
  if (lower.startsWith("fr-ch")) {
    return "fr-CH";
  }
  if (lower.startsWith("fr")) {
    return "fr-FR";
  }
  if (lower.startsWith("it")) {
    return "it-IT";
  }
  if (lower.startsWith("hi")) {
    return "hi-IN";
  }
  if (lower.startsWith("iw") || lower.startsWith("he")) {
    return "he-IL";
  }
  if (lower.startsWith("zh-hk")) {
    return "zh-HK";
  }
  if (lower.startsWith("zh-tw")) {
    return "zh-TW";
  }
  if (lower.startsWith("zh")) {
    return "zh-CN";
  }
  if (lower.startsWith("ja")) {
    return "ja-JP";
  }
  if (lower.startsWith("en-gb")) {
    return "en-GB";
  }
  if (lower.startsWith("en")) {
    return "en-US";
  }

  return locale;
}

function canonicalTranslationLocale(locale) {
  return canonicalSpeechLocale(locale).split("-")[0];
}

function isSupportedSpeechLocale(locale) {
  return SUPPORTED_SPEECH_LOCALE_SET.has(canonicalSpeechLocale(locale));
}

function assertSupportedSpeechLocale(locale, fieldName = "locale") {
  const canonicalLocale = canonicalSpeechLocale(locale);
  if (SUPPORTED_SPEECH_LOCALE_SET.has(canonicalLocale)) {
    return canonicalLocale;
  }

  const error = new Error(
    `Unsupported ${fieldName}: ${locale}. Supported locales: ${SUPPORTED_SPEECH_LOCALES.join(
      ", "
    )}`
  );
  error.statusCode = 400;
  throw error;
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getTtsVoice(locale) {
  const canonicalLocale = assertSupportedSpeechLocale(locale, "ttsLocale");
  const overrideVoice = config.azure.ttsVoiceMap?.[canonicalLocale];
  if (typeof overrideVoice === "string" && overrideVoice.trim()) {
    return overrideVoice.trim();
  }

  return DEFAULT_AZURE_TTS_VOICE_MAP[canonicalLocale] || null;
}

function buildTextToSpeechSsml(text, locale, voiceName) {
  const canonicalLocale = assertSupportedSpeechLocale(locale, "ttsLocale");
  return `<?xml version="1.0" encoding="UTF-8"?><speak version="1.0" xml:lang="${canonicalLocale}"><voice name="${escapeXml(
    voiceName
  )}">${escapeXml(text)}</voice></speak>`;
}

async function translateText(text, fromLocale, toLocale) {
  const key = resolveTranslatorKey();
  if (!key) {
    throw new Error("Azure Translator key is missing");
  }

  const from = canonicalTranslationLocale(
    assertSupportedSpeechLocale(fromLocale, "sourceLanguage")
  );
  const to = canonicalTranslationLocale(
    assertSupportedSpeechLocale(toLocale, "targetLanguage")
  );

  const response = await fetch(
    `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=${encodeURIComponent(
      from
    )}&to=${encodeURIComponent(to)}`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Ocp-Apim-Subscription-Region": DEFAULT_TRANSLATOR_REGION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([{ Text: text }]),
    }
  );

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Azure translate failed with ${response.status}: ${body}`);
  }

  const parsed = JSON.parse(body);
  return parsed?.[0]?.translations?.[0]?.text || "";
}

async function transcribeWavBuffer(wavBuffer, locale, sampleRate = 16000) {
  const speechKey = resolveSpeechKey();
  if (!speechKey) {
    throw new Error("Azure Speech key is missing");
  }

  const speechLocale = assertSupportedSpeechLocale(locale, "speechLocale");
  const response = await fetch(
    `https://${DEFAULT_SPEECH_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(
      speechLocale
    )}&format=detailed&profanity=raw`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": speechKey,
        "Content-Type": `audio/wav; codecs=audio/pcm; samplerate=${sampleRate}`,
        Accept: "application/json;text/xml",
      },
      body: wavBuffer,
    }
  );

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Azure STT failed with ${response.status}: ${body}`);
  }

  const parsed = JSON.parse(body);
  const recognizedText =
    parsed?.DisplayText || parsed?.NBest?.[0]?.Display || "";
  const confidence = Number(
    parsed?.NBest?.[0]?.Confidence ??
      parsed?.NBest?.[0]?.DisplayConfidence ??
      0
  );
  const recognitionStatus = String(parsed?.RecognitionStatus || "Success");

  if (!recognizedText || !String(recognizedText).trim()) {
    return {
      ...DEFAULT_NO_MATCH_RESULT,
      confidence,
      recognitionStatus,
      raw: parsed,
    };
  }

  return {
    text: String(recognizedText).trim(),
    confidence,
    recognitionStatus,
    raw: parsed,
  };
}

async function synthesizeTextToSpeechBuffer(text, locale) {
  const speechKey = resolveSpeechKey();
  if (!speechKey) {
    throw new Error("Azure Speech key is missing");
  }

  const normalizedText = String(text || "").trim();
  if (!normalizedText) {
    throw new Error("Azure TTS text is empty");
  }

  const speechLocale = assertSupportedSpeechLocale(locale, "ttsLocale");
  const voiceName = getTtsVoice(speechLocale);
  if (!voiceName) {
    throw new Error(`Azure TTS voice is not configured for locale ${speechLocale}`);
  }

  const response = await fetch(
    `https://${DEFAULT_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": speechKey,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": config.azure.ttsOutputFormat,
        "User-Agent": "twilio-calls",
      },
      body: buildTextToSpeechSsml(normalizedText, speechLocale, voiceName),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Azure TTS failed with ${response.status}: ${body}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function getProviderStatus() {
  return {
    hasSpeechKey: Boolean(resolveSpeechKey()),
    hasTranslatorKey: Boolean(resolveTranslatorKey()),
    speechRegion: DEFAULT_SPEECH_REGION,
    translatorRegion: DEFAULT_TRANSLATOR_REGION,
    supportedSpeechLocales: SUPPORTED_SPEECH_LOCALES,
    ttsOutputFormat: config.azure.ttsOutputFormat,
  };
}

module.exports = {
  SUPPORTED_SPEECH_LOCALES,
  isSupportedSpeechLocale,
  assertSupportedSpeechLocale,
  canonicalSpeechLocale,
  canonicalTranslationLocale,
  getTtsVoice,
  translateText,
  transcribeWavBuffer,
  synthesizeTextToSpeechBuffer,
  getProviderStatus,
};

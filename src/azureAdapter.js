const { loadEnvFile } = require("./env");

loadEnvFile();

const DEFAULT_TRANSLATOR_REGION = process.env.AZURE_REGION;
const DEFAULT_SPEECH_REGION = process.env.AZURE_REGION;
const DEFAULT_NO_MATCH_RESULT = {
  text: "",
  confidence: 0,
  recognitionStatus: "NoMatch",
  raw: null,
};

function resolveTranslatorKey() {
    return process.env.AZURE_TRANSLATOR_KEY;
}

function resolveSpeechKey() {
  return process.env.AZURE_SPEECH_KEY
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

async function translateText(text, fromLocale, toLocale) {
  const key = resolveTranslatorKey();
  if (!key) {
    throw new Error("Azure Translator key is missing");
  }

  const from = canonicalTranslationLocale(fromLocale);
  const to = canonicalTranslationLocale(toLocale);

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

  const speechLocale = canonicalSpeechLocale(locale);
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

function getProviderStatus() {
  return {
    hasSpeechKey: Boolean(resolveSpeechKey()),
    hasTranslatorKey: Boolean(resolveTranslatorKey()),
    speechRegion: DEFAULT_SPEECH_REGION,
    translatorRegion: DEFAULT_TRANSLATOR_REGION,
  };
}

module.exports = {
  canonicalSpeechLocale,
  canonicalTranslationLocale,
  translateText,
  transcribeWavBuffer,
  getProviderStatus,
};

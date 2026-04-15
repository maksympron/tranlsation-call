const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const DEFAULT_TWILIO_TTS_VOICE_MAP = {
  "en-US": "Polly.Joanna-Generative",
  "fr-FR": "Polly.Mathieu",
};

class DirectConversationService {
  constructor({
    config,
    logger,
    sessionStore,
    twilioService,
    azureAdapter,
    ttsAssetService,
  }) {
    this.config = config;
    this.logger = logger;
    this.sessionStore = sessionStore;
    this.twilioService = twilioService;
    this.azureAdapter = azureAdapter;
    this.ttsAssetService = ttsAssetService;
  }

  escapeXml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  getTwilioSayLanguage(locale) {
    return this.azureAdapter.canonicalSpeechLocale(locale || "en-US") || "en-US";
  }

  getTwilioSayVoice(locale) {
    const canonicalLocale = this.getTwilioSayLanguage(locale);
    const overrideVoice = this.config.twilio.ttsVoiceMap?.[canonicalLocale];
    if (typeof overrideVoice === "string" && overrideVoice.trim()) {
      return overrideVoice.trim();
    }

    return DEFAULT_TWILIO_TTS_VOICE_MAP[canonicalLocale] || null;
  }

  buildSayAttributes(locale) {
    const language = this.getTwilioSayLanguage(locale);
    const voice = this.getTwilioSayVoice(locale);
    const attributes = [`language="${language}"`];

    if (voice) {
      attributes.push(`voice="${this.escapeXml(voice)}"`);
    }

    return attributes.join(" ");
  }

  getLocalizedCallPrompt(locale, type) {
    const canonical = this.getTwilioSayLanguage(locale);
    const prompts = {
      connected: {
        "en-US":
          "Translated call connected. Please wait for the first translated message.",
        "en-GB":
          "Translated call connected. Please wait for the first translated message.",
        "uk-UA":
          "Перекладений дзвінок підключено. Будь ласка, зачекайте на перше перекладене повідомлення.",
        "ru-RU":
          "Переведённый звонок подключён. Пожалуйста, дождитесь первого переведённого сообщения.",
        "fr-FR":
          "L'appel traduit est connecté. Veuillez attendre le premier message traduit.",
        "it-IT":
          "La chiamata tradotta è connessa. Attendi il primo messaggio tradotto.",
        "hi-IN":
          "अनुवादित कॉल कनेक्ट हो गई है। कृपया पहले अनुवादित संदेश की प्रतीक्षा करें।",
        "he-IL": "השיחה המתורגמת חוברה. נא להמתין להודעה המתורגמת הראשונה.",
        "zh-CN": "翻译通话已接通。请等待第一条翻译后的消息。",
        "zh-HK": "翻譯通話已接通。請等待第一條翻譯後的訊息。",
        "zh-TW": "翻譯通話已接通。請等待第一則翻譯後的訊息。",
        "ja-JP": "翻訳通話に接続しました。最初の翻訳メッセージをお待ちください。",
      },
      reprompt: {
        "en-US": "Sorry, please say that again after the tone.",
        "en-GB": "Sorry, please say that again after the tone.",
        "uk-UA": "Будь ласка, скажіть це ще раз після сигналу.",
        "ru-RU": "Пожалуйста, повторите это ещё раз после сигнала.",
        "fr-FR": "Veuillez répéter après le signal sonore.",
        "it-IT": "Per favore, ripeti dopo il segnale acustico.",
        "hi-IN": "कृपया बीप के बाद फिर से बोलें।",
        "he-IL": "נא לומר זאת שוב לאחר הצליל.",
        "zh-CN": "请在提示音后再说一遍。",
        "zh-HK": "請在提示音後再說一遍。",
        "zh-TW": "請在提示音後再說一次。",
        "ja-JP": "発信音の後でもう一度話してください。",
      },
    };

    return prompts[type]?.[canonical] || prompts[type]?.["en-US"] || "";
  }

  async buildSpeechVerb(locale, text, { cacheKeyPrefix = "tts" } = {}) {
    const normalizedText = String(text || "").trim();
    if (!normalizedText) {
      return { twiml: "", mode: "empty", url: null };
    }

    if (this.ttsAssetService?.canUsePlayTts()) {
      try {
        const asset = await this.ttsAssetService.ensureSpeechAsset({
          locale,
          text: normalizedText,
          cacheKeyPrefix,
        });

        if (asset?.url) {
          return {
            twiml: `  <Play>${this.escapeXml(asset.url)}</Play>`,
            mode: "play",
            url: asset.url,
          };
        }
      } catch (error) {
        this.logger.warn("tts_play_fallback", {
          locale: this.getTwilioSayLanguage(locale),
          cacheKeyPrefix,
          error: error.message,
        });
      }
    }

    return {
      twiml: `  <Say ${this.buildSayAttributes(locale)}>${this.escapeXml(
        normalizedText
      )}</Say>`,
      mode: "say",
      url: null,
    };
  }

  async buildWaitTwiml(locale) {
    const connectedPrompt = this.getLocalizedCallPrompt(locale, "connected");
    const speechVerb = await this.buildSpeechVerb(locale, connectedPrompt, {
      cacheKeyPrefix: "connected",
    });

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${speechVerb.twiml}
  <Pause length="600" />
</Response>`;
  }

  async buildTurnTwiml(
    locale,
    translatedText,
    recordMaxLength = this.config.directConversation.turnRecordMaxLength
  ) {
    const speechVerb = await this.buildSpeechVerb(locale, translatedText, {
      cacheKeyPrefix: "turn",
    });

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${speechVerb.twiml}
  <Record playBeep="true" timeout="${
    this.config.directConversation.turnRecordTimeout
  }" maxLength="${recordMaxLength}" trim="do-not-trim" />
  <Pause length="600" />
</Response>`;
  }

  async buildRepromptTwiml(
    locale,
    recordMaxLength = this.config.directConversation.turnRecordMaxLength
  ) {
    const repromptPrompt = this.getLocalizedCallPrompt(locale, "reprompt");
    const speechVerb = await this.buildSpeechVerb(locale, repromptPrompt, {
      cacheKeyPrefix: "reprompt",
    });

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${speechVerb.twiml}
  <Record playBeep="true" timeout="${
    this.config.directConversation.turnRecordTimeout
  }" maxLength="${recordMaxLength}" trim="do-not-trim" />
  <Pause length="600" />
</Response>`;
  }

  resolveTurnCaptureWindowMs(waitTimeoutMs, recordMaxLength) {
    const requestedWindowMs = Number(waitTimeoutMs || 0);
    const captureWindowMs =
      (Number(
        recordMaxLength || this.config.directConversation.turnRecordMaxLength
      ) +
        this.config.directConversation.turnRecordTimeout +
        12) *
      1000;

    return Math.max(
      Number.isFinite(requestedWindowMs) && requestedWindowMs > 0
        ? requestedWindowMs
        : this.config.directConversation.turnWaitTimeoutMs,
      captureWindowMs
    );
  }

  async translateBetweenLocales(sourceText, sourceLocale, targetLocale) {
    const normalizedText = String(sourceText || "").trim();
    if (!normalizedText) {
      return "";
    }

    if (
      this.azureAdapter.canonicalTranslationLocale(sourceLocale) ===
      this.azureAdapter.canonicalTranslationLocale(targetLocale)
    ) {
      return normalizedText;
    }

    return this.azureAdapter.translateText(
      normalizedText,
      sourceLocale,
      targetLocale
    );
  }

  ensureDebugDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  saveDebugArtifact(session, recordingSid, suffix, content, encoding = null) {
    if (!this.config.debug.saveArtifacts) {
      return null;
    }

    const sessionDir = path.join(this.config.debug.artifactsDir, session.id);
    this.ensureDebugDir(sessionDir);
    const filePath = path.join(sessionDir, `${recordingSid}${suffix}`);

    if (encoding) {
      fs.writeFileSync(filePath, content, encoding);
    } else {
      fs.writeFileSync(filePath, content);
    }

    return filePath;
  }

  tokenizeSpeech(text) {
    return String(text || "")
      .replace(/[^\p{L}\p{N}\s'.-]/gu, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  shouldFilterRemoteSpeech({ text, confidence, recordingDurationSeconds }) {
    const normalizedText = String(text || "").trim();
    if (!normalizedText) {
      return { filter: true, reason: "empty_text" };
    }

    const tokens = this.tokenizeSpeech(normalizedText);
    const compact = normalizedText.replace(/[^\p{L}\p{N}]/gu, "");
    const isShortUtterance = tokens.length <= 1 && compact.length <= 6;
    const hasConfidence = Number.isFinite(confidence) && confidence > 0;
    const duration = Number(recordingDurationSeconds || 0);

    if (
      Number.isFinite(duration) &&
      duration > 0 &&
      duration < this.config.directConversation.remoteSttMinRecordingDurationS &&
      !hasConfidence
    ) {
      return {
        filter: true,
        reason: `recording_too_short_${duration}s`,
      };
    }

    if (isShortUtterance && !hasConfidence) {
      return {
        filter: true,
        reason: "short_utterance_no_confidence",
      };
    }

    return { filter: false, reason: "" };
  }

  async startCall(session) {
    const callerId = session.from || this.config.twilio.callerId;

    if (!callerId) {
      throw new Error("Missing TWILIO_CALLER_ID for direct conversation call");
    }

    if (!session.to) {
      throw createHttpError("Session has no destination phone number", 400);
    }

    const startedAt = Date.now();

    try {
      const twilioCall = await this.twilioService.createCall({
        to: session.to,
        from: callerId,
        twiml: await this.buildWaitTwiml(session.targetLanguage),
      });

      session.lastTwilioCall = {
        requestedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        statusCode: 201,
        body: twilioCall,
      };
      session.directLoop.enabled = true;
      session.directLoop.callSid = twilioCall.sid;
      session.directLoop.callStatus = twilioCall.status || "queued";
      session.status = "direct_call_started";

      this.sessionStore.appendEvent(session, "direct_call_requested", {
        statusCode: 201,
        durationMs: session.lastTwilioCall.durationMs,
        sid: twilioCall?.sid || null,
      });

      return twilioCall;
    } catch (error) {
      const details =
        typeof this.twilioService.serializeError === "function"
          ? this.twilioService.serializeError(error?.cause || error)
          : { status: null, code: null, message: error.message };

      session.lastTwilioCall = {
        requestedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        statusCode: details.status,
        body: details,
      };

      this.sessionStore.appendEvent(session, "direct_call_requested", {
        statusCode: details.status,
        durationMs: session.lastTwilioCall.durationMs,
        sid: null,
        error: details.message,
        code: details.code,
      });

      throw error;
    }
  }

  async refreshCallStatus(session) {
    if (!session.directLoop.callSid) {
      return null;
    }

    const twilioCall = await this.twilioService.fetchCall(session.directLoop.callSid);
    session.directLoop.callStatus = twilioCall.status;
    return twilioCall;
  }

  async endCall(session) {
    if (!session?.directLoop?.callSid) {
      session.directLoop.callStatus = "completed";
      session.directLoop.inFlight = false;
      session.directLoop.remoteTurnArmed = false;
      session.directLoop.lastError = null;
      this.sessionStore.appendEvent(session, "call_end_requested", {
        callSid: null,
        result: "no_active_call",
      });
      return null;
    }

    const completedCall = await this.twilioService.completeCall(
      session.directLoop.callSid
    );
    session.directLoop.callStatus = completedCall.status || "completed";
    session.directLoop.inFlight = false;
    session.directLoop.remoteTurnArmed = false;
    session.directLoop.lastError = null;
    session.status = "direct_call_ended";

    this.sessionStore.appendEvent(session, "call_end_requested", {
      callSid: session.directLoop.callSid,
      result: session.directLoop.callStatus,
    });

    return completedCall;
  }

  async waitForNewRecording(callSid, knownRecordingSids = [], timeoutMs) {
    const startedAt = Date.now();
    const knownSet = new Set(knownRecordingSids);

    while (Date.now() - startedAt < timeoutMs) {
      const [call, recordings] = await Promise.all([
        this.twilioService.fetchCall(callSid),
        this.twilioService.listRecordings(callSid),
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

      if (
        ["busy", "failed", "no-answer", "canceled", "completed"].includes(
          call.status
        )
      ) {
        throw new Error(
          `Call ended before a new recording was created. Final status: ${call.status}`
        );
      }

      await new Promise((resolve) =>
        setTimeout(resolve, this.config.directConversation.recordingPollIntervalMs)
      );
    }

    throw new Error("Timed out waiting for a new Twilio recording");
  }

  async runDirectConversationTurn(session, options = {}) {
    const callSid = session.directLoop.callSid;
    if (!callSid) {
      throw new Error("Direct conversation call has not been started");
    }

    const waitTimeoutMs = this.resolveTurnCaptureWindowMs(
      options.waitTimeoutMs || this.config.directConversation.turnWaitTimeoutMs,
      options.recordMaxLength ||
        this.config.directConversation.turnRecordMaxLength
    );
    const recordMaxLength = Number(
      options.recordMaxLength || this.config.directConversation.turnRecordMaxLength
    );
    const startedAt = Date.now();
    let retriesRemaining = this.config.directConversation.remoteCaptureRetryLimit;

    while (Date.now() - startedAt < waitTimeoutMs) {
      const { call, recording } = await this.waitForNewRecording(
        callSid,
        session.directLoop.recordingSids,
        waitTimeoutMs - (Date.now() - startedAt)
      );

      session.directLoop.callStatus = call.status;
      session.directLoop.recordingSids.push(recording.sid);
      const recordingDurationValue = recording.duration || null;
      this.sessionStore.appendEvent(session, "remote_recording_ready", {
        callSid,
        recordingSid: recording.sid,
        recordingDuration: recordingDurationValue,
      });

      const sttStartedAt = Date.now();
      const wavBuffer = await this.twilioService.downloadRecordingWav(recording.sid);
      const wavPath = this.saveDebugArtifact(session, recording.sid, ".wav", wavBuffer);
      const sttResult = await this.azureAdapter.transcribeWavBuffer(
        wavBuffer,
        session.targetLanguage,
        8000
      );
      const sttJsonPath = this.saveDebugArtifact(
        session,
        recording.sid,
        ".stt.json",
        JSON.stringify(sttResult?.raw || {}, null, 2),
        "utf8"
      );
      const sttMs = Date.now() - sttStartedAt;
      const sourceText = sttResult?.text || "";
      const sttConfidence = Number(sttResult?.confidence || 0);
      const recognitionStatus = sttResult?.recognitionStatus || "Unknown";
      const recordingDurationSeconds = Number(recordingDurationValue || 0);

      this.sessionStore.appendEvent(session, "remote_stt_debug", {
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
        this.sessionStore.appendEvent(session, "remote_no_match", {
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
          await this.twilioService.updateCallTwiml(
            callSid,
            await this.buildRepromptTwiml(session.targetLanguage, recordMaxLength)
          );
          this.sessionStore.appendEvent(session, "remote_reprompt_requested", {
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

      const remoteSpeechFilter = this.shouldFilterRemoteSpeech({
        text: sourceText,
        confidence: sttConfidence,
        recordingDurationSeconds,
      });

      if (remoteSpeechFilter.filter) {
        session.directLoop.lastRemoteSttMs = sttMs;
        this.sessionStore.appendEvent(session, "remote_speech_filtered", {
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
          await this.twilioService.updateCallTwiml(
            callSid,
            await this.buildRepromptTwiml(session.targetLanguage, recordMaxLength)
          );
          this.sessionStore.appendEvent(session, "remote_reprompt_requested", {
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

      const translatedText = await this.translateBetweenLocales(
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

      this.sessionStore.appendEvent(session, "remote_turn_recognized", {
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

  armRemoteTurn(session, options = {}) {
    if (!session.directLoop.callSid || session.directLoop.remoteTurnArmed) {
      return false;
    }

    session.directLoop.remoteTurnArmed = true;
    this.runDirectConversationTurn(session, options)
      .catch((error) => {
        session.directLoop.lastError = error.message;
        this.sessionStore.appendEvent(session, "remote_turn_failed", {
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

  async sendAppTurn(session, payload = {}) {
    if (!session.directLoop.callSid) {
      throw createHttpError("Direct call session is not active", 400);
    }

    if (session.directLoop.inFlight) {
      throw createHttpError("Previous turn is still being processed", 409);
    }

    const sourceText =
      typeof payload.sourceText === "string" ? payload.sourceText.trim() : "";
    const providedTranslatedText =
      typeof payload.translatedText === "string"
        ? payload.translatedText.trim()
        : typeof payload.text === "string"
          ? payload.text.trim()
          : "";
    const waitTimeoutMs = Number(
      payload.waitTimeoutMs || this.config.directConversation.turnWaitTimeoutMs
    );
    const recordMaxLength = Number(
      payload.recordMaxLength ||
        this.config.directConversation.turnRecordMaxLength
    );

    if (!sourceText && !providedTranslatedText) {
      throw createHttpError("sourceText is required", 400);
    }

    const twilioCall = await this.twilioService.fetchCall(session.directLoop.callSid);
    session.directLoop.callStatus = twilioCall.status;

    if (
      ["completed", "busy", "failed", "no-answer", "canceled"].includes(
        twilioCall.status
      )
    ) {
      throw createHttpError(`Call is no longer active: ${twilioCall.status}`, 409);
    }

    const translatedText =
      providedTranslatedText ||
      (await this.translateBetweenLocales(
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
    await this.twilioService.updateCallTwiml(
      session.directLoop.callSid,
      await this.buildTurnTwiml(session.targetLanguage, translatedText, recordMaxLength)
    );
    session.directLoop.lastTwilioUpdateMs = Date.now() - updateStartedAt;

    this.sessionStore.appendEvent(session, "app_turn_sent", {
      sourceText: sourceText || null,
      translatedText,
      twilioUpdateMs: session.directLoop.lastTwilioUpdateMs,
    });

    this.armRemoteTurn(session, {
      waitTimeoutMs,
      recordMaxLength,
    });

    return {
      translatedText,
    };
  }
}

module.exports = {
  DirectConversationService,
};

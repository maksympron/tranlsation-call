const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ASSET_NAME_PATTERN = /^[a-z0-9._-]+$/i;

class TtsAssetService {
  constructor({ config, logger, azureAdapter }) {
    this.config = config;
    this.logger = logger;
    this.azureAdapter = azureAdapter;
    this.lastCleanupAt = 0;
  }

  resolvePublicBaseUrl() {
    return String(this.config.server.publicBaseUrl || "")
      .trim()
      .replace(/\/+$/, "");
  }

  canUsePlayTts() {
    return Boolean(
      this.config.tts.usePlay &&
        this.resolvePublicBaseUrl() &&
        this.config.azure.speechKey
    );
  }

  getOutputExtension() {
    const format = String(this.config.azure.ttsOutputFormat || "").toLowerCase();
    if (format.endsWith("mp3")) {
      return ".mp3";
    }
    if (format.includes("ogg")) {
      return ".ogg";
    }
    if (format.includes("riff") || format.includes("wav")) {
      return ".wav";
    }
    return ".bin";
  }

  getContentTypeForFile(fileName) {
    const extension = path.extname(String(fileName || "")).toLowerCase();
    if (extension === ".mp3") {
      return "audio/mpeg";
    }
    if (extension === ".ogg") {
      return "audio/ogg";
    }
    if (extension === ".wav") {
      return "audio/wav";
    }
    return "application/octet-stream";
  }

  ensureAssetDir() {
    fs.mkdirSync(this.config.tts.assetDir, { recursive: true });
  }

  maybeCleanupExpiredAssets() {
    const now = Date.now();
    if (now - this.lastCleanupAt < 15 * 60 * 1000) {
      return;
    }

    this.lastCleanupAt = now;
    this.ensureAssetDir();

    for (const entry of fs.readdirSync(this.config.tts.assetDir, {
      withFileTypes: true,
    })) {
      if (!entry.isFile()) {
        continue;
      }

      const filePath = path.join(this.config.tts.assetDir, entry.name);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > this.config.tts.assetTtlMs) {
          fs.unlinkSync(filePath);
        }
      } catch (error) {
        this.logger.warn("tts_asset_cleanup_failed", {
          filePath,
          error: error.message,
        });
      }
    }
  }

  buildAssetName({ locale, text, voiceName, cacheKeyPrefix = "tts" }) {
    const canonicalLocale = this.azureAdapter.canonicalSpeechLocale(locale || "en-US");
    const hash = crypto
      .createHash("sha1")
      .update(
        JSON.stringify({
          locale: canonicalLocale,
          text,
          voiceName,
          outputFormat: this.config.azure.ttsOutputFormat,
          version: 1,
        })
      )
      .digest("hex");
    const safePrefix = String(cacheKeyPrefix || "tts")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const localeSlug = canonicalLocale.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    return `${safePrefix || "tts"}-${localeSlug}-${hash}${this.getOutputExtension()}`;
  }

  buildPublicUrl(fileName) {
    return `${this.resolvePublicBaseUrl()}/media/tts/${encodeURIComponent(fileName)}`;
  }

  resolveAssetPath(fileName) {
    if (!ASSET_NAME_PATTERN.test(String(fileName || ""))) {
      return null;
    }

    return path.join(this.config.tts.assetDir, fileName);
  }

  async ensureSpeechAsset({ locale, text, cacheKeyPrefix = "tts" }) {
    if (!this.canUsePlayTts()) {
      return null;
    }

    const normalizedText = String(text || "").trim();
    if (!normalizedText) {
      return null;
    }

    const canonicalLocale = this.azureAdapter.canonicalSpeechLocale(locale || "en-US");
    const voiceName = this.azureAdapter.getTtsVoice(canonicalLocale);
    if (!voiceName) {
      return null;
    }

    this.ensureAssetDir();
    this.maybeCleanupExpiredAssets();

    const fileName = this.buildAssetName({
      locale: canonicalLocale,
      text: normalizedText,
      voiceName,
      cacheKeyPrefix,
    });
    const filePath = path.join(this.config.tts.assetDir, fileName);

    if (fs.existsSync(filePath)) {
      return {
        fileName,
        filePath,
        url: this.buildPublicUrl(fileName),
        contentType: this.getContentTypeForFile(fileName),
      };
    }

    const audioBuffer = await this.azureAdapter.synthesizeTextToSpeechBuffer(
      normalizedText,
      canonicalLocale
    );
    const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFilePath, audioBuffer);
    fs.renameSync(tempFilePath, filePath);

    this.logger.info("tts_asset_ready", {
      locale: canonicalLocale,
      fileName,
      bytes: audioBuffer.length,
      publicBaseUrl: this.resolvePublicBaseUrl(),
    });

    return {
      fileName,
      filePath,
      url: this.buildPublicUrl(fileName),
      contentType: this.getContentTypeForFile(fileName),
    };
  }

  getAsset(fileName) {
    const filePath = this.resolveAssetPath(fileName);
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return null;
    }

    return {
      fileName,
      filePath,
      size: stats.size,
      contentType: this.getContentTypeForFile(fileName),
    };
  }
}

module.exports = {
  TtsAssetService,
};

const fs = require("fs");
const http = require("http");
const { URL } = require("url");

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

async function parseJsonBody(req) {
  const rawBody = await readBody(req);
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch (error) {
    const requestError = new Error("Request body must be valid JSON");
    requestError.statusCode = 400;
    throw requestError;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...corsHeaders(),
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function notFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

function unauthorized(res) {
  sendJson(res, 401, { error: "Unauthorized" });
}

function getSessionIdFromPath(pathname) {
  const match = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/.*)?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function getMediaAssetNameFromPath(pathname) {
  const match = pathname.match(/^\/media\/tts\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function normalizeRequestedLanguages(payload, azureAdapter) {
  const normalizedPayload = {
    ...payload,
  };

  normalizedPayload.sourceLanguage = azureAdapter.assertSupportedSpeechLocale(
    payload?.sourceLanguage || "uk-UA",
    "sourceLanguage"
  );
  normalizedPayload.targetLanguage = azureAdapter.assertSupportedSpeechLocale(
    payload?.targetLanguage || "en-US",
    "targetLanguage"
  );

  return normalizedPayload;
}

function createServer({
  config,
  logger,
  sessionStore,
  directConversationService,
  azureAdapter,
  ttsAssetService,
}) {
  function isAuthorized(req) {
    if (!config.auth.appApiToken) {
      return true;
    }

    const authHeader = String(req.headers.authorization || "");
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";
    const apiKey = String(req.headers["x-api-key"] || "").trim();

    return (
      bearerToken === config.auth.appApiToken ||
      apiKey === config.auth.appApiToken
    );
  }

  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = requestUrl.pathname;
    const requestStartedAt = Date.now();

    logger.info("request", {
      method: req.method,
      pathname,
      host: req.headers.host || "-",
    });

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: config.serviceName,
        sessions: sessionStore.count(),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/provider-status") {
      sendJson(res, 200, {
        mode: "server-translates-text",
        azure: azureAdapter.getProviderStatus(),
        playback: {
          usesPlay: ttsAssetService.canUsePlayTts(),
          publicBaseUrl: config.server.publicBaseUrl || null,
        },
      });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/media/tts/")) {
      const assetName = getMediaAssetNameFromPath(pathname);
      const asset = assetName ? ttsAssetService.getAsset(assetName) : null;

      if (!asset) {
        notFound(res);
        return;
      }

      res.writeHead(200, {
        "Content-Type": asset.contentType,
        "Content-Length": asset.size,
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      fs.createReadStream(asset.filePath).pipe(res);
      return;
    }

    if (pathname.startsWith("/api/") && !isAuthorized(req)) {
      unauthorized(res);
      return;
    }

    try {
      if (req.method === "POST" && pathname === "/api/direct-call-session") {
        const rawPayload = await parseJsonBody(req);
        const payload = normalizeRequestedLanguages(rawPayload, azureAdapter);
        const session = sessionStore.create(payload);
        const twilioCall = await directConversationService.startCall(session);

        sendJson(res, 200, {
          ok: true,
          mode: "direct-conversation",
          twilioCall,
          session: sessionStore.serialize(session),
        });
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/api/sessions/")) {
        const sessionId = getSessionIdFromPath(pathname);
        const session = sessionId ? sessionStore.get(sessionId) : null;

        if (!session) {
          notFound(res);
          return;
        }

        if (
          requestUrl.searchParams.get("refreshCall") === "1" &&
          session.directLoop.callSid
        ) {
          try {
            await directConversationService.refreshCallStatus(session);
          } catch (error) {
            session.directLoop.lastError = error.message;
          }
        }

        sendJson(res, 200, { session: sessionStore.serialize(session) });
        return;
      }

      if (
        req.method === "POST" &&
        pathname.startsWith("/api/sessions/") &&
        pathname.endsWith("/direct-speak")
      ) {
        const sessionId = getSessionIdFromPath(pathname);
        const session = sessionId ? sessionStore.get(sessionId) : null;

        if (!session) {
          notFound(res);
          return;
        }

        const payload = await parseJsonBody(req);
        const result = await directConversationService.sendAppTurn(
          session,
          payload
        );

        sendJson(res, 200, {
          ok: true,
          translatedText: result.translatedText,
          session: sessionStore.serialize(session),
        });
        return;
      }

      if (
        req.method === "POST" &&
        pathname.startsWith("/api/sessions/") &&
        pathname.endsWith("/end-call")
      ) {
        const sessionId = getSessionIdFromPath(pathname);
        const session = sessionId ? sessionStore.get(sessionId) : null;

        if (!session) {
          notFound(res);
          return;
        }

        await directConversationService.endCall(session);
        sendJson(res, 200, {
          ok: true,
          session: sessionStore.serialize(session),
        });
        return;
      }

      notFound(res);
    } catch (error) {
      const statusCode = Number(error?.statusCode || 0) || 500;
      logger.error("request_error", {
        method: req.method,
        pathname,
        statusCode,
        error: error?.stack || error?.message || String(error),
      });
      sendJson(res, statusCode, {
        ok: false,
        error: error.message || "Unexpected server error",
      });
    } finally {
      logger.info("request_done", {
        method: req.method,
        pathname,
        durationMs: Date.now() - requestStartedAt,
      });
    }
  });
}

module.exports = {
  createServer,
};

const config = require("./config");

function serializeMeta(meta) {
  if (!meta || Object.keys(meta).length === 0) {
    return "";
  }

  try {
    return ` ${JSON.stringify(meta)}`;
  } catch (error) {
    return "";
  }
}

function write(level, event, meta = {}) {
  const message = `[${config.serviceName}] ${event}${serializeMeta(meta)}`;
  const writer =
    level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  writer(message);
}

module.exports = {
  info(event, meta) {
    write("info", event, meta);
  },
  warn(event, meta) {
    write("warn", event, meta);
  },
  error(event, meta) {
    write("error", event, meta);
  },
  sessionEvent(sessionId, type, details = {}) {
    write("info", `event ${type}`, {
      sessionId,
      ...details,
    });
  },
};

const fs = require("fs");
const path = require("path");

let loaded = false;

function normalizeEnvValue(rawValue) {
  const trimmed = String(rawValue || "").trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t");
  }

  return trimmed;
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = {};

  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      return;
    }

    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = normalizeEnvValue(trimmed.slice(index + 1));

    if (key) {
      parsed[key] = value;
    }
  });

  return parsed;
}

function applyParsedEnv(parsedEnv, initialEnvKeys, { overrideLoadedValues = false } = {}) {
  Object.entries(parsedEnv).forEach(([key, value]) => {
    if (initialEnvKeys.has(key)) {
      return;
    }

    if (!overrideLoadedValues && process.env[key] != null) {
      return;
    }

    process.env[key] = value;
  });
}

function loadEnvFile() {
  if (loaded) {
    return;
  }

  const initialEnvKeys = new Set(Object.keys(process.env));
  const envPath = path.resolve(__dirname, "../.env");
  const envLocalPath = path.resolve(__dirname, "../.env.local");

  applyParsedEnv(parseEnvFile(envPath), initialEnvKeys);
  applyParsedEnv(parseEnvFile(envLocalPath), initialEnvKeys, {
    overrideLoadedValues: true,
  });

  loaded = true;
}

module.exports = {
  loadEnvFile,
};

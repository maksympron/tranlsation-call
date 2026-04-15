const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({
  path: path.resolve(process.cwd(), ".env.local"),
  override: true,
});

const config = require("./config");
const logger = require("./logger");
const azureAdapter = require("./azureAdapter");
const { createServer } = require("./createServer");
const { InMemorySessionStore } = require("./stores/sessionStore");
const { TwilioService } = require("./services/twilioService");
const { TtsAssetService } = require("./services/ttsAssetService");
const {
  DirectConversationService,
} = require("./services/directConversationService");

const sessionStore = new InMemorySessionStore({
  defaultCallerId: config.twilio.callerId,
  maxEventLog: config.logging.maxEventLog,
  logger,
});

const twilioService = new TwilioService({
  accountSid: config.twilio.accountSid,
  authToken: config.twilio.authToken,
});

const ttsAssetService = new TtsAssetService({
  config,
  logger,
  azureAdapter,
});

const directConversationService = new DirectConversationService({
  config,
  logger,
  sessionStore,
  twilioService,
  azureAdapter,
  ttsAssetService,
});

const server = createServer({
  config,
  logger,
  sessionStore,
  directConversationService,
  azureAdapter,
  ttsAssetService,
});

server.listen(config.server.port, config.server.host, () => {
  logger.info("listening", {
    host: config.server.host,
    port: config.server.port,
    publicBaseUrl: config.server.publicBaseUrl || null,
    startedAt: new Date().toISOString(),
  });
});

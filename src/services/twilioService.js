const twilio = require("twilio");

function createTwilioError(message, error) {
  const wrapped = new Error(message);
  wrapped.cause = error;
  return wrapped;
}

class TwilioService {
  constructor({ accountSid, authToken }) {
    this.accountSid = accountSid;
    this.authToken = authToken;
    this.client = null;
  }

  ensureCredentials() {
    if (!this.accountSid || !this.authToken) {
      throw new Error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");
    }
  }

  getBasicAuthHeader() {
    this.ensureCredentials();
    return `Basic ${Buffer.from(
      `${this.accountSid}:${this.authToken}`
    ).toString("base64")}`;
  }

  getClient() {
    if (this.client) {
      return this.client;
    }

    this.ensureCredentials();
    this.client = twilio(this.accountSid, this.authToken);
    return this.client;
  }

  serializeError(error) {
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

  async createCall({ to, from, twiml }) {
    try {
      return await this.getClient().calls.create({
        to,
        from,
        twiml,
      });
    } catch (error) {
      const details = this.serializeError(error);
      throw createTwilioError(
        `Twilio call create failed${
          details.status ? ` (${details.status})` : ""
        }: ${details.message}`,
        error
      );
    }
  }

  async fetchCall(callSid) {
    try {
      return await this.getClient().calls(callSid).fetch();
    } catch (error) {
      const details = this.serializeError(error);
      throw createTwilioError(
        `Failed to fetch Twilio call ${callSid}${
          details.status ? ` (${details.status})` : ""
        }: ${details.message}`,
        error
      );
    }
  }

  async listRecordings(callSid, limit = 20) {
    try {
      return await this.getClient().recordings.list({
        callSid,
        limit,
      });
    } catch (error) {
      const details = this.serializeError(error);
      throw createTwilioError(
        `Failed to list Twilio recordings for ${callSid}${
          details.status ? ` (${details.status})` : ""
        }: ${details.message}`,
        error
      );
    }
  }

  async updateCallTwiml(callSid, twiml) {
    try {
      return await this.getClient().calls(callSid).update({ twiml });
    } catch (error) {
      const details = this.serializeError(error);
      throw createTwilioError(
        `Failed to update Twilio call ${callSid}${
          details.status ? ` (${details.status})` : ""
        }: ${details.message}`,
        error
      );
    }
  }

  async completeCall(callSid) {
    try {
      return await this.getClient().calls(callSid).update({ status: "completed" });
    } catch (error) {
      const details = this.serializeError(error);
      throw createTwilioError(
        `Failed to complete Twilio call ${callSid}${
          details.status ? ` (${details.status})` : ""
        }: ${details.message}`,
        error
      );
    }
  }

  async downloadRecordingWav(recordingSid) {
    this.ensureCredentials();
    const wavUrl = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Recordings/${recordingSid}.wav`;
    const response = await fetch(wavUrl, {
      headers: {
        Authorization: this.getBasicAuthHeader(),
      },
    });

    const arrayBuffer = await response.arrayBuffer();
    if (!response.ok) {
      throw new Error(
        `Failed to download Twilio recording ${recordingSid} with ${
          response.status
        }: ${Buffer.from(arrayBuffer).toString("utf8")}`
      );
    }

    return Buffer.from(arrayBuffer);
  }
}

module.exports = {
  TwilioService,
};

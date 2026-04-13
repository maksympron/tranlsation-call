# twilio-calls

Minimal backend for a turn-based translated PSTN call POC.

This service keeps the call logic on the backend:

- the mobile app does local microphone capture, local STT, and app-side TTS playback
- this backend controls the `Twilio` PSTN call
- this backend translates app text on the server
- this backend says the translated text into the phone call
- this backend downloads the phone-side recording from `Twilio`
- this backend runs `Azure STT`
- this backend translates the recognized phone reply back to the app language
- the app polls session state and plays back the already translated reply

This is not a full real-time duplex interpreter. It is:

`text-in -> translated-PSTN out -> recording-in -> translated-text-out`

## Endpoints

- `GET /health`
- `GET /provider-status`
- `POST /api/direct-call-session`
- `GET /api/sessions/:id`
- `POST /api/sessions/:id/direct-speak`

## Request Flow

1. App starts a session with `POST /api/direct-call-session`.
2. Backend creates an outbound `Twilio` PSTN call with inline `TwiML`.
3. App recognizes speech locally.
4. App sends `sourceText` with `POST /api/sessions/:id/direct-speak`.
5. Backend updates the active `Twilio` call with new inline `TwiML`:
   it translates the text, says the translated text to the callee, and records their answer.
6. Backend polls `Twilio` recordings, downloads the new recording, runs `Azure STT`, translates the recognized phone-side text, and stores both texts in session state.
7. App polls `GET /api/sessions/:id` and plays back the already translated reply.

## Run

```sh
cp .env.example .env
npm install
npm start
```

Environment variables are loaded with `dotenv` from:

1. `.env`
2. `.env.local` with override enabled

## Example

Start a call:

```sh
curl -X POST http://localhost:8787/api/direct-call-session \
  -H 'Content-Type: application/json' \
  -d '{
    "to": "+15551234567",
    "sourceLanguage": "uk-UA",
    "targetLanguage": "en-US",
    "notes": "poc"
  }'
```

Send a phrase into the live call:

```sh
curl -X POST http://localhost:8787/api/sessions/<session-id>/direct-speak \
  -H 'Content-Type: application/json' \
  -d '{
    "sourceText": "Привіт, як справи?"
  }'
```

Fetch session state:

```sh
curl http://localhost:8787/api/sessions/<session-id>
```

## Limitations

- session storage is in-memory
- no horizontal scaling
- no Twilio webhook signature validation yet
- no server-side app audio streaming
- PSTN side is turn-based because it uses `Twilio <Record>`
- Twilio `<Say>` support depends on target language availability
# tranlsation-call

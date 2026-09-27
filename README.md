# Slideo

Slideo is a presenter workspace for HTML and PowerPoint decks with slide-linked audience polls. The audience route is opened from a share link and supports anonymous multiple-choice votes, optional correct answers, live results, and waiting for connected attendees before revealing results.

## Run locally

```sh
npm.cmd install
npm.cmd run dev
```

Without Firebase, the app runs in local demo mode. The demo share link works in the same browser profile; it is not cross-device storage.

## Connect Firebase

1. Create a Firebase project and register a web app.
2. Enable Realtime Database, Cloud Storage, and Authentication in that project.
3. Put the web app values in `.env` using the keys shown in `.env.example`, including the Realtime Database URL and Storage bucket. Restart Vite after changing `.env`.
4. In Firebase Authentication, enable the Email/Password and Google sign-in providers. Add the deployed app domain to Authentication's authorized domains.
5. Configure Realtime Database and Storage rules before starting a session.

Email/password and Google are used for presenter sign-in; room-code audience links do not require a presenter account. Presenter drafts are autosaved under `presenterDrafts/{uid}` and restored at sign-in, so slide questions and uploaded decks can be continued on another device. PPT/PPTX files are base64-encoded in the browser and stored separately under `presenterDecks/{uid}/{deckId}` in Realtime Database; sessions keep only a path reference. The audience can download these files. HTML decks remain in Cloud Storage. Sessions and poll responses are stored under `sessions/{sessionId}` in Realtime Database; room codes map through `roomCodes/{code}`. Audience links contain only the room code. Viewers can also open **Join a room** and enter that code manually. The app validates a code before subscribing to a session.

Room codes are an app-level access gate, not Firebase Authentication credentials. The app uses Firebase Authentication for presenter sign-in but does not include owner-scoped database rules. Do not use broad public read/write rules with real presentation or audience data. Add rules that limit session editing, deck access, and vote writes before deploying it for production use.

HTML uploads preview in the presenter workspace. PowerPoint files are offered as downloads because Realtime Database does not provide the public file URL required by Microsoft's Office web viewer. HTML uploads still use Cloud Storage and may require a bucket CORS policy for the app's origin.

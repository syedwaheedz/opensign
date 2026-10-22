# Project
OpenSign: open-source digital signage (MagicINFO alternative). `server/` is a Node.js (ES modules) Express CMS + web admin;
`player/` is a native Kotlin Android TV app (Media3/ExoPlayer, OkHttp, Coil). End-user docs: @GETTING-STARTED.md, @README.md.

# Commands
```bash
cd server && npm install && npm start          # http://localhost:3000 (env: PORT, DATA_DIR, ADMIN_PASSWORD, PUBLIC_URL)
PORT=3055 DATA_DIR=$TMPDIR/os node server/index.js   # throwaway instance for manual/API checks
node --check server/index.js                    # server syntax check (also run by CI)
cd server && npm test                           # server tests (node:test, no extra deps; also run by CI)
cd server && node --test --test-name-pattern="video wall"   # run a single test by name
cd player && gradle :app:compileDebugKotlin     # Android compile check (CI only, see Gotchas)
cd player && gradle assembleRelease             # signed APK (CI only, after merge)
docker compose up -d                            # server in Docker (host networking)
```
There is no linter or formatter. Android has no tests. Server tests live in `server/test/` and start a throwaway server on a random port.

# Architecture
- Server is one file (`server/index.js`) with a JSON store (`DATA_DIR/db.json`, atomic write). Proof-of-play goes to append-only `plays.ndjson`.
- Players cache the whole config and resolve schedules/walls locally; the server only sends `buildConfig()` output plus `serverTime`.
- Instant push: players long-poll `/api/player/:id/wait`. Any change affecting a config must call `bumpAll()` or `notifyDevice()`.
- Player endpoints are unauthenticated (`deviceId` is the credential); admin endpoints use in-memory bearer tokens.
- YouTube/Instagram/Facebook links and widgets (text/ticker/clock) are server-rendered pages at `/embed/:id`, loaded in the player's WebView.
- Video wall: an enabled wall overrides member screens' playlist/schedule; screens sync via the server clock (`clockOffset`), not a handshake.
- Player logic lives in `MainActivity` as coroutine loops (sync, heartbeat, alert, playback). Last config is cached in `Prefs` for offline start.
- Admin UI is `server/public/index.html` plus tab scripts (`products.js`): no build step, re-rendering API data into `innerHTML`.
- Catalog rules live in `server/catalog.js` (verification, offers, warnings, `posterData`). Posters must read product data only through `posterData`, never raw products. `server/importer.js` only fetches/parses; `catalog-routes.js` saves.

# Code style
- Server: 2-space indent, single quotes, semicolons, compact one-line handlers; comments explain why, not what.
- Admin UI: handlers are global functions called from inline `onclick`; every user-supplied string must go through `esc()`.
- Kotlin: official style; use `org.json`, not a serialization library. Rethrow `CancellationException` in coroutine `catch` blocks.
- Dependencies must stay minimal (server: only `express`, `multer`). A new dependency must have a clear justification.
- Features must stay beginner-friendly: no new mandatory configuration or manual setup steps for end users.

# Workflow
- Before saying a change is done, `node --check server/index.js` and `cd server && npm test` must pass for server changes. Add a test for each new server endpoint.
- Android changes must pass the CI `checks` job (compile). You must say plainly that nothing was run on a device.
- Server behaviour changes must be exercised against a throwaway instance (`DATA_DIR`/`PORT` set), never `server/data`.

# Git
- Branch from `main`; short kebab-case topic names (`fix-discovery`, `ci-checks-only`). No type prefix.
- Commit and PR title: one imperative sentence, no prefix. Squash merge adds `(#N)`.
- Every change must go through a PR into `main`. Share the PR link in your summary.
- Open PRs run checks only (server syntax + Android compile). The signed APK is built and released only after merge.
- You may merge your own PR once CI is green.

# Do not
- IMPORTANT: never read, print, regenerate or change the signing key or secrets (`~/.opensign-signing/`, `KEYSTORE_*`, `KEY_*` repo secrets).
- Do not paste `${{ github.event.* }}` (PR titles, branch names) into workflow `run:` scripts. Pass them through `env:`.
- Do not add a default or hard-coded admin password; first-run setup chooses it.
- Do not rename or change the `setupRequired` field of `/api/auth/status` or the UDP discovery protocol (see Gotchas).

# Gotchas
- IMPORTANT: no JDK or Android SDK on the dev machine. Kotlin and Gradle changes are compiled only by CI, so write them carefully.
- TV auto-discovery uses UDP broadcast on port 41234, then probes `10.0.2.2:3000` (emulators/BlueStacks) and sweeps the local /24 for `/api/auth/status` containing `setupRequired`.
- No Gradle wrapper jar is committed; CI uses Gradle 8.7 via `gradle/actions/setup-gradle`.
- `versionCode` comes from `BUILD_NUMBER` (CI run number); local builds get 1. Release tags are `v0.1.<run number>`.
- `ADMIN_PASSWORD` env overrides the stored password. Admin tokens are in memory, so a server restart signs everyone out.
- Cleartext HTTP is intentional (LAN servers); the manifest sets `usesCleartextTraffic`.
- Android 10+ may block auto-start on boot unless "Display over other apps" is granted.

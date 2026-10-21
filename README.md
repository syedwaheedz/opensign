# OpenSign

> New here? Read **[GETTING-STARTED.md](GETTING-STARTED.md)** for the no-tech walkthrough.

Open-source digital signage in the spirit of Samsung MagicINFO.

- `server/` – Node.js CMS + web admin: media library (images, video, web pages), playlists, per-screen weekly schedules, device pairing, online status.
- `player/` – native Android TV app (Kotlin, Media3/ExoPlayer). Installs as an APK, appears in the TV launcher, caches media for offline playback, auto-starts on boot.

## 1. Run the server
```
cd server && npm install
ADMIN_PASSWORD=choose-one npm start      # http://<server-ip>:3000
```
Double-click `start.bat` / `start.command`, or use `docker compose up -d`. The first visitor to the admin chooses the password. Optional env: `PORT`, `ADMIN_PASSWORD` (overrides the stored password), `DATA_DIR`, `PUBLIC_URL` (set if behind a proxy).
TV players discover the server automatically via UDP broadcast on port 41234 (same network required).

## 2. Build and install the TV app
Open `player/` in Android Studio (JDK 17), let it sync, then **Build > Build APK(s)**
(or `gradle wrapper && ./gradlew assembleDebug`). APK: `player/app/build/outputs/apk/debug/app-debug.apk`.

Install on a TV / box:
```
adb connect <tv-ip>:5555
adb install -r app-debug.apk
```
Or copy the APK to a USB stick and open it with a file manager on the TV.

## 3. Pair a screen
1. Launch **OpenSign Player**. It finds the server on its own (or press Menu to type the address).
2. The TV appears under **Screens** in the admin: click **Add this screen** and name it.
3. Upload media or paste YouTube / Instagram / Facebook / image / video / web links, build a playlist, assign it as the screen's default and/or schedule slots by day and time.

Hold **OK** or press **Menu** on the remote to change the server address.

## Video walls
Admin > **Video walls** joins several screens into one big display. Create a wall, choose a grid (e.g. 2 x 2), a playlist, and assign a screen to each tile. The **On/Off toggle** enables it; switching it off returns every screen to its own playlist and schedule.
Screens stay in step by deriving the current item from the server clock, so give every item (videos too) a duration. Mount the TVs in the same order as the grid.

## Compared with Samsung MagicINFO and JioSignage
| | OpenSign | MagicINFO | JioSignage |
|---|---|---|---|
| Cost / licence | Free, open source | Paid licences and add-ons | Paid, vendor hardware options |
| Screens supported | Any Android TV / box / stick | Samsung displays | Any screen via Jio players |
| Setup | Double-click server, TV auto-finds it, one-click add | Server install + licensing | Cloud account + device setup |
| Images, video, web pages | yes | yes | yes |
| YouTube / Instagram / Facebook links | **yes** | web author only | no |
| Text, ticker and clock widgets (no design tool) | **yes** | via Author app | via layouts |
| Video wall (many screens as one, on/off toggle) | **yes** | yes | partial |
| Scheduling by day and time, offline playback | yes | yes | yes |
| Instant push (changes reach screens in seconds) | **yes** | yes | yes |
| Emergency alert to all or chosen screens | **yes** | no | yes |
| Proof-of-play report + CSV export | **yes (free)** | paid add-on (Insight) | audit reports |
| Self-hosted, your data stays with you | **yes** | on-prem edition | cloud |
| Multi-zone layouts, user roles, audience analytics, 8K, hardware remote control | **not yet** | yes | yes |

We are not claiming parity everywhere: the last row is the roadmap. Where OpenSign wins today is cost, openness, hardware choice, beginner setup and the features marked bold.

## Notes
- Schedules are evaluated on the TV, so they keep working offline. The player re-syncs every 60 s.
- Auto-start on boot: Android 10+ restricts background activity launches, so some devices need "Display over other apps" granted, or the app set as the home/launcher app.
- The server uses plain HTTP and a single admin password; put it behind a reverse proxy with HTTPS before exposing it to the internet.

## Releases (CI)
Open pull requests only run checks (server syntax check + Android compile; no APK is built). When a pull request is merged into `main`, `.github/workflows/release-apk.yml` builds a signed release APK and publishes it as a GitHub Release.
Set these repository secrets for a production-signed APK (otherwise it falls back to the debug key and the workflow warns):
`KEYSTORE_BASE64` (`base64 -i release.jks`), `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.
Create a keystore with: `keytool -genkeypair -v -keystore release.jks -alias opensign -keyalg RSA -keysize 2048 -validity 10000`

## Status
Open PRs run checks only; a signed APK is built and released after merge.

# OpenSign

Open-source digital signage in the spirit of Samsung MagicINFO.

- `server/` – Node.js CMS + web admin: media library (images, video, web pages), playlists, per-screen weekly schedules, device pairing, online status.
- `player/` – native Android TV app (Kotlin, Media3/ExoPlayer). Installs as an APK, appears in the TV launcher, caches media for offline playback, auto-starts on boot.

## 1. Run the server
```
cd server && npm install
ADMIN_PASSWORD=choose-one npm start      # http://<server-ip>:3000
```
Env: `PORT`, `ADMIN_PASSWORD` (default `admin`), `DATA_DIR`, `PUBLIC_URL` (set if behind a proxy).

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
1. Launch **OpenSign Player**, enter the server address (e.g. `http://192.168.1.10:3000`).
2. The TV shows a 6-digit code. In the admin, **Screens > Add**, enter the code and a name.
3. Upload media, build a playlist, assign it as the screen's default and/or schedule slots by day and time.

Hold **OK** or press **Menu** on the remote to change the server address.

## Notes
- Schedules are evaluated on the TV, so they keep working offline. The player re-syncs every 60 s.
- Auto-start on boot: Android 10+ restricts background activity launches, so some devices need "Display over other apps" granted, or the app set as the home/launcher app.
- The server uses plain HTTP and a single admin password; put it behind a reverse proxy with HTTPS before exposing it to the internet.

## Releases (CI)
When a pull request is merged into `main`, `.github/workflows/release-apk.yml` builds a signed release APK and publishes it as a GitHub Release.
Set these repository secrets for a production-signed APK (otherwise it falls back to the debug key and the workflow warns):
`KEYSTORE_BASE64` (`base64 -i release.jks`), `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.
Create a keystore with: `keytool -genkeypair -v -keystore release.jks -alias opensign -keyalg RSA -keysize 2048 -validity 10000`

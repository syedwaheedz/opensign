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
On-screen buttons (Next, Refresh, Server settings) appear when you move the mouse, touch the screen or press any remote key, and hide again after 4 seconds.

## Layouts (collage / multi-zone)
Admin > **Layouts** splits one screen into zones, each playing its own playlist: video in the centre with a ticker along the bottom, an ad on the left or right, four quarters, and so on. Start from a preset, then adjust each zone's position and size (percent of the screen) and pick its playlist. Choose the layout as a screen's **Default content** or in a schedule slot (Screens tab). Put a ticker or clock widget in a thin zone and it scales to fit. Tip: use one video zone where possible, since TVs have limited video decoders.

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

## Branding
The admin is branded for myT Mobiles (logo at `server/public/brand/myt-logo.png`, brand pink `#F23088` on black/charcoal). Technical names stay `OpenSign` (package, Android app id, discovery protocol). To use another logo, replace that PNG (a PNG with a black background blends best).

## Smartphone catalog (Products tab)
Staff keep one record per phone: brand, model, variants (RAM / storage / colour), **official price (MRP)** and **myT Mobiles selling price** kept separate, key specifications, images, offers, stock, source URL and last verified date.
- **Import from store website** reads the smartphones from the myT Mobiles online store and saves them as **Draft**, with all their images and the source URL. Run it again to refresh: unchanged products are skipped, and products the store changed go back to Draft with a warning.
- **Verify:** only a verified product (within `PRODUCT_STALE_DAYS`, default 30) shows prices, stock and offers on posters. Editing the brand, model, variants, specs or highlights of a verified product returns it to Draft.
- **Offers** (discount, bank, exchange, other) are separate from prices and never subtracted from them. An offer shows only when it is **approved** and **not expired**. Bank and exchange offers need written conditions.
- **Warnings** list missing images, prices, source, specs, outdated verification and expired offers.

Settings (environment variables): `IMPORT_ALLOWED_HOSTS` (default `storetmobiles2-code.github.io`; the import only reads from these hosts), `PRODUCT_STALE_DAYS` (default 30).
Note: the store site's `robots.txt` disallows crawlers. The importer reads only the allowed owner site, one page at a time with a pause, on demand, and never from the TV player.

## Posters (Posters tab)
Staff pick a phone, choose a template (premium flagship, camera, gaming, price and offer, new launch, store brand) and a size (1920 × 1080, 1080 × 1350, 1080 × 1080, A4, A3), preview, **approve**, then export PNG / JPEG / PDF or add the poster to the media library and a playlist. Posters are drawn in the admin page (browser canvas); the TV player only shows normal images. A poster that was published but whose product, price or offers later change is removed from playlists automatically. Full staff guide, upgrade steps, test results and limitations: **[docs/MYT-MOBILES.md](docs/MYT-MOBILES.md)**.

## Tests
`cd server && npm test` runs the server regression tests. CI runs them on every pull request.

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

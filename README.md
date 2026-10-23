# OpenSign

> New here? Read **[GETTING-STARTED.md](GETTING-STARTED.md)** for the no-tech walkthrough.

Open-source digital signage in the spirit of Samsung MagicINFO. **One server can serve many stores**: each store sees only its own screens, media, playlists and data (see **[docs/PLATFORM.md](docs/PLATFORM.md)**).

- `server/` – Node.js CMS + web admin: media library (images, video, web pages), playlists, per-screen weekly schedules, device pairing, online status.
- `player/` – native Android TV app (Kotlin, Media3/ExoPlayer). Installs as an APK, appears in the TV launcher, caches media for offline playback, auto-starts on boot.

## 1. Run the server
```
cd server && npm install && npm start      # http://<server-ip>:3000
```
Double-click `start.bat` / `start.command`, or use `docker compose up -d`. The first visitor creates the **platform administrator**, who then creates a store (tick *This is my own store* if you run just one). Store owners sign in with their own login, add staff under **Team**, and set their name, colour and logo under **Settings**. Settings (environment variables) are listed in `docs/PLATFORM.md`.
TV players discover the server automatically via UDP broadcast on port 41234 (same network required; set `DISCOVERY_PORT=0` for a public server).

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
2. In the admin, open **Screens** and type the 6-digit code shown on the TV (with a single store the TV also appears in the list: click **Add this screen**).
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
Each store has its own name, accent colour and logo (**Settings**). They appear in that store's admin and on its posters, and nowhere else. The login page and technical names (`OpenSign` package, Android app id, discovery protocol) are neutral.

## Smartphone catalog (Products tab, switched on per store)
The platform administrator switches **Phone catalog and posters** on for a store. Each store keeps only its own products and posters.
Staff keep one record per phone: brand, model, variants (RAM / storage / colour), **official price (MRP)** and **selling price** kept separate, key specifications, images, offers, stock, source URL and last verified date.
- **Import from store website** reads the smartphones from the store's own website (the address the platform administrator set for the store) and saves them as **Draft**, with all their images and the source URL. Run it again to refresh: unchanged products are skipped, and products the store changed go back to Draft with a warning.
- **Verify:** only a verified product (within `PRODUCT_STALE_DAYS`, default 30) shows prices, stock and offers on posters. Editing the brand, model, variants, specs or highlights of a verified product returns it to Draft.
- **Offers** (discount, bank, exchange, other) are separate from prices and never subtracted from them. An offer shows only when it is **approved** and **not expired**. Bank and exchange offers need written conditions.
- **Warnings** list missing images, prices, source, specs, outdated verification and expired offers.

Setting: `PRODUCT_STALE_DAYS` (default 30). The import address is set per store by the platform administrator.
Note: some shop sites disallow crawlers in `robots.txt`. The import reads only the address the platform administrator configured for the store, one page at a time with a pause, when a store user clicks the button, and never from the TV player.

## Posters (Posters tab)
Staff pick a phone, choose a template (premium flagship, camera, gaming, price and offer, new launch, store brand) and a size (1920 × 1080, 1080 × 1350, 1080 × 1080, A4, A3), preview, **approve**, then export PNG / JPEG / PDF or add the poster to the media library and a playlist. Posters are drawn in the admin page (browser canvas); the TV player only shows normal images. A poster that was published but whose product, price or offers later change is removed from playlists automatically. Staff guide, test results and limitations: **[docs/PHONE-POSTERS.md](docs/PHONE-POSTERS.md)**.

## Tests
`cd server && npm test` runs the server tests, including store-isolation tests that try to cross between stores. CI runs them on every pull request.

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

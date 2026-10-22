# myT Mobiles: smartphone posters on OpenSign

This guide is for myT Mobiles staff. It explains how to turn phones from the catalog into posters and play them on the store screens.

## The workflow
1. Open **Products**. Click **Import from store website**. Wait until the import ends.
2. Open one product. Check its prices, specs and images. Add the real specs if the store page had none.
3. Click **Mark as verified today**. Do this only after you checked the product.
4. Open **Posters**. Click **Create N posters (drafts)** to make one poster for every phone. Or click **+ New poster** to make one poster.
5. Look at each preview. Change the text, image position or template if needed.
6. Select the posters. Click **Approve selected**.
7. Click **Add selected to media library**. Each poster becomes a normal image in **Media**.
8. Click **Build playlist for category…**. Type the number of the category. A playlist is created with 10 seconds for each poster.
9. Open **Screens**. Choose the playlist as the screen's **Default content**. The TV plays the posters.

## Templates and sizes
| Template | Use it for |
|---|---|
| Premium flagship | Dark background, large phone, spec highlights |
| Camera flagship | Large camera figure and camera highlights |
| Gaming and performance | Processor and display, controlled neon accents |
| Price and offer | Selling price, official price, approved offers with conditions |
| New launch | "New launch" tag, launch information |
| Store brand | myT Mobiles logo and a message (for the "store branding" category) |

Sizes: 1920 × 1080 (signage), 1080 × 1350, 1080 × 1080, A4 portrait and A3 portrait (300 dpi). Export formats: PNG, JPEG, PDF. Posters sent to the media library are JPEG (about 200 KB each).

Specs are shown as tiles. If a phone has no display, processor, camera or battery text, the tiles show memory, network and colours. Nothing is invented.

## Data rules
- **Official price** (brand MRP) and **selling price** (myT Mobiles) are separate fields. They are never combined.
- **Offers** (discount, bank, exchange, other) are separate from prices. An offer is shown beside the selling price. It is never subtracted from it.
- A poster shows prices, stock and offers only when the product is **verified** (in the last 30 days) and the offer is **approved** and **not expired**.
- Bank and exchange offers need written conditions before you can approve them.
- If you change a product's brand, model, variants, specs or highlights, the product returns to **Draft**.
- A poster must be **approved** before it can be exported or added to the media library.
- If the product, price or offers change after approval, the poster shows **Needs review**. If it is already in the media library, the server **removes it from all playlists** (checked every minute). Review it, approve it again and add it to the media library again.
- Imported products always start as **Draft**. Prices stay hidden until staff verify.

## Settings (environment variables)
| Name | Default | Meaning |
|---|---|---|
| `IMPORT_ALLOWED_HOSTS` | `storetmobiles2-code.github.io` | The import reads only from these hosts. Separate several with commas. |
| `PRODUCT_STALE_DAYS` | `30` | Days a verification stays valid. After that, prices are hidden and the product shows "Outdated". |

Other settings are unchanged: `PORT`, `ADMIN_PASSWORD`, `DATA_DIR`, `PUBLIC_URL`, `DISCOVERY_PORT` (0 turns off TV auto-discovery).

## Install
1. Install Node.js 22 or newer.
2. Run `cd server && npm install && npm start`. Or double-click `start.bat` or `start.command`.
3. Open the address that the server prints. Choose a password. Sign in.
4. Install the Android TV app (APK from the GitHub Releases page). See `GETTING-STARTED.md`.

## Upgrade from an earlier OpenSign
1. Stop the server.
2. Replace the files with the new version. Keep the `server/data/` folder.
3. Run `cd server && npm install`. No new dependencies are needed, so this is quick.
4. Start the server. New data (products, posters) is created automatically. Playlists, schedules, screens, walls, layouts and media are not changed.
5. The Android TV app does **not** change. TVs keep working. No new APK is needed.

To go back to the old version, stop the server and start the old files. The new data is ignored by the old version.

## Dependencies
No new dependency was added. The poster generator uses the browser's built-in canvas. The PDF is written by about 40 lines of code (a JPEG inside a one-page PDF). The tests use Node's built-in test runner.

## Test results
These tests were **executed**:
- **Automated (28 tests, `cd server && npm test`, also run in CI):** admin password setup and login, screen pairing, media upload, playlists, schedules, link types, widgets, video walls, layouts, alerts, proof of play (existing features); product validation, verification rules, offer approval and expiry, outdated data, image upload checks, poster spec derivation, the store import against a local test store (create, skip unchanged, flag changed listings, refuse other hosts), poster approval, publishing to the media library, review after changes, and removal of posters from playlists when an offer stops being valid.
- **Real store import:** 35 smartphones and 317 images, 0 errors, about 2.4 minutes. A second import changed nothing (35 unchanged).
- **Browser (Chrome):** login and branding; product list and editor; poster editor preview; approve; add to media library (a real 1920 × 1080 image); PNG and JPEG exports; an A4 PDF (opened and viewed on macOS); the slideshow flow (24 posters created, 25 approved, 25 added to the media library, a playlist of 24 items); a simulated screen received that playlist, and all 24 images could be fetched at 1920 × 1080 (this run used PNG; afterwards the library upload was switched to JPEG and re-checked on one poster: 1920 × 1080, 207 KB, same media id replaced); every admin tab loads with no JavaScript error.

These were **not** executed (no Android device or SDK was available):
- Playing the posters on a real Android TV or in BlueStacks.
- Offline playback and the existing schedule behaviour on a TV (the server side of schedules is covered by tests).
- Reading the posters from a distance on a real screen.

To test on a TV: assign the playlist to your BlueStacks or TV screen and watch it for one full cycle.

## Known limitations
- **Data source.** The catalog comes from the myT Mobiles store site, not from the manufacturer sites. The "official price" is the MRP shown there ("MRP as per brand"). It was not compared with manufacturer pages. The store lists Apple, Samsung, OPPO, Redmi, vivo, Xiaomi and some other brands. OnePlus, iQOO, realme, Motorola, Nothing and Google Pixel have no products in the store feed. You can add them by hand in **Products**.
- **Thin specs.** 13 of the 35 imported phones have only basic facts on the store site (memory, network, colours). Their posters show those facts. Staff should add display, processor, camera and battery for these phones.
- **Verification is manual.** Imported data is Draft. A person must check it and verify it. The system cannot check prices by itself.
- **Images.** The product images come from the store site. The store is responsible for the right to use them.
- **Free text.** Text typed into a poster (headline, tagline, footer, launch information) is not checked.
- **Browser.** Poster drawing needs a current Chrome or Edge.
- **PDF.** The PDF holds the poster as one image. It has no selectable text.
- **Fonts.** Posters use the fonts of the computer that draws them (Helvetica Neue, Arial or similar).
- **Categories** are tags on posters. The playlist button builds one playlist for a category on demand. It does not update by itself.
- **robots.txt.** The store site's `robots.txt` disallows crawlers. The import reads only the allowed owner site, one page at a time, when staff click the button.

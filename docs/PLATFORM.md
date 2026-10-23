# Running OpenSign for several stores

One OpenSign server can serve many stores. Each store sees only its own screens, media, playlists, walls, layouts, alerts, reports, products and posters. Other stores cannot see them, change them or reuse them.

## Who can do what
| Role | Can do |
|---|---|
| **Platform administrator** | Runs the server. Creates stores and their owner logins. Switches features on or off for a store. Switches a store off. Resets any store login's password. Deletes a store. **Cannot see any store's content.** |
| **Store owner** | Everything inside their own store, plus: add, remove and reset store logins (Team), change the store name, colour and logo (Settings). |
| **Store staff** | Screens, media, playlists, layouts, walls, alerts, reports, and (if switched on) products and posters. Cannot manage logins or settings. |

A person belongs to one store. A platform administrator may also own one store ("This is my own store").

## First run
1. Start the server and open its address.
2. Create the **platform administrator** (a login and a password of 8 or more characters).
3. Open **Platform**. Create a store. Give it a name, the owner's login and a first password. To run a single store yourself, tick **This is my own store**.
4. The owner signs in, opens **Settings** (name, colour, logo) and **Team** (staff).
5. The owner connects TVs: open the OpenSign Player app on the TV, then type the 6-digit code it shows into **Screens > Add a screen**.

## Features per store
Under **Platform**, each store has a switch: **Phone catalog and posters**. It is off by default. When it is on, the store gets the **Products** and **Posters** tabs (see `MYT-MOBILES.md`). Each store keeps its own products and posters.

**Store website to import from** (optional) is the address the *Import from store website* button reads. Only the platform administrator can set it, so a store user cannot make the server fetch an address of their choice. The page reader fits shops built like the first store's (a Next.js shop with schema.org product data). Other shops may need an adapter.

## What keeps stores apart
- Every record carries its store. Every admin route filters on it. Another store's id behaves as if it does not exist (404).
- Playlists, layouts, walls and screens can only use items of their own store.
- A TV that a store claimed cannot be claimed by another store.
- With **more than one store**, waiting screens are not listed. A screen is added only by typing the code shown on it. With a single store, waiting screens are listed so you can add them with one click.
- Proof-of-play reports include only the store's own screens.
- Switching a store off or deleting it signs its people out at once. Deleting needs the exact store name, and removes the store's data and files.
- Tests in `server/test/tenancy.test.js` try to cross these lines and must fail to.

## Security notes
- Passwords are stored as salted scrypt hashes. Sessions last 24 hours of inactivity and are kept in memory (a restart signs everyone out). Changing a password signs out other sessions.
- Wrong passwords are rate limited: 8 failures in 10 minutes for one login and address (`LOGIN_FAILURE_LIMIT`).
- Uploaded files get a server-chosen extension from a fixed list of image and video types (SVG is refused), and are served with `nosniff` and a sandbox policy, so an upload can never run as a web page.
- Media files and TV content are fetched by TVs without a login, using unguessable random file names (as before). Do not put secrets in media.
- **Use HTTPS** when the server is on the internet: put it behind a reverse proxy such as Caddy or nginx. Set `TRUST_PROXY=1` so rate limits see each visitor's address, and `PUBLIC_URL` to the public address. The Android player accepts both http and https addresses.
- On a shared network, TV auto-discovery (UDP port 41234) answers any TV on the LAN. For a public server set `DISCOVERY_PORT=0` and have TVs use **Enter server address**.
- Open screen registration is capped (`MAX_WAITING_SCREENS`, default 2000) and unclaimed screens are removed after a week.

## Settings (environment variables)
| Name | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `DATA_DIR` | `server/data` | Where the database and files live. Back this folder up. |
| `PUBLIC_URL` | (request address) | Public address, if behind a proxy |
| `TRUST_PROXY` | off | Set to `1` behind one reverse proxy |
| `DISCOVERY_PORT` | 41234 | UDP port for TV auto-discovery. `0` turns it off |
| `LOGIN_FAILURE_LIMIT` | 8 | Wrong passwords allowed per 10 minutes |
| `MAX_WAITING_SCREENS` | 2000 | Cap on screens waiting to be claimed |
| `PRODUCT_STALE_DAYS` | 30 | Days a product verification stays valid |
| `PLATFORM_ADMIN_LOGIN`, `PLATFORM_ADMIN_PASSWORD` | unset | Set both to create or reset a platform administrator at start-up (recovery) |
| `LEGACY_STORE_NAME` | `My Store` | Name for the store made when upgrading an older single-store server |

`ADMIN_PASSWORD` is no longer used.

## Upgrading an existing single-store server
1. Stop the server. Keep `server/data/`. Replace the other files. Run `cd server && npm install`.
2. Start the server. On first start it **moves everything into one store**: screens, media, playlists, walls, layouts, products, posters, alert and old proof-of-play lines.
   - If the data came from the myT Mobiles store import, the store is called **myT Mobiles** and keeps its logo, brand colour and import address. Otherwise it is called **My Store** (or `LEGACY_STORE_NAME`).
   - The old admin password becomes the login **`admin`**, the owner of that store and a platform administrator. Sign in with `admin` and the old password, then change the login name and password under **Settings**.
3. TVs keep their pairing and keep playing. The Android app does not change and needs no new APK.
4. The upgrade runs once (`schemaVersion` 2 in `db.json`). To go back, stop the server and start the old files with a copy of `db.json` made before the upgrade. **Make that copy first.**

## Backups
Copy the whole `DATA_DIR` folder (`db.json`, `media/`, `plays.ndjson`) while the server is stopped, or at a quiet time.

## Known limitations
- No email: password resets are done by an owner or the platform administrator. No two-factor sign-in yet. No self-service sign-up (by design).
- One server process with a JSON file database. Good for tens of stores and hundreds of screens. A very large platform would need a real database.
- Sessions are lost when the server restarts.
- Media and TV content URLs are secret-by-randomness, not login-protected, because TVs fetch them without a login.
- The store import reads one kind of shop page (see above).
- A platform administrator can see store names, logins and counts, can reset a store login's password and so could sign in as that person. That is a trust decision: only give the role to people you trust.

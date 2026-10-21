# Getting started with OpenSign (no technical knowledge needed)

You need: **a computer** (Windows, Mac, or a Raspberry Pi) that stays on, **an Android TV** (or Android TV box/stick), and **both on the same Wi-Fi/network**.

## Step 1 – Start OpenSign on your computer (one time)
1. Install **Node.js** (the "LTS" button on https://nodejs.org). Click Next through the installer.
2. Download this project (green **Code** button on GitHub, then **Download ZIP**) and unzip it.
3. Double-click **`start.bat`** (Windows) or **`start.command`** (Mac).
4. A window opens and shows an address like `http://192.168.1.20:3000`. Open it in your browser.
5. Choose a password. That's your admin screen. Leave the computer window open.

## Step 2 – Put the player app on your TV (one time per TV)
1. On the TV, install the free **Downloader** app from the Google Play Store.
2. Open Downloader and type: `github.com/syedwaheedz/opensign/releases/latest` – then download the **.apk** file and choose **Install**.
   (If the TV says "unknown sources", allow it for Downloader when asked.)
   *Alternative: put the .apk on a USB stick and open it with the TV's file manager.*
3. Open **OpenSign Player**. It finds your computer by itself and shows "Almost done!".

## Step 3 – Connect the screen
In the admin, open **Screens**. Your TV is listed: click **Add this screen** and give it a name (e.g. "Lobby").

## Step 4 – Show something
1. **Media** tab: upload pictures/videos, or paste a link (YouTube, Instagram, Facebook, or a web page) and click **Add link**.
2. **Playlists** tab: create a playlist, add your media, set how many seconds each shows, click **Save**.
3. **Screens** tab: under your screen, pick the playlist as **Default playlist**.

The TV updates within a minute. It keeps playing if the Wi-Fi drops, and starts again when the TV is switched on.

## Good to know
- **Links need internet on the TV.** Instagram and Facebook only show *public* posts. YouTube plays muted.
- **Several TVs as one big screen:** use the **Video walls** tab.
- **TV stuck on "Looking for your OpenSign server"?**
  1. Check the OpenSign window is still open on the computer.
  2. The TV and computer must be on the **same Wi-Fi/network** (not a guest network, and "client isolation" must be off on the router).
  3. When Windows or macOS asks whether to let **Node.js** accept incoming connections, choose **Allow**. If you clicked Deny, allow it in the firewall settings.
  4. Still stuck? Choose **Enter server address** on the TV screen (click it with the mouse or press OK), type the address shown in the OpenSign window (like `http://192.168.1.20:3000`) and choose Connect. In the Android Studio emulator use `http://10.0.2.2:3000`.
- **Forgot the password?** Stop OpenSign, set the `ADMIN_PASSWORD` environment variable to a new one (it overrides the stored password) and start it again.

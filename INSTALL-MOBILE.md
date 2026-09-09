# Open Scheme on a phone or tablet

[Home](README.md) · [Working computer setup](INSTALL-HOST.md) · [Desktop guide](INSTALL-DESKTOP.md) · [Troubleshooting](TROUBLESHOOTING.md)

Your phone displays Scheme; the work stays on your working computer. You need a browser and the Tailscale app on your phone. You do **not** install Node.js, coding agents, a local model, or a separate Scheme phone app.

First finish [working computer setup through step 5](INSTALL-HOST.md#5-connect-privately-with-tailscale). Leave that computer powered on and awake, with Scheme running. Keep the exact **https://…ts.net** address it printed.

## iPhone or iPad

**On the iPhone or iPad:**

1. Install the official Tailscale app from the App Store; [Tailscale's download page](https://tailscale.com/download) links to it.
2. Open Tailscale and sign in to the **same account** as the working computer. Accept the system request to add the VPN connection, then turn Tailscale on.
3. Open **Safari**. Paste your working computer's full **https://…ts.net** address into the address bar and tap Go.
4. Scheme should open. Tap the **Terminal** tab, choose your existing Shell session, then tap inside the terminal to show the keyboard.
5. Type `echo "Connected from my phone"` and press Return. You should see **Connected from my phone**.

For a home-screen shortcut, open Safari's **Share** menu and choose **Add to Home Screen**, then **Add**. Menu wording can vary by iOS version; [Apple's website-app guide](https://support.apple.com/guide/iphone/iphea86e5236/ios) shows the current menu. It opens the same web dashboard. Tailscale still needs to be connected when you open it.

## Android

**On the Android phone or tablet:**

1. Install the official Tailscale app from Google Play; [Tailscale's download page](https://tailscale.com/download) links to it.
2. Open Tailscale and sign in to the **same account** as the working computer. Accept the VPN connection request and make sure Tailscale is connected.
3. Open **Chrome**. Paste your working computer's full **https://…ts.net** address into the address bar and tap Go.
4. Scheme should open. Tap **Terminal**, choose your existing Shell session, and tap inside the terminal to open the keyboard.
5. Type `echo "Connected from my phone"` and press Enter. You should see **Connected from my phone**.

For a home-screen shortcut, open Chrome's **⋮** menu and choose **Add to Home screen** or **Install app**, whichever your browser offers. [Chrome's web-app guide](https://support.google.com/chrome/answer/9658361?hl=en&co=GENIE.Platform%3DAndroid) explains those options. This opens the same web dashboard; it does not move the coding tools onto your phone.

## Everyday phone controls

- Use **＋ New** to start another session. The optional AI tools must already be installed on the working computer.
- Tap inside the terminal when you want to type. The touch bar supplies keys a phone keyboard may not show, such as **Esc**, **Tab**, arrows, and **Ctrl+C**. Ctrl+C interrupts the current command.
- Swipe inside the terminal to scroll. Rotate the phone to landscape for wider lines.
- Returning after locking the screen may require a moment to reconnect or a page refresh. The working computer's sessions can continue while the mobile browser is suspended.
- Closing a browser page disconnects it; closing a **session** in Scheme ends that session. Do not close a session to “log out.”

The browser shortcut is not an offline mode. The viewing device still needs a working private connection, and the working computer must stay awake. If the keyboard covers the last line or scrolling gets stuck, see [phone troubleshooting](TROUBLESHOOTING.md#phone-keyboard-or-scrolling-problems).

Treat this access like being signed into the working computer: anyone using your connected, unlocked phone can use the dashboard as your host account.

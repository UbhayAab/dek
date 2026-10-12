# Dek Android and iOS apps

Owner: native builder (apps/mobile, apps/web/src/native, this file, docs/store).
Authority: PRD "Dek Android and iOS release plan" (APP01 to APP17, shared mobile
release checks) and DEK14 to DEK20, DEK24.

## 1. Decision APP01: Capacitor 8 around the same web app

Decided 2026-10-03 by the lead; recorded here with the reasoning and the honest
limits.

**Choice.** One codebase: the React web app in `apps/web` runs inside a native
shell built with Capacitor 8.5 (`apps/mobile`). Native plugins supply what a
browser cannot: FCM and APNs push, Keystore and Keychain session storage, App
Links and Universal Links, the Android back button, keyboard resize, the status
bar and the splash screen.

**Why.** The team is small and the web client is being rebuilt anyway; a second
UI in Kotlin and Swift (or React Native) would double every feature and every
fix. The PRD allows a web shell only when push, uploads, secure storage,
navigation, background behavior and calls meet the same acceptance cases, so each
of those is mapped below to the native piece that meets it, or marked as not met.

| PRD case | How the app meets it | Status |
|---|---|---|
| Push (DEK15, DEK20) | `@capacitor/push-notifications`: FCM on Android, APNs on iOS; token registered with `register_push_device` kind `fcm` / `apns`; refresh re-registers; sign-out unregisters and deletes the token | Code done and unit tested. Needs a Firebase project (Android) and an APNs key (iOS) to deliver; until then the app says "Push not configured on this build" |
| Secure storage (APP03) | Session in the Android Keystore (AES-GCM, key never leaves the device) and the iOS Keychain (after first unlock, this device only, no iCloud sync) via `@aparajita/capacitor-secure-storage` 8.0.1; never localStorage | Done, unit tested, verified on the emulator (section 9) |
| Uploads (DEK10) | The web file input works in the WebView: Capacitor's chrome client opens the system picker (no storage permission needed) and camera capture (CAMERA asked at that moment) | Uses the web code path; picker verified on the emulator only as far as section 9 says |
| Navigation and deep links (DEK18) | App Links `https://dek-7o4.pages.dev/o/*` and `/invite/*` (assetlinks.json), Universal Links (apple-app-site-association), `dek://` fallback, push tap `data.url`; Android back button: in-app history, parent screen after a deep link, exit at a root | Done, unit tested |
| Calls (DEK21 to DEK24) | WebRTC in the WebView; microphone and camera granted to the page only after the Android runtime permission (DekWebChromeClient) and the iOS purpose strings | Works while the app is open. See the limits below |
| Background behavior | Pushes arrive while the app is in the background or closed (OS shows them); on resume the session refreshes and the app emits `dek:resume` for realtime to rejoin | Done |
| Accessibility | Same DOM as the web app, so TalkBack and VoiceOver read the same labels the web builders wrote | Inherited from the web app; not separately audited on devices |

**What a WebView shell does not match (first release).**

- Incoming calls while the app is fully closed. A real phone-call experience
  (full-screen ring on the lock screen, answer from the lock screen) needs
  CallKit with PushKit VoIP pushes on iOS and ConnectionService with a
  full-screen-intent notification on Android. Out of scope for the first release.
  Ringing then arrives as a high-priority push on the `calls` channel (Android
  plays the ringtone channel sound); the tap opens the app on the call.
- Calls that continue in the background. iOS suspends a WebView app shortly
  after it leaves the screen, so a call drops if the person switches apps for long
  (the `audio` background mode is deliberately not enabled: App Review requires a
  real audio session for it). Android keeps the WebView running while the
  activity is in the background but can stop it under memory pressure; there is
  no foreground service.
- Bluetooth headset routing during calls is whatever the WebView does by itself;
  it is not managed natively. Untested.
- Downloads: a link to a signed file URL opens the system browser, which shows or
  saves the file. `<a download href="blob:...">` does nothing in the Android
  WebView. The media builder should open signed URLs (with the `download` option
  for attachments) rather than blob downloads when `isNativeApp()`.
- The service worker is not used in the apps (assets are bundled; push is native).
  WKWebView does not run it at all; on Android it would only add a cache layer.

DEK20 says a WebView wrapper is not proof that native push or incoming calls work.
Agreed: section 9 lists what was proven here and what still needs real devices.

## 2. Identity and versions

| | Android | iOS |
|---|---|---|
| Identifier | `org.jaruratcare.dek` (PROPOSED) | `org.jaruratcare.dek` (PROPOSED) |
| Version | versionName `2.0.1`, versionCode `2` | `MARKETING_VERSION 2.0.0`, `CURRENT_PROJECT_VERSION 1` |
| Target | targetSdk 36, compileSdk 36 (APP07: API 36 required since 31 Aug 2026) | Xcode 26, iOS 26 SDK (APP13) |
| Minimum | minSdk 26, Android 8.0 (decision for APPQ06, below) | iOS 15.0 (Capacitor 8 floor; APP13 asks 13 or later) |

The identifier is a **proposal**: decision D02 / APPQ01 (the legal publisher) is
open. It can change freely until the first upload to Play Console or App Store
Connect and never after. To change it: `capacitor.config.ts` appId,
`android/app/build.gradle` namespace and applicationId, the Java package folder,
`PRODUCT_BUNDLE_IDENTIFIER` in the Xcode project, and both files in
`apps/web/public/.well-known`.

**APPQ06 minimum versions (proposed, owner to confirm).** Android 8.0 (API 26):
notification channels exist from 26 (one code path for channels), the WebView
updates through Play on every supported version, and Android 7 and older are a
negligible share of phones in use in India in 2026. Capacitor 8 itself allows 24.
iOS 15.0 is the lowest Capacitor 8 supports; the tested minimum is set when real
iPhones are available. Versions are bumped together: versionCode +1 for every Play
upload (Play rejects reuse), build number +1 for every App Store Connect upload.

## 3. Layout

```
apps/mobile/
  capacitor.config.ts          app id, webDir, plugin settings
  package.json                 own lockfile (not a root workspace)
  android/                     Gradle project (Capacitor 8.5, AGP 8.13, Gradle 8.14.3)
    app/build.gradle           version, env-only release signing, optional Firebase
    app/src/main/AndroidManifest.xml
    app/src/main/java/org/jaruratcare/dek/
      MainActivity.java        registers DekNative, installs DekWebChromeClient
      DekWebChromeClient.java  getUserMedia gate: own origin, mic and camera only,
                               after the runtime permission
      DekNativePlugin.java     pushConfigured, notification channels, settings intents
  ios/App/                     Xcode project (Swift Package Manager, no CocoaPods)
    App/Info.plist             purpose strings, remote-notification, dek:// scheme
    App/App.entitlements       aps-environment, associated domains
    App/PrivacyInfo.xcprivacy  privacy manifest
  scripts/
    android-build.mjs          web bundle, cap sync, Gradle, artifact sizes
    make-upload-keystore.mjs   one-time upload key; prints fingerprints only
    vite.native.config.mjs     native web bundle until main.tsx calls initNative
    configure_ios.py           idempotent iOS project configuration
    make_assets.py             icons, splash, notification icon from the web icons
apps/web/src/native/           the web side (no-op in a browser)
apps/web/public/.well-known/   assetlinks.json, apple-app-site-association
```

## 4. The web side (`apps/web/src/native`)

The web bundle does not import any `@capacitor/*` package. The shell injects
`window.Capacitor` before page scripts run; `bridge.ts` makes the same
`nativePromise` / `addListener` calls that `@capacitor/core`'s `registerPlugin`
makes. So the web deploy does not depend on the mobile toolchain, the shared
lockfile is untouched, and the web bundle grows by a few KB. If the lead prefers
the official JS packages later, only `bridge.ts` changes.

`initNative()` (call it first in `main.tsx`) does nothing on the web. In the apps
it: moves the Supabase session into secure storage (`setAuthStorage`, before the
client exists), routes App Links, `dek://` links and push taps through the router,
installs the back button and keyboard handling, re-registers push on token refresh,
registers an already-allowed device at sign-in, deletes the token when the session
ends, and refreshes the session on resume.

API for the other builders:

| export | use |
|---|---|
| `initNative()` | `main.tsx`, before render |
| `isNativeApp()`, `nativePlatform()` | branch web or native behavior (skip service worker registration and web push when native) |
| `enableNativePush(userId)` | the "Turn on notifications" click; returns the same shape as `enablePush` |
| `ensureNativePushOnLogin(userId)` | sign-in (also runs automatically) |
| `disableNativePush(userId, { unregister: true })` | sign-out, BEFORE `supabase.auth.signOut` |
| `nativePushStatus()` | notification health (DEK19): state, message, device id, last error; `not_configured` carries "Push not configured on this build" |
| `openNativeNotificationSettings()`, `openNativeAppSettings()` | the fix for a denied permission |
| `clearConversationNotifications(channelId, threadRootId?)` | when a conversation opens (tags `c:<channel>`, `t:<root>`) |
| `onNativePushReceived(cb)` / window event `dek:push` | pushes that arrive while the app is open (no OS banner then) |
| window event `dek:back` (cancelable) | Android back: a sheet or menu that is not a `<dialog>` closes itself and calls `preventDefault()`. An open `<dialog>` (kit Modal, photo viewer) needs nothing: back sends it the same `cancel` event Escape does. Then root screens exit, other screens use the router's `back(parent)` |
| window events `dek:resume`, `dek:pause` | realtime rejoin and pause hooks |
| `html.dk-native`, `html.dk-android`, `html.dk-ios`, `html[data-keyboard=open]`, `--kb-native` | CSS hooks |
| `setNativeBarStyle('light' or 'dark' or 'system')` | status bar icons for the in-app theme |

## 5. Push

Android needs a Firebase project. Without `google-services.json` the app builds
and runs; `DekNative.info()` reports `pushConfigured: false` (the google-services
Gradle plugin is applied only when the file exists), the web layer never calls
`register()` (which would crash the app inside the plugin), and notification
health shows "Push not configured on this build". The file is gitignored; the
build copies it from `DEK_GOOGLE_SERVICES_JSON` or `E:\secrets\dek\google-services.json`
and deletes it again afterwards.

Server side (push-dispatch, owned by the platform builder) needs
`FCM_SERVICE_ACCOUNT_JSON` for FCM and `APNS_KEY_ID`, `APNS_TEAM_ID`,
`APNS_PRIVATE_KEY`, `APNS_TOPIC` (= the bundle id) for APNs. The app expects:

- `data.url` (relative in-app path) and `data.tag` (`c:<channel>` or `t:<root>`);
  the tap opens `url`; `tag` lets the app clear one conversation's notifications.
- Android: `android.notification.channel_id` = `messages` (default) or `calls` for
  ringing (ringtone sound); `tag` = the conversation tag (a newer message replaces
  the older one).
- iOS: `thread-id` = tag, `apns-collapse-id` = tag. Badges (DEK20) need `aps.badge`
  with the person's unread count; push-dispatch does not send one yet.
- Quiet hours, preview privacy and mute come from the same server-side routing as
  web push, so they are consistent by construction.

Token lifecycle: a token is created only after the person turns notifications on
(`firebase_messaging_auto_init_enabled` is false in the manifest). Refresh re-registers
and retires the old endpoint; sign-out unregisters the device, removes delivered
notifications (shared phones) and deletes the token; a session that ends elsewhere
deletes the token locally and push-dispatch prunes the dead endpoint.

## 6. Signing (APP06)

| | |
|---|---|
| Upload keystore | `E:\secrets\dek\upload-keystore.jks` (PKCS12, RSA 4096, alias `dek-upload`, valid until 25 Sep 2056) |
| Password | repo `.env.local` as `DEK_ANDROID_KEYSTORE_PASSWORD` (gitignored, never printed) |
| SHA-256 | `6A:09:6B:BF:4F:07:3C:C1:5C:F3:7A:B2:B2:5D:30:E5:90:C0:9D:96:DE:B8:4F:1B:17:D3:E6:3E:54:71:F5:38` |
| SHA-1 | `86:12:6E:A3:C0:F8:CD:22:8A:DE:0C:43:F4:8D:53:3C:8C:FC:E8:5D` |

Fingerprints are public (they also sit in `assetlinks.json`); the keystore and
its password are secret and never enter the repo (the repo is public).

**Owner action: copy the keystore AND the password to a second physical
location** (an encrypted USB drive or the organization's password manager). The
C:, D: and E: drives on this machine are one failing SSD; a single copy is one
disk failure away from gone.

Use **Play App Signing** (the default for new apps): Google holds the app signing
key and this file is only the upload key. A lost or leaked upload key is then
recoverable: the account owner asks Play support for an upload key reset and
registers a new one. Without Play App Signing a lost key would mean a new app
listing.

After the first upload, Play Console shows the **app signing** certificate. Its
SHA-256 must be ADDED to `apps/web/public/.well-known/assetlinks.json` (keep the
upload key entry too), otherwise App Links do not verify for installs from Play.

Release signing reads only environment variables; `bundleRelease` fails loudly
without them instead of producing an unsigned or debug-signed bundle.

## 7. Building

Requirements on this machine: JDK 21 at `C:\Users\abhay\tools\jdk-21.0.12.1+1`
(the machine-wide JAVA_HOME is JDK 17, which Capacitor 8 rejects), Android SDK at
`E:\android-sdk` (platform 36, build-tools 35 and 36), Gradle caches in
`E:\gradle-home`. The JVM is started with `-Djava.net.preferIPv4Stack=true`
because this network has no working IPv6 route and Gradle downloads time out
without it. Gradle runs with 1.5 GB heap, no daemon, two workers, and only after
at least 3 GB of RAM is free.

```
cd apps/mobile
npm ci
node scripts/android-build.mjs debug     # app-debug.apk
node scripts/android-build.mjs release   # app-release.aab (+ signed APK)
node scripts/android-build.mjs all       # both, one Gradle run
python scripts/make_assets.py            # only when the icon changes
python scripts/configure_ios.py          # after regenerating ios/
```

Outputs: `android/app/build/outputs/apk/debug/app-debug.apk`,
`android/app/build/outputs/bundle/release/app-release.aab`,
`android/app/build/outputs/apk/release/app-release.apk`.

Web deploys do not update the apps: the web code is bundled into each build. A
fix that must reach app users needs a new store release. The server must stay
compatible with the oldest supported app build (APP02); the `x-dek-build` header
identifies it.

**iOS (APP12): cannot be built here.** There is no Mac on this machine, and a
Windows desktop is not proof that a signed iOS build can be produced. The Xcode
project is generated and configured; on a Mac with Xcode 26:

```
cd apps/mobile && npm ci && npx cap sync ios
open ios/App/App.xcodeproj
```

then set the Team on the App target (Signing and Capabilities), confirm Push
Notifications and Associated Domains are listed, replace
`REPLACE_WITH_APPLE_TEAM_ID` in `apps/web/public/.well-known/apple-app-site-association`
with the Team ID and redeploy the web app, then Product, Archive, Distribute to
App Store Connect. `DEK_WEB_DIR=dist-native npx cap sync ios` is needed while
`main.tsx` does not call `initNative()`.

## 8. Permissions (APP03)

Declared by the app: INTERNET, POST_NOTIFICATIONS (asked from the notification
settings screen, never at launch), CAMERA, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS
(asked when a call or a camera capture starts). Camera and microphone hardware are
`required=false`, so phones and tablets without them can still install Dek for
chat. No storage, location, contacts, phone or SMS permission: the system picker
needs none.

Merged manifest of the release APK (`aapt2 dump badging`), 2026-10-03:

| Permission | From | Why |
|---|---|---|
| INTERNET, POST_NOTIFICATIONS, CAMERA, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS | Dek | above |
| com.google.android.c2dm.permission.RECEIVE, WAKE_LOCK, ACCESS_NETWORK_STATE | Firebase Cloud Messaging | receiving push; normal permissions, no prompt |
| org.jaruratcare.dek.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION | AndroidX core | signature permission the app defines for its own receivers; grants nothing to others |

None needs a Play permissions declaration.

iOS purpose strings: camera, microphone, photo library. Background modes:
`remote-notification` only.

Backups: `allowBackup=false` plus data-extraction rules that exclude everything,
so the session, the outbox and cached conversations never land in a cloud backup
or a device transfer.

## 9. Evidence

**Unit tests** (`apps/web/src/native/*.test.ts`, vitest with a fake
`window.Capacitor`): 45 of 45 pass. They cover the web no-op, the bridge,
Keystore/Keychain storage (prefixed keys, no iCloud sync, unreadable entry means
signed out), push (permission only from a click, "Push not configured on this
build" without ever calling register, FCM and APNs kinds, token refresh retiring
the old endpoint, sign-out unregister plus token deletion plus notification
clearing, tap routing, foreground events, per-conversation clearing), links
(App Links, `dek://`, push urls; other hosts, plain http, protocol-relative,
script urls, `/\host` paths and unknown routes refused), back (dialog first,
root exit, router back), `initNative` wiring, and a failed registration retried
on resume.

**Builds** (2026-10-04, `node scripts/android-build.mjs all`, incremental run
1 min 27 s, a clean run about 13 min on this machine):

| Artifact | Bytes | Signed with |
|---|---|---|
| `android/app/build/outputs/apk/debug/app-debug.apk` | 6,492,693 | debug key (this machine) |
| `android/app/build/outputs/bundle/release/app-release.aab` | 4,581,371 | upload key |
| `android/app/build/outputs/apk/release/app-release.apk` | 4,833,383 | upload key |

 `aapt2 dump badging` of the release APK:
package `org.jaruratcare.dek`, versionCode 1, versionName 2.0.0, minSdk 26,
targetSdk 36, compileSdk 36. `apksigner verify --print-certs` (APK) and
`jarsigner -verify` plus `keytool -printcert -jarfile` (AAB): signed by
`CN=Dek Android upload key`, SHA-256 `6A:09:6B:...:F5:38`, the upload key above.

**Emulator** (2026-10-04, Pixel 6 profile, Android 16 / API 36 Google APIs
x86_64, WebView 133, WHPX acceleration; the debug APK built with the
`initNative()` call added by `vite.native.config.mjs`). The headless emulator
binary (`-no-window`) hung at start twice on this machine; `-qt-hide-window`
booted in about 2.5 minutes. Screenshots: `apps/mobile/screenshots/` (gitignored).

| Check | Result |
|---|---|
| Launch | Cold start 7.2 s on the first launch of a loaded machine, 2.7 s after a force-stop. Sign-in screen renders (01-launch.png) |
| Native bridge | `isNativePlatform` true, platform android, `html.dk-native.dk-android`, origin `https://localhost`; 11 plugins announced including DekNative and SecureStorage |
| Sign-in (qa-alice) | Works against the real backend; Dek QA workspace loads (02-signed-in.png); private images load through signed URLs (04-channel.png) |
| Secure session | The session is only in `WSSecureStorageSharedPreferences.xml` under `dek_dek.auth`, AES-GCM ciphertext: 0 plaintext `access_token` matches. localStorage holds only per-user UI state (last org, last channel, drafts, scroll) |
| Session survives process death | `am force-stop`, cold start: still signed in, back in the organization |
| Push on a build without Firebase | `DekNative.info()`: pushConfigured false, channels `messages` and `calls` created and enabled, notification permission still `prompt` (not asked at launch) |
| Deep links | `dek://o/<org>/c/<channel>` while running, the https App Link (explicit package) and a cold start through `dek://` all opened the right channel |
| Back button | Found on the first run: the WebView reports `canGoBack: false` for pushState history, and with the photo viewer open back left the channel. Fixed (back closes an open dialog first, then uses the router). Re-run on the rebuilt APK: viewer open, back closes it and stays in the channel; back again goes to the organization root; back at the root exits to the launcher |
| Keyboard | Composer focused: keyboard 336 CSS px, layout viewport 842 to 530 px, composer bottom at 495 px, fully visible (05-composer-keyboard.png); `data-keyboard=open` and `--kb-native: 336px` set |
| Sign-out | Back to "Sign in to Dek"; the secure storage entry is gone. Leftover: `dek.lastChannel.<user>.<org>` stays in localStorage (core builder's wipe; reported) |

Not tested here: push delivery (no Firebase project), the notification
permission prompt from the settings screen (the platform builder's screen does
not call the native functions yet), camera and microphone prompts and calls, file
picker uploads, App Links verification against the deployed `assetlinks.json`
(needs the release key and the deployed file), anything on iOS (no Mac).

## 10. Shared mobile release checks (PRD)

| Check | Android | iOS |
|---|---|---|
| Organization switching | same web code as the browser; QA user has one org, not exercised | not run |
| New message | same web code; durable outbox in WebView IndexedDB; not sent on the emulator | not run |
| Network interruption | same web code; resume emits `dek:resume`; not run | not run |
| Push | code and unit tests; "not configured" path verified on the emulator; delivery blocked on a Firebase project | blocked on Apple account, APNs key, Mac |
| Push tap | unit tested (url routing, cold start de-duplication); the same routing verified with `dek://` and App Link intents on the emulator | not run |
| Media | private images display on the emulator; upload, camera and failed upload not run | not run |
| Calls | permission gate in code; not run on a device | not run |
| Sign out and removed access | emulator: session removed from secure storage, sign-in shown; token deletion and notification clearing unit tested | not run |
| Account deletion | web route `/settings/account` (seen on the emulator) plus https://dek-7o4.pages.dev/delete-account.html | same |
| Upgrade | first release; storage key `dek.auth`, prefix `dek_` must not change | same |

# Fixboard #29: picture quality across web and Android

The web fix of October 10 preserves original bytes automatically. The installed
native Android app bundles its web code. The local signed October 4 APK still
contains the old 400 KB / 1600 px compression; deploying Pages cannot replace it.
Android version 2.0.1 (code 2) must be installed over version 2.0.0 (code 1).
Build with `node apps/mobile/scripts/android-build.mjs all`; the output manifest
records the commit, build ID, artifact lengths and SHA-256 hashes.

JPEG EXIF rotations 5 through 8 now produce oriented server dimensions, matching
the browser and the separate thumbnail. Original bytes and EXIF stay untouched.
The viewer shows the full file's dimensions and size beside a visible Download
button. Old compressed posts cannot recover missing pixels; attach their original
source again after updating the client.

## Repeatable browser verification

The real photograph fixture is NASA's Apollo 17 Blue Marble, no personal data:
https://science.nasa.gov/resource/the-blue-marble/
https://images-assets.nasa.gov/image/as17-148-22727/as17-148-22727~orig.jpg

Source: 4,579 x 4,579 JPEG, 1,915,552 bytes, SHA-256
`cb4c3d2da98ee72130ebfd2ea472fc84ede6726002c2a8c9cabd86e4deea9f0f`.
Save the source under ignored `tools/scratch/quality-29/nasa-blue-marble.jpg`.
From `apps/web`, set `SMOKE_URL=https://dek-7o4.pages.dev`,
`DEK_QUALITY_PHOTO` to the source's absolute path and `DEK_QUALITY_SHOTS` to an
ignored evidence folder. Run:

```
npx playwright test -c e2e/smoke/playwright.config.ts image-quality.spec.ts
```

The 1280 x 800 and 390 x 844 checks use separate QA sender/receiver accounts,
JPEG/PNG/WebP plus two synthetic EXIF portrait JPEGs and the actual photograph.
They verify stored sizes, oriented dimensions, 640 px previews, actual Download
button bytes by SHA-256, and page/viewer overflow. Proof includes cropped toolbars.
Synthetic messages are removed in `finally`. Phone emulation is not a real Android
handset or an installed app check.

## Required handset check

Connect the test Android phone with USB debugging, confirm `adb devices -l`, and
record its Chrome version, app package/version and signing certificate. Install
the updated matching-signed APK without clearing app data. In Chrome and in the
installed app, attach the fixture through the system picker, wait for "Ready,
original quality", send in Dek QA, then open and download it. The native app opens
the system browser for the download. Pull the saved file and compare SHA-256 with
the source above. Repeat with a portrait phone JPEG. Screenshot only the fixture
and QA workspace. Do not uninstall an unmatched-signature app to force an update.

No handset was connected at initial inspection on October 12. Reporter Chrome
and installed-app behavior, installed version and physical download remain open
until this check runs. Keep Fixboard In progress until the required proof exists.

## Release evidence, 2026-10-12

- Code `528bceb`; production deployment `ce0e1295`, web version `cf5f2d6e7068`,
  build `528bceb-20261012T1708`. Both deployment and alias version checks passed.
- `media-finalize` v7 ACTIVE; unauthenticated POST returns 401 as expected.
- 641 web tests, 4 focused viewer checks and 13 parser checks passed. Database
  suite: 264/265 on first run; the unchanged organization-list timing case passed
  on focused rerun without changes. Twelve live media/API checks passed.
- Six production smoke cases passed at 1280 x 800 and 390 x 844. All 12 downloaded
  hashes and lengths matched originals. Portrait metadata/viewer: 1600 x 2400;
  real photo: 4579 x 4579. Separate previews: longest edge 640 px. Overflow checks
  passed. Screenshots and toolbar crops were visually inspected.
- Fresh native Android 2.0.1/code 2 built from a clean tree with new assets synced.
  Signed APK 6,022,158 bytes, SHA-256
  `d2fae19934dd23b788b8c58f47c7b60971a0e0e9313acd26128b5f1342cf996d`.
  The packaged preparation/download/viewer sources match current source maps,
  build stamp matches, and the upload certificate matches backed-up version 1.
- Evidence/report/artifacts:
  `C:/Users/abhay/.claude/chief-of-staff/dispatch/2026-10-12/codex-dek/`.
  Fixboard update 99 adds three inspected proof screenshots and numbered steps.
- `adb devices -l` remained empty. No physical phone, installed reporter version,
  app distribution or store release was verified. Fixboard remains In progress;
  the worker result is blocked on this required device gate, not reported Done.

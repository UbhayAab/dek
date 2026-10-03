# Dek mobile publication status

As of 2026-10-03. A milestone is "done" only with evidence; built, uploaded or
submitted is never reported as published (PRD "Publication status reporting").

| | Android (Google Play) | iOS (App Store) |
|---|---|---|
| Identifier | org.jaruratcare.dek (PROPOSED) | org.jaruratcare.dek (PROPOSED) |
| Version | 2.0.0 (versionCode 1) | 2.0.0 (build 1) |
| Test distribution link | none yet (needs a Play Console app record) | none yet (needs App Store Connect and TestFlight) |
| Store record | none | none |

| Milestone | Android status | iOS status | Waiting on (owner action) |
|---|---|---|---|
| Account prepared | Not started | Not started | Ubhay: decide the legal publisher (D02, APPQ01) and its authorized account holder; organization-controlled Google and Apple accounts with 2FA; D-U-N-S number for that entity (APPQ03); Play Console organization account (USD 25 one time); Apple Developer Program enrollment (USD 99 a year) or a nonprofit fee waiver request (APPQ04) |
| Verified | Not started | Not started | Ubhay: complete Google organization verification and Apple organization verification for that entity |
| Source implemented | Done for the first release scope (shell, push, secure session, links, back, keyboard, permissions); web features keep landing from the other builders | Configured, not compiled (no Mac) | Lead: add the two `initNative` lines to main.tsx (until then the build injects them) |
| Release build created | Done: signed app-release.aab (see docs/NATIVE.md section 9 for size and date) | Not possible here | iOS: a Mac with Xcode 26 or a macOS build service (APP12, APPQ05) |
| Internal test passed | Not started | Not started | Play Console app record (needs the account) to upload to internal testing; TestFlight (needs enrollment and a Mac build); testers named (APPQ07) |
| External test passed | Not started | Not started | Closed test group; for a new personal Play account 12 testers for 14 days (not needed for an organization account) |
| Submission ready | Not yet | Not yet | Firebase project and `google-services.json` plus `FCM_SERVICE_ACCOUNT_JSON` (Android push); APNs key (.p8), Team ID and APNs secrets (iOS push); review accounts created (lead); support URL and contact email; feature graphic and screenshots from the release build; Play app signing fingerprint added to assetlinks.json after the first upload |
| Submitted | Not started | Not started | all of the above |
| Review issue | none | none | |
| Approved | Not started | Not started | store review |
| Published | No | No | |
| Post-release verified | No | No | sign-in, message delivery, push and crash checks after release |

## Owner actions, in order

1. Decide the legal publisher for the Dek apps (D02, APPQ01) and confirm or change
   the proposed identifier `org.jaruratcare.dek` before anything is uploaded.
2. Copy `E:\secrets\dek\upload-keystore.jks` and its password
   (`DEK_ANDROID_KEYSTORE_PASSWORD` in `.env.local`) to a second physical
   location. C:, D: and E: are one failing SSD.
3. Create a Firebase project for that publisher with an Android app
   `org.jaruratcare.dek` (add the upload key SHA-1 and SHA-256); put
   `google-services.json` in `E:\secrets\dek\`; create a service account key for
   FCM and give it to the lead for `FCM_SERVICE_ACCOUNT_JSON`.
4. Get a D-U-N-S number for the publisher; create the Play Console organization
   account; create the Dek app (Business category); enable Play App Signing.
5. Enroll in the Apple Developer Program as the organization (or request the
   nonprofit fee waiver); create the APNs key (.p8) and note the Team ID.
6. Arrange a Mac with Xcode 26 (or a macOS build service) for the iOS build.
7. Name the internal testers (both organizations, Android and iPhone).
8. Provide a support URL and a support email for the listings.

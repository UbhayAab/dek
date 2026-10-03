# Dek privacy and policy declarations

Derived from the real data flows (docs/ARCHITECTURE.md, docs/CONTRACT.md) and
the published notice (apps/web/public/privacy.html), not from a template (APP08).
If a flow changes, change this file and both store forms together.

Facts the answers rest on:
- Data goes to Dek's own backend (Supabase, Mumbai), Cloudflare (app delivery
  and call relay) and the platform push service (Google FCM, Apple APNs). These
  are service providers acting for the publisher; nothing is sold or shared with
  third parties for their own use. No ads SDK, no analytics SDK, no crash
  reporting SDK, no tracking.
- The Android app contains Firebase Cloud Messaging only (auto init disabled and
  analytics collection disabled in the manifest); no token exists until the
  person turns notifications on.
- Everything travels over TLS. Files are private and opened through 15-minute
  signed links. Calls are never recorded; call audio and video go device to
  device or through the encrypted relay and are not stored.
- Account deletion: in the app (Settings, Account, Delete account) and on the web
  (https://dek-7o4.pages.dev/delete-account.html). Deleted: sign-in, profile,
  memberships, devices, settings, saved messages. Kept as the organization's work
  records: messages and files posted in shared conversations (shown as "Deleted
  user"); moderation records. Backups roll off within 7 days.

## Google Play: Data safety

**Does the app collect or share any of the required user data types?** Yes.
**Is all user data encrypted in transit?** Yes.
**Do you provide a way for users to request that their data is deleted?** Yes
(in-app and https://dek-7o4.pages.dev/delete-account.html).
**Shared with third parties:** No, for every type (service providers are exempt).

| Category | Data type | Collected | Required or optional | Purposes | Ephemeral |
|---|---|---|---|---|---|
| Personal info | Name | Yes | Required | App functionality, Account management | No |
| Personal info | Email address | Yes | Required | App functionality, Account management | No |
| Photos and videos | Photos | Yes | Optional (only what the person shares) | App functionality | No |
| Photos and videos | Videos | Yes | Optional | App functionality | No |
| Audio | Voice or sound recordings | Yes | Optional (voice notes, audio files; never call audio) | App functionality | No |
| Files and docs | Files and docs | Yes | Optional | App functionality | No |
| Messages | Other in-app messages | Yes | Required | App functionality | No |
| App activity | App interactions | Yes (read positions, last active time, notification settings) | Required | App functionality | No |
| App activity | Other user-generated content | Yes (reactions, pins, profile title and status, reports) | Optional | App functionality | No |
| Device or other IDs | Device or other IDs | Yes (push token, only after notifications are turned on) | Optional | App functionality | No |

Not collected: location, contacts, calendar, financial info, health and fitness,
web browsing, app info and performance (no crash logs or diagnostics), installed
apps, SMS, call logs.

## Google Play: other declarations

| Declaration | Answer |
|---|---|
| Ads | No, the app contains no ads |
| App access | All functionality needs sign-in: provide the review account (docs/store/review-access.md) |
| Target audience | 18 and over. OWNER to confirm no member is under 18 (if any are, the Families policy questions change) |
| Content rating (IARC) | Category: communication or social. Violence, sexuality, language, controlled substances, gambling: none. Users can interact or exchange content: Yes. Shares location: No. Digital purchases: No. Unrestricted internet: No (links open in the browser). Expected outcome: everyone or teen level with the "Users Interact" notice; IARC computes it |
| News app | No |
| Health apps | No health features (Dek is a workplace chat) |
| Financial features | None |
| Government app | No |
| Sensitive permissions | None of the restricted ones (no SMS, call log, all files access, background location, exact alarm, foreground service, full-screen intent) |
| Account deletion | Yes: in-app path and https://dek-7o4.pages.dev/delete-account.html |
| Data deletion without account deletion | Users delete their own messages in the app; administrators remove content |

## App Store: App Privacy

**Do you or your third-party partners collect data from this app?** Yes.
**Tracking:** No data is used to track. No App Tracking Transparency prompt.

Data linked to the user, used for App Functionality only:

| Apple category | Data type |
|---|---|
| Contact Info | Name, Email Address |
| User Content | Photos or Videos, Audio Data, Other User Content (messages, files, reactions, reports) |
| Identifiers | User ID (the account id), Device ID (the push token, declared conservatively) |
| Usage Data | Product Interaction (read positions, last active time) |

Not collected: health, financial, location, sensitive info, contacts, browsing
history, search history, purchases, diagnostics.

The app's privacy manifest (`ios/App/App/PrivacyInfo.xcprivacy`) declares the same
types, tracking false, and no required-reason API use by the app's own code
(Capacitor and its plugins ship their own manifests).

## App Store: age rating

Answers: no violence, sexual content, profanity, drugs, gambling, horror or
medical treatment content produced by the app. Messaging and chat: Yes.
User-generated content: Yes, with reporting and blocking. Unrestricted web
access: No. Apple computes the rating (expect 13+ or higher because of messaging);
"Made for Kids": No.

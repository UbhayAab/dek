# Dek store listings (Google Play and App Store)

Texts ready to paste. Everything here describes the real product (APP05, APP14);
screenshots must come from working builds of it. Placeholders an owner must fill
are marked OWNER.

## Google Play

| Field | Value |
|---|---|
| App name (30) | Dek |
| Default language | English (India), en-IN |
| App or game | App |
| Free or paid | Free |
| Category | **Business** (recommended; alternative Communication, see below) |
| Tags | Business communication, Team chat, Messaging |
| Contact email | OWNER: the publisher's support address (not a personal inbox) |
| Website | https://dek-7o4.pages.dev (OWNER: replace with the publisher's own domain when there is one) |
| Privacy policy | https://dek-7o4.pages.dev/privacy.html |
| Account deletion | https://dek-7o4.pages.dev/delete-account.html |

**Short description (80 max, 64 used)**

Internal team chat for Jarurat Care Foundation and Safalta Setu.

**Full description (4000 max)**

Dek is the internal team chat of Jarurat Care Foundation and Safalta Setu. It is
for invited members of these organizations only. There is no public sign-up: your
organization's administrator invites you.

What you can do in Dek:
- Talk in team servers and channels, open to your team or private to the people added.
- Send direct messages and small group messages.
- Reply in threads, react, pin and save messages, and search everything you can see.
- Share photos, videos, voice notes and documents.
- Make voice and video calls, and meet in audio rooms.
- Get notifications for direct messages, mentions and threads you follow, with
  quiet hours and lock screen privacy that you control.

Each organization is separate: members of one organization never see another
organization's conversations. Anyone can report a message or a person, and block
someone; organization administrators review reports.

Privacy: Dek has no ads and no analytics trackers and never sells data. A
conversation is visible only to its members. Delete your account in Settings,
Account, or at https://dek-7o4.pages.dev/delete-account.html. Privacy notice:
https://dek-7o4.pages.dev/privacy.html

**Category recommendation: Business.** Dek is an invitation-only workplace tool
for two organizations; Business is where Slack and Microsoft Teams sit and it
tells reviewers and users that this is not an open consumer messenger.
Communication is defensible too (Google Chat is there), but it suggests open
sign-up. Do not use Medical or Health and Fitness: the NGO runs patient services,
Dek does not (APP05).

**Graphics.** App icon 512 x 512 PNG: `apps/web/public/icons/icon-512.png` is the
512 source (the store icon must be the full square: use `maskable-512.png`).
Feature graphic 1024 x 500: OWNER or design, not made yet. Phone screenshots
(2 to 8, 9:16): take them from the release build with the review account; none
are final yet.

## App Store Connect

| Field | Value |
|---|---|
| Name (30) | Dek (if taken: Dek Team Chat) |
| Subtitle (30) | Team chat for JCF and Safalta |
| Primary language | English (U.K.) or English (U.S.); en-IN is not offered |
| Bundle ID | org.jaruratcare.dek (PROPOSED, see docs/NATIVE.md) |
| SKU | dek-ios-1 |
| Primary category | Business |
| Secondary category | Productivity |
| Price | Free |
| Support URL | OWNER: a support page or contact page of the publisher (required) |
| Marketing URL | optional |
| Privacy policy URL | https://dek-7o4.pages.dev/privacy.html |
| Copyright | OWNER: "2026 <legal publisher name>" once D02 is decided |
| Availability | OWNER (APPQ08): India only, or wider |

**Promotional text (170)**

The team chat of Jarurat Care Foundation and Safalta Setu: channels, direct
messages, threads, files and calls for invited members.

**Description:** the Play full description above.

**Keywords (100)**

team chat,messaging,channels,threads,calls,workplace,NGO,Jarurat Care,Safalta Setu

**Export compliance:** the app uses only standard encryption (HTTPS/TLS through
the operating system and the WebView). `ITSAppUsesNonExemptEncryption` is false in
Info.plist, so no annual self-classification report is asked for.

**Sign in with Apple:** not required. Dek has its own email account system and no
third-party or social login (Guideline 4.8 applies only to apps that offer one).

**Screenshots:** 6.9 inch and 6.5 inch iPhone sets (and 13 inch iPad if iPad stays
enabled) from a real build on a Mac or device. None exist yet: blocked on a Mac.

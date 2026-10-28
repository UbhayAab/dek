# Reviewer access and test notes (APP08, APP15, APP16)

## Review accounts (to be created by the lead, see the request below)

Reviewers never get Ubhay's account or any real member's account. Two dedicated
accounts in the synthetic "Dek QA" organization (no real people's data, every
address is @dek-test.invalid so no mail reaches anyone):

| Account | Use |
|---|---|
| qa-review@dek-test.invalid | the main review login: member of Dek QA, in its servers and channels, with a DM partner who has history |
| qa-review-delete@dek-test.invalid | for testing account deletion, so deleting it does not break the next review |

Their password is NOT the shared QA password and is never written in the repo or
in these notes: it goes only into the store forms (Play "App access", App Store
"App Review Information"), from `.env.local` `DEK_REVIEW_PASSWORD`. Keep the
backend and these accounts untouched while a review is open (do not run
`tools/seed-qa.mjs --wipe`).

## Text for Play "App access" and App Store "Notes for reviewers"

Check every label below against the release build before pasting (the web
screens were still landing when this was written; the sign-in screen, the
paperclip, the message menu and the Account screen match the 2026-10-04 build).

Dek is the internal, invitation-only team chat of Jarurat Care Foundation and
Safalta Setu. There is no public sign-up: members are invited by their
organization. For review, use this account in a test organization that contains
only sample data:

Email: qa-review@dek-test.invalid
Password: (in the password field of this form)

1. Open Dek and sign in with the email and password on the first screen.
2. The test organization "Dek QA" opens. Open a channel in the sidebar to read
   and send messages; open a direct message from the Messages list.
3. Attach a photo or file with the paperclip button in the message box.
4. Calls: open a direct message and press the call button. The other test
   member does not answer automatically; the ringing, cancel and denied
   microphone states can be checked alone.
5. Notifications: the You tab, Settings, Notifications, turn notifications on.
   The system permission prompt appears only after that tap.
6. Report or block: open a message's menu (the three dots), Report; open a
   person's profile, Block. Organization administrators review reports in Admin,
   Reports.
7. Account deletion: the You tab, Settings, Account, "Delete my account". Please use the second
   account for this: qa-review-delete@dek-test.invalid (same password). Deletion
   is also available on the web: https://dek-7o4.pages.dev/delete-account.html

There are no in-app purchases, no ads, and no third-party login.

## TestFlight (iOS) and Play internal testing

**What to test** (paste into TestFlight "What to Test" and the Play release notes):

Dek 2.0.0 (1), first native build. Please check: sign in and sign out; switching
between organizations if you belong to more than one; sending messages, also with
the network turned off and on again (nothing should be lost or sent twice);
photos, files and videos (upload and opening); turning notifications on, then
getting a message while the app is in the background and while it is closed, and
tapping the notification (it must open the right conversation); calls with
microphone allowed and denied; the Android back button; account deletion with a
test account only. Report anything odd with a screenshot to OWNER (feedback
address).

**Feedback email:** OWNER.
**Beta app description:** the Play short description.
**Testers:** OWNER (APPQ07): a small internal group first (5 to 10 people from both
organizations, Android and iPhone), then a wider closed group.

## Request for the lead

Add the two review accounts to `tools/seed-qa.mjs` (role member in Dek QA,
password from a separate `DEK_REVIEW_PASSWORD`, excluded from the shared password
reset), with one DM partner and a few messages so the reviewer sees a live
workspace.

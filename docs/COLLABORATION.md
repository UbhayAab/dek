# Collaboration navigation - 18 October 2026

This release fills four observed gaps in the existing rebuild. It does not claim
full Slack/Discord parity. Existing thread/reply, notification, file, media and
role behavior remains the foundation.

## Catch up

Activity > Mentions and Threads start with Unread. Choose All to revisit history,
Refresh to pick up recent changes, and Load more for older entries. Thread pages
are no longer cut off at 30. Only followed readable threads appear; private,
guest, suspended and tenant boundaries are enforced again on every request.

Mark read is server-confirmed. A thread reads only through its listed reply
snapshot; the list then reloads to retain newer unread replies. A mention reads
through that message in its conversation, including earlier messages there.
Later messages stay unread. Opening a message still returns its original context.

Migrations 0918/0919 add bounded query helpers, covering mention indexes and
context-bound cursors. They leave released list_threads/list_mentions and all
write/permission helpers unchanged. Cursor data is not a signed access capability.
Activity is live, so moving threads may require Refresh while paging.

## Find within a conversation

Open Search this conversation in the conversation header/options menu. Ctrl/Cmd+F
also opens it outside editors and dialogs. Search accepts empty words with a
conversation or person filter. The context return button preserves the original
thread/message route; drafts stay in their existing conversation storage.

Applied query, tab, conversation/person IDs, date range and Has filter are stored
in version-1 search links. Reload, copied links and result/Back retain the scope.
Local filter updates retain phone panel expansion and keyboard focus. Date labels
use the viewer's existing local-calendar semantics. No external search or analytics
service is added. Search words were already explicit in URLs.

Unknown, revoked or wrong-org explicit conversations never fall back to Any.
Malformed scope blocks requests and offers a user-initiated Clear all filters.
Files apply words and conversation only; other criteria are visibly kept for
Messages. Existing retry/rate-limit behavior and current backend ACLs remain.

## Organize channel lists

Named categories now have keyboard/touch disclosure buttons, a controlled hidden
list, 44 px minimum targets and visible focus. Collapsed categories retain unread
conversation and mention counts from readable membership rows. Collapsed current
categories/servers show Current: #channel so a deep-linked destination has a visible
location cue. Expand to reach its row. Uncategorized channels stay directly listed.

Preferences are local to user/org/server/category name. A rename starts expanded;
deleting a category leaves an unused local preference. Storage failure affects only
persistence. No membership, ACL inheritance, notification or synchronization changes.

## References and release evidence

Official user-visible behavior informed original Dek code and design:
- https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions
- https://slack.com/help/articles/202528808-Search-in-Slack
- https://support.discord.com/hc/en-us/articles/360045027712-Inbox-FAQ
- https://support.discord.com/hc/en-us/articles/115001580171-Channel-Categories-101

URL persistence is a Dek design improvement. REA analysis used lawful public SDKs,
not proprietary clients or server internals. Provenance and analysis limits:
C:/Users/abhay/.claude/chief-of-staff/dispatch/2026-10-18/authorized-completion/codex-dek-rea/REPORT.md.
Implementation release/test/live/rollback evidence:
C:/Users/abhay/.claude/chief-of-staff/dispatch/2026-10-18/authorized-completion/codex-dek/REPORT.md.

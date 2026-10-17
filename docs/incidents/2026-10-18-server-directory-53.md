# Fixboard #53: server discovery and combined joining methods

## Cause

The directory API omitted active invite-only servers for ordinary organization
members. Browse primarily listed channels; its secondary server list omitted
joined/partial servers without visible channel rows. The three policy radios
also obscured that invitation links already coexist with approval or open joining.

## Change

Migration 0917 makes all active server metadata discoverable to active, non-guest
members of the same organization. Existing members still see their archived servers
where needed, while Browse hides archived servers. Guests keep explicit channel
access only. The list remains bounded at 200 servers.

The directory lists joined, partial and unjoined servers before channel groups.
Organization and server menus have Browse servers. Server requests show Request
sent after success and after reload, using the caller-specific additive `requested`
field. Membership, channel/roster access and invitation authority stay separate.

Joining methods now displays Invite links plus optional Ask to join or Open.
Selecting one optional method clears the other, so there are at most two methods.
The existing `invite`, `approval` and `open` values are unchanged for older clients.
Existing server policies are not changed automatically. Approval servers still
require approval for invitation holders; the invite dialog makes this explicit.

## Validation

- New regressions reproduce hidden invite-only metadata and missing pending state
  before 0917; tests use the persistent test branch, never a load run on production.
- Test branch was two previously released migrations behind production; 0915 and
  0916 were applied there before 0917. Production already had both.
- Verify ordinary members see active servers including empty/partial servers;
  guests, suspended members, strangers and other tenants do not gain discovery.
- Verify discovery grants no channels, roster, messages, invitation creation or
  Realtime subscription. Requests remain pending until an authorized decision.
- Production smoke uses only Dek QA, saves settings through the UI, reloads the
  pending state, joins an open server and approves a request through server settings.
  Every created QA server is archived through the normal API after proof capture.
- Screenshots at 1280 x 800 and 390 x 844 include directory and method-control
  crops. Check overflow and inspect each image before publishing to Fixboard.

## Rollback

Pre-change web deployment is `ce0e1295` (version `cf5f2d6e7068`). Redeploy that
known artifact if a client rollback is required; do not deploy the retired legacy
app or replace the local rebuild with old remote source.

The exact production preimages of the three replaced functions are saved in
`C:/Users/abhay/.claude/chief-of-staff/dispatch/2026-10-17/fixboard-sweep/codex-dek/pre-migration-functions.sql`.
A database rollback must be a new numbered migration restoring those definitions,
followed by lockdown/schema reload through the migration tool. Never edit an applied
migration. It removes discovery and pending metadata only, without deleting messages,
memberships, invitations or requests.

Release evidence and live limitations are recorded in the worker's REPORT.md and
STATUS.json in that same folder. The pending intern source-publication gap is
preserved: commits stay local, with no push or history rewrite as part of this issue.

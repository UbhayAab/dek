# Server permission updates in the client

The additive Server contract carries the signed-in person's effective action map,
native version, policy-editor access and server moderation state. A native false
overrides an old role or channel-owner guess. Legacy snapshots without a map keep
their conservative existing behavior. Permissions do not grant private-channel
read access, organization powers or announcement-posting rights.

Common server broadcasts are cosmetic fields plus a version marker. The reducer
whitelists these fields and never applies caller-specific roles, permissions or
moderation from a shared payload. A newer marker masks affected UI actions and
requests a coalesced authoritative bootstrap. Own role/control events do the
same. An access-generation check rejects an older in-flight response and retains
the queued follow-up. Only a fresh snapshot clears the stale flag. A separate
roster revision refreshes open lists when somebody else's membership changes.

Message action, reaction and composer paths consume these guards. Pinning keeps
existing joined/announcement restrictions after the independent pin grant.
Deleting somebody else's message requires its own capability. A posting mute
blocks affected content actions and uses the estimated server clock, while
separate management grants remain distinct. Suspension and ban block server
actions. Unrelated servers and direct messages remain isolated. Existing native
checks remain authoritative, including own-message cleanup rules.

One generation-bound in-app timer repaints and refreshes at mute expiry. Long
deadlines re-arm without a network request; resets cancel the timer. There is no
interval poll or assistant schedule. Existing access-revoked cache, subscription,
draft, outbox and media purge paths are retained.

Release verification covers this shared client state together with the settings
editor, member controls, activity view, flat navigation and viewport-safe menus.
Closing #105 requires the normal release and hosted native/browser acceptance.

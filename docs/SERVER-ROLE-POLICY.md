# Server role policy foundation

Fixboard105 defines one policy source per server. Admin remains full control and its permissions are fixed. Only actual server Admins and organization admins manage role policies. Moderator and Member can receive individual server capabilities; guests and people with only shared-channel access receive no server-wide powers.

The closed action set is add_people, remove_people, invite_people, decide_join_requests, create_channels, edit_channels, delete_channels, assign_roles, delete_messages, pin_messages, mute_members, suspend_members, ban_members, edit_server and view_audit. Managing permission policy is reserved to Admin and cannot be delegated through this list.

Defaults retain existing organization settings for channel creation and invitations. Moderator defaults include member removal, message deletion and pinning, without new role or server administration. Member defaults include ordinary pinning and no administrative powers. Explicit per-role overrides replace only their named server actions; a reset restores just the selected role's defaults. Other roles and other servers stay unchanged. No real memberships or settings are rewritten by migration0927.

`get_server_role_permissions105` returns the Admin-only policy editor state: server_id, version, actions, can_manage and roles. Each role contains defaults, overrides, effective and locked. `set_server_role_permissions105` accepts a Moderator/Member map of known boolean actions, an optional expected version and an explicit reset flag. A stale version returns conflict without modifying the accepted policy. Empty or repeated unchanged writes leave version/audit/events unchanged. Actual writes record the actor and old/new override maps.

Server responses add caller-specific permissions, permission_version and can_manage_permissions. Changes broadcast only the server/version marker; each client must reload its own effective map, rather than receiving another person's rights. Existing requested/directory fields are retained.

Native endpoint guards, server controls, the role editor, capability refresh and navigation consume this policy together. A checkbox alone does not establish authorization enforcement. Release acceptance must cover both the native checks and the actual deployed interface.


## Native action integration105

Migration0928 consumes the current policy at server/member/channel/invite/request endpoints. Channel ownership no longer bypasses a server-role action. Private-channel actions require existing visibility or actual administrator status; they never grant message read access. Delegated role managers cannot change self, an organization administrator or a peer/higher server role, or appoint Admins. A Moderator with Assign roles may promote a Member to Moderator. Member role managers cannot promote above Member. Keep one active non-guest server Admin when changing/removing/leaving membership. Server-only actions do not change organization roles. Existing creator-bound server invitations stop granting after their issuer loses Invite people. Organization-level invitation settings and DM behavior remain separate.

Message moderation, mute/suspend/ban controls, scoped activity and the client/editor/tree/menu use the same current permission map. Release verification includes both allowed and refused actions and existing channel constraints.


## Server member controls and activity105

Mute blocks server posting, edits, reactions, pins, new uploads and audio-room participation until its stated expiry; reads and own-message deletion remain available. Unmute is immediate. Suspension denies server content and actions while retaining memberships for restoration. Ban removes server and its channel memberships and blocks old invites or explicit re-adds. Unban permits a deliberate rejoin and does not restore old private channels. Organization status, DMs and other servers are unchanged. Self, organization administrators and server Admins cannot be moderation targets; delegated actors cannot moderate peers. Existing server room participants are moved to Left using existing call and SFU-revocation mechanics. Pending uploads in this server are cancelled on mute/suspension/ban.

Current clients must process server access.revoked and member.upd by purging/reloading their own cache and capability state. Native reads, aggregated search/thread sets, bootstrap, Browse, topic admission and new grants enforce controls. Realtime admission decisions on an already joined socket and signed download URLs have their existing cached/expiry limits; this component does not claim an adversarial socket or previously issued URL is instantly invalidated.

Server activity is a private indexed projection of new normal audit writes from installation onward. View activity permission exposes actor, action, affected person and safe policy/control metadata. It omits private message bodies, channel names/topics, reasons and organization-wide changes. No historical backfill is performed.

Pin permission is checked in addition to existing channel membership and announcement-channel constraints. A channel owner cannot bypass a disabled server-role permission. Native Storage write predicates also recheck current readable access and server moderation for a previously reserved upload.

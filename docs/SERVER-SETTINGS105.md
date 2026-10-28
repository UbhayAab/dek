# Server settings interface

Roles and permissions keeps Admin fixed and offers the fifteen independent
Moderator and Member actions. Only the native policy manager can edit it. Saves
send changed keys and the displayed native version. Version conflicts preserve
drafts until explicit reload; reset uses confirmation and an empty override map.
An Admin draft remains mounted through a temporary permission refresh, with writes
disabled. The policy applies to existing and future channels.

Open server settings consumes the current shared bootstrap, rather than trusting
its older feature cache. Member events refresh the open roster. Native grants
independently control adding/removing people, assigning roles, invites, approvals,
channel creation/edit/delete and server editing/archiving. Optional channel
creation members and automatic joining require their separate grants. Delegated
server invite managers get only a fixed server Member invitation, with no guest,
organization-only or cross-server selection. Existing organization Admin invite
flows remain available to their authorized callers.

Member menus and Member controls provide confirmed mute/unmute, suspend/restore,
ban/unban actions. Self, known Admin and peer protections shape the UI while the
native endpoint remains decisive. A list of active controls includes banned
former members. Unban explicitly permits rejoining without silently restoring
private channels. Mute deadlines use the measured server clock. No interval poll,
assistant schedule, other-server or organization membership change is introduced.

Server activity presents the native safe projection with readable labels and
cursor pagination. Unknown actions get a generic label; arbitrary details and
private content are not rendered. Historical events are not fabricated.

Root authored and tested the staged interface in the existing conversation.
Source and local interaction tests are separate from independent QA or release
evidence. Release acceptance includes flat navigation, viewport-safe menus and
normal native/publication/deployment with hosted browser verification.

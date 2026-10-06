// One typed wrapper per function in docs/CONTRACT.md section 2. Argument names are
// the contract's exactly. Client code calls these and nothing else.
import { rpc, type RpcOptions } from './client';
import type {
  AroundPage, AuditItem, BootstrapResult, BrowseChannel, Call, Channel, ChannelRequest, Delivery, Device, InviteCreated, InvitePreview,
  InviteSummary, JoinRequest, MeResult, MemberItem, Message, MessageContext, MessagePage, NotificationPrefs,
  NotifyLevel, OrgRole, OrgSettings, OrgSummary, Profile, Report, Server, ServerRole, SyncResult, ThreadPage,
  UploadTicket, UUID, ISO,
} from './types';

type Items<T> = { items: T[]; has_more?: boolean; total?: number };

export const api = {
  // 2.1 session and bootstrap
  me: (o?: RpcOptions) => rpc<MeResult>('me', {}, o),
  bootstrap: (org: UUID, o?: RpcOptions) => rpc<BootstrapResult>('bootstrap', { p_org: org }, o),
  getProfiles: (ids: UUID[]) => rpc<Profile[]>('get_profiles', { p_ids: ids }),

  // 2.2 messages
  sendMessage: (a: { channel: UUID; clientId: UUID; body: string; threadRoot?: UUID | null; attachmentIds?: UUID[]; alsoInChannel?: boolean }, o?: RpcOptions) =>
    rpc<Message>('send_message', {
      p_channel: a.channel, p_client_id: a.clientId, p_body: a.body, p_thread_root: a.threadRoot ?? null,
      p_attachment_ids: a.attachmentIds ?? [], p_also_in_channel: a.alsoInChannel ?? false,
    }, o),
  editMessage: (message: UUID, body: string) => rpc<Message>('edit_message', { p_message: message, p_body: body }),
  deleteMessage: (message: UUID, reason: string | null = null) => rpc<Message>('delete_message', { p_message: message, p_reason: reason }),
  toggleReaction: (message: UUID, emoji: string, on: boolean) =>
    rpc<{ message_id: UUID; reactions: Record<string, UUID[]> }>('toggle_reaction', { p_message: message, p_emoji: emoji, p_on: on }),
  listMessages: (channel: UUID, beforeSeq: number | null = null, limit = 50, o?: RpcOptions) =>
    rpc<MessagePage>('list_messages', { p_channel: channel, p_before_seq: beforeSeq, p_limit: limit }, o),
  listMessagesAround: (channel: UUID, seq: number, limit = 50) =>
    rpc<AroundPage>('list_messages_around', { p_channel: channel, p_seq: seq, p_limit: limit }),
  getMessageContext: (message: UUID) => rpc<MessageContext>('get_message_context', { p_message: message }),
  listThread: (root: UUID, afterSeq = 0, limit = 100) =>
    rpc<ThreadPage>('list_thread', { p_root: root, p_after_seq: afterSeq, p_limit: limit }),
  syncChannel: (channel: UUID, afterSeq: number, changedSince: ISO, minSeq = 0, o?: RpcOptions) =>
    rpc<SyncResult>('sync_channel', { p_channel: channel, p_after_seq: afterSeq, p_changed_since: changedSince, p_min_seq: minSeq }, o),
  markRead: (channel: UUID, seq: number) =>
    rpc<{ channel_id: UUID; last_read_seq: number }>('mark_read', { p_channel: channel, p_seq: seq }),
  markUnread: (channel: UUID, seq: number) =>
    rpc<{ channel_id: UUID; last_read_seq: number }>('mark_unread', { p_channel: channel, p_seq: seq }),
  markAllRead: (org: UUID) => rpc<{ count: number }>('mark_all_read', { p_org: org }),
  followThread: (root: UUID, follow: boolean) => rpc<{ root_id: UUID; following: boolean }>('follow_thread', { p_root: root, p_follow: follow }),
  markThreadRead: (root: UUID, seq: number) =>
    rpc<{ root_id: UUID; last_read_reply_seq: number }>('mark_thread_read', { p_root: root, p_seq: seq }),
  listThreads: (org: UUID, limit = 30) =>
    rpc<{ threads: { root: Message; channel: Channel; unread_replies: number; last_reply_at: ISO }[] }>('list_threads', { p_org: org, p_limit: limit }),
  listMentions: (org: UUID, before: ISO | null = null, limit = 30) =>
    rpc<{ items: { message: Message; channel: Channel; read: boolean }[]; has_more: boolean }>('list_mentions', { p_org: org, p_before: before, p_limit: limit }),
  unreadFeed: (org: UUID, limitPerChannel = 20) =>
    rpc<{ channels: { channel: Channel; messages: Message[] }[] }>('unread_feed', { p_org: org, p_limit_per_channel: limitPerChannel }),
  pinMessage: (message: UUID, pinned: boolean) => rpc<{ message_id: UUID; pinned: boolean }>('pin_message', { p_message: message, p_pinned: pinned }),
  listPins: (channel: UUID) => rpc<{ messages: Message[] }>('list_pins', { p_channel: channel }),
  saveMessage: (message: UUID, saved: boolean) => rpc<{ message_id: UUID; saved: boolean }>('save_message', { p_message: message, p_saved: saved }),
  listSaved: (org: UUID, before: ISO | null = null, limit = 30) =>
    rpc<{ items: { message: Message; channel: Channel; saved_at: ISO }[]; has_more: boolean }>('list_saved', { p_org: org, p_before: before, p_limit: limit }),
  search: (a: { org: UUID; query: string; channel?: UUID | null; author?: UUID | null; after?: ISO | null; before?: ISO | null; has?: 'file' | 'link' | 'pin' | null; limit?: number; offset?: number }, o?: RpcOptions) =>
    rpc<{ items: { message: Message; channel: Channel }[]; has_more: boolean }>('search', {
      p_org: a.org, p_query: a.query, p_channel: a.channel ?? null, p_author: a.author ?? null, p_after: a.after ?? null,
      p_before: a.before ?? null, p_has: a.has ?? null, p_limit: a.limit ?? 20, p_offset: a.offset ?? 0,
    }, o),
  searchFiles: (org: UUID, query: string | null, channel: UUID | null = null, limit = 30, offset = 0) =>
    rpc<{ items: { attachment: import('./types').Attachment; message: Message; channel: Channel }[]; has_more: boolean }>('search_files', {
      p_org: org, p_query: query, p_channel: channel, p_limit: limit, p_offset: offset,
    }),
  listChannelFiles: (channel: UUID, before: ISO | null = null, limit = 30) =>
    rpc<{ items: { attachment: import('./types').Attachment; message_id: UUID; author_id: UUID; created_at: ISO }[]; has_more: boolean }>('list_channel_files', {
      p_channel: channel, p_before: before, p_limit: limit,
    }),

  // 2.3 organizations, servers, channels, membership
  createOrg: (name: string, slug: string, shortName: string | null = null, brandColor = '#4F46E5') =>
    rpc<OrgSummary>('create_org', { p_name: name, p_slug: slug, p_short_name: shortName, p_brand_color: brandColor }),
  updateOrg: (org: UUID, patch: Partial<{ name: string; short_name: string; brand_color: string; logo_path: string; settings: Partial<OrgSettings> }>) =>
    rpc<OrgSummary & { settings: OrgSettings }>('update_org', { p_org: org, p_patch: patch }),
  listOrgMembers: (org: UUID, query: string | null = null, role: string | null = null, limit = 50, offset = 0) =>
    rpc<Items<MemberItem>>('list_org_members', { p_org: org, p_query: query, p_role: role, p_limit: limit, p_offset: offset }),
  setOrgRole: (org: UUID, user: UUID, role: OrgRole) => rpc<unknown>('set_org_role', { p_org: org, p_user: user, p_role: role }),
  suspendOrgMember: (org: UUID, user: UUID, suspended: boolean, reason: string | null = null) =>
    rpc<unknown>('suspend_org_member', { p_org: org, p_user: user, p_suspended: suspended, p_reason: reason }),
  removeOrgMember: (org: UUID, user: UUID, ban = false, reason: string | null = null) =>
    rpc<unknown>('remove_org_member', { p_org: org, p_user: user, p_ban: ban, p_reason: reason }),
  leaveOrg: (org: UUID) => rpc<unknown>('leave_org', { p_org: org }),
  listServers: (org: UUID) => rpc<Server[]>('list_servers', { p_org: org }),
  createServer: (org: UUID, name: string, description: string | null = null, joinPolicy: Server['join_policy'] = 'invite', iconEmoji: string | null = null) =>
    rpc<Server>('create_server', { p_org: org, p_name: name, p_description: description, p_join_policy: joinPolicy, p_icon_emoji: iconEmoji }),
  updateServer: (server: UUID, patch: Partial<{ name: string; description: string; icon_emoji: string; join_policy: Server['join_policy']; position: number }>) =>
    rpc<Server>('update_server', { p_server: server, p_patch: patch }),
  archiveServer: (server: UUID, archived: boolean) => rpc<Server>('archive_server', { p_server: server, p_archived: archived }),
  joinServer: (server: UUID) => rpc<{ status: 'joined' | 'pending' }>('join_server', { p_server: server }),
  leaveServer: (server: UUID) => rpc<unknown>('leave_server', { p_server: server }),
  listServerMembers: (server: UUID, query: string | null = null, limit = 50, offset = 0) =>
    rpc<Items<MemberItem>>('list_server_members', { p_server: server, p_query: query, p_limit: limit, p_offset: offset }),
  addServerMembers: (server: UUID, userIds: UUID[], role: ServerRole = 'member') =>
    rpc<unknown>('add_server_members', { p_server: server, p_user_ids: userIds, p_role: role }),
  removeServerMember: (server: UUID, user: UUID) => rpc<unknown>('remove_server_member', { p_server: server, p_user: user }),
  setServerRole: (server: UUID, user: UUID, role: ServerRole) => rpc<unknown>('set_server_role', { p_server: server, p_user: user, p_role: role }),
  // manage: server admins get every channel of the server, private ones they are not in included
  listChannels: (server: UUID, manage = false) => rpc<Channel[]>('list_channels', manage ? { p_server: server, p_manage: true } : { p_server: server }),
  // ids of the caller's saved messages in one org, newest first (at most 2000); saved.upd keeps them current
  listSavedIds: (org: UUID) => rpc<UUID[]>('list_saved_ids', { p_org: org }),
  resolveLegacyMessage: (channel: UUID, legacySeq: number) =>
    rpc<{ org_id: UUID; channel_id: UUID; message_id: UUID; thread_root_id: UUID | null; deleted: boolean }>('resolve_legacy_message', { p_channel: channel, p_legacy_seq: legacySeq }),
  createChannel: (a: { server: UUID; name: string; kind?: 'text' | 'audio'; visibility?: 'public' | 'private'; topic?: string | null; description?: string | null; postingPolicy?: 'everyone' | 'admins'; memberIds?: UUID[]; autoJoin?: boolean; category?: string | null }) =>
    rpc<Channel>('create_channel', {
      p_server: a.server, p_name: a.name, p_kind: a.kind ?? 'text', p_visibility: a.visibility ?? 'public', p_topic: a.topic ?? null,
      p_description: a.description ?? null, p_posting_policy: a.postingPolicy ?? 'everyone', p_member_ids: a.memberIds ?? [],
      p_auto_join: a.autoJoin ?? false, p_category: a.category ?? null,
    }),
  updateChannel: (channel: UUID, patch: Partial<{ name: string; topic: string; description: string; posting_policy: 'everyone' | 'admins'; allow_replies: boolean; allow_reactions: boolean; auto_join: boolean; position: number; category: string | null; visibility: 'private' }>) =>
    rpc<Channel>('update_channel', { p_channel: channel, p_patch: patch }),
  archiveChannel: (channel: UUID, archived: boolean) => rpc<Channel>('archive_channel', { p_channel: channel, p_archived: archived }),
  deleteChannel: (channel: UUID, confirmName: string) =>
    rpc<{ channel_id: UUID; deleted: true }>('delete_channel', { p_channel: channel, p_confirm_name: confirmName }),
  joinChannel: (channel: UUID) => rpc<Channel>('join_channel', { p_channel: channel }),
  leaveChannel: (channel: UUID) => rpc<unknown>('leave_channel', { p_channel: channel }),
  addChannelMembers: (channel: UUID, userIds: UUID[]) => rpc<unknown>('add_channel_members', { p_channel: channel, p_user_ids: userIds }),
  removeChannelMember: (channel: UUID, user: UUID) => rpc<unknown>('remove_channel_member', { p_channel: channel, p_user: user }),
  listChannelMembers: (channel: UUID, query: string | null = null, limit = 100, offset = 0) =>
    rpc<Items<MemberItem>>('list_channel_members', { p_channel: channel, p_query: query, p_limit: limit, p_offset: offset }),
  setChannelNotify: (channel: UUID, level: NotifyLevel, mutedUntil: ISO | null = null) =>
    rpc<{ channel_id: UUID; notify: NotifyLevel; muted_until: ISO | null }>('set_channel_notify', { p_channel: channel, p_level: level, p_muted_until: mutedUntil }),
  openDm: (org: UUID, userIds: UUID[]) => rpc<Channel>('open_dm', { p_org: org, p_user_ids: userIds }),
  hideDm: (channel: UUID) => rpc<unknown>('hide_dm', { p_channel: channel }),

  // 2.4 invites and join requests
  createInvite: (a: { org: UUID; server?: UUID | null; channelIds?: UUID[]; role?: 'member' | 'guest'; email?: string | null; expiresHours?: number | null; maxUses?: number | null; requiresApproval?: boolean }) =>
    rpc<InviteCreated>('create_invite', {
      p_org: a.org, p_server: a.server ?? null, p_channel_ids: a.channelIds ?? [], p_role: a.role ?? 'member', p_email: a.email ?? null,
      p_expires_hours: a.expiresHours ?? null, p_max_uses: a.maxUses ?? null, p_requires_approval: a.requiresApproval ?? false,
    }),
  previewInvite: (code: string) => rpc<InvitePreview>('preview_invite', { p_code: code }),
  acceptInvite: (code: string) =>
    rpc<{ status: 'joined' | 'pending' | 'already_member'; org_id: UUID; server_id: UUID | null }>('accept_invite', { p_code: code }),
  // server: a server admin's view of every invite to that team server
  listInvites: (org: UUID, server?: UUID) =>
    rpc<{ items: InviteSummary[] }>('list_invites', server ? { p_org: org, p_server: server } : { p_org: org }),
  revokeInvite: (invite: UUID) => rpc<unknown>('revoke_invite', { p_invite: invite }),
  listJoinRequests: (org: UUID, status = 'pending') => rpc<{ items: JoinRequest[] }>('list_join_requests', { p_org: org, p_status: status }),
  decideJoinRequest: (request: UUID, approve: boolean) => rpc<unknown>('decide_join_request', { p_request: request, p_approve: approve }),
  // Locked channels (0916)
  browseChannels: (org: UUID) => rpc<{ channels: BrowseChannel[] }>('browse_channels', { p_org: org }),
  requestChannelJoin: (channel: UUID, note: string | null = null) =>
    rpc<{ status: 'joined' | 'pending'; channel_id: UUID; request_id?: UUID }>('request_channel_join', { p_channel: channel, p_note: note }),
  withdrawChannelRequest: (channel: UUID) => rpc<{ status: 'none'; channel_id: UUID }>('withdraw_channel_request', { p_channel: channel }),
  listChannelRequests: (org: UUID) => rpc<{ items: ChannelRequest[] }>('list_channel_requests', { p_org: org }),
  decideChannelRequest: (request: UUID, approve: boolean) =>
    rpc<{ id: UUID; status: 'approved' | 'rejected'; channel_id: UUID; user_id: UUID }>('decide_channel_request', { p_request: request, p_approve: approve }),

  // 2.5 moderation and audit
  report: (a: { kind: 'message' | 'user'; org: UUID; message?: UUID | null; user?: UUID | null; reason: Report['reason']; details?: string | null }) =>
    rpc<{ id: UUID }>('report', { p_kind: a.kind, p_org: a.org, p_message: a.message ?? null, p_user: a.user ?? null, p_reason: a.reason, p_details: a.details ?? null }),
  listReports: (org: UUID, status = 'open', limit = 50, offset = 0) =>
    rpc<Items<Report>>('list_reports', { p_org: org, p_status: status, p_limit: limit, p_offset: offset }),
  resolveReport: (report: UUID, action: 'dismiss' | 'remove_message' | 'suspend_user' | 'remove_user', note: string | null = null) =>
    rpc<unknown>('resolve_report', { p_report: report, p_action: action, p_note: note }),
  blockUser: (user: UUID, blocked: boolean) => rpc<unknown>('block_user', { p_user: user, p_blocked: blocked }),
  listBlocks: () => rpc<{ items: Profile[] }>('list_blocks', {}),
  listAudit: (org: UUID, before: ISO | null = null, limit = 50) =>
    rpc<{ items: AuditItem[]; has_more: boolean }>('list_audit', { p_org: org, p_before: before, p_limit: limit }),

  // 2.6 profile, notifications, devices
  updateProfile: (patch: Partial<{ display_name: string; handle: string | null; title: string | null; timezone: string; avatar_path: string | null }>) =>
    rpc<Profile>('update_profile', { p_patch: patch }),
  setStatus: (text: string | null, emoji: string | null, until: ISO | null) => rpc<Profile>('set_status', { p_text: text, p_emoji: emoji, p_until: until }),
  getNotificationPrefs: () => rpc<NotificationPrefs>('get_notification_prefs', {}),
  setNotificationPrefs: (patch: Partial<NotificationPrefs>) => rpc<NotificationPrefs>('set_notification_prefs', { p_patch: patch }),
  registerPushDevice: (a: { kind: Device['kind']; endpoint: string; p256dh?: string | null; auth?: string | null; label?: string | null; platform?: string | null }) =>
    rpc<Device>('register_push_device', {
      p_kind: a.kind, p_endpoint: a.endpoint, p_p256dh: a.p256dh ?? null, p_auth: a.auth ?? null, p_label: a.label ?? null, p_platform: a.platform ?? null,
    }),
  unregisterPushDevice: (a: { device?: UUID | null; endpoint?: string | null }) =>
    rpc<{ removed: number }>('unregister_push_device', { p_device: a.device ?? null, p_endpoint: a.endpoint ?? null }),
  listMyDevices: () => rpc<Device[]>('list_my_devices', {}),
  sendTestNotification: (device: UUID | null = null) => rpc<{ intent_id: number }>('send_test_notification', { p_device: device }),
  notificationHealth: () => rpc<{ devices: Device[]; recent: Delivery[] }>('notification_health', {}),
  requestAccountDeletion: () => rpc<{ status: 'scheduled' }>('request_account_deletion', {}),

  // 2.7 media
  beginUpload: (channel: UUID, fileName: string, mime: string, size: number, withThumb = false) =>
    rpc<UploadTicket>('begin_upload', { p_channel: channel, p_file_name: fileName, p_mime: mime, p_size: size, p_with_thumb: withThumb }),
  abortUpload: (attachment: UUID) => rpc<{ aborted: boolean }>('abort_upload', { p_attachment: attachment }),

  // 2.8 calls
  startCall: (channel: UUID, media: 'audio' | 'video' = 'audio') => rpc<Call>('start_call', { p_channel: channel, p_media: media }),
  answerCall: (call: UUID, sessionId: UUID) => rpc<Call>('answer_call', { p_call: call, p_session_id: sessionId }),
  declineCall: (call: UUID) => rpc<Call>('decline_call', { p_call: call }),
  joinRoom: (channel: UUID, sessionId: UUID) => rpc<Call>('join_room', { p_channel: channel, p_session_id: sessionId }),
  leaveCall: (call: UUID) => rpc<Call>('leave_call', { p_call: call }),
  callHeartbeat: (call: UUID, sessionId: UUID) => rpc<{ ok: boolean }>('call_heartbeat', { p_call: call, p_session_id: sessionId }),
  getCall: (call: UUID) => rpc<Call>('get_call', { p_call: call }),
  activeCalls: (org: UUID) => rpc<Call[]>('active_calls', { p_org: org }),
};

export type Api = typeof api;

// The shapes of docs/CONTRACT.md section 1. Keep in step with the contract.
export type UUID = string;
export type ISO = string;

export type OrgRole = 'owner' | 'admin' | 'member' | 'guest';
export type ServerRole = 'admin' | 'moderator' | 'member';
export type NotifyLevel = 'default' | 'all' | 'mentions' | 'none';

export interface Profile {
  id: UUID;
  display_name: string;
  handle: string | null;
  avatar_path: string | null;
  title: string | null;
  timezone: string | null;
  status_text: string | null;
  status_emoji: string | null;
  status_until: ISO | null;
  last_active_at: ISO | null;
  deleted: boolean;
}

export interface OrgSummary {
  id: UUID;
  slug: string;
  name: string;
  short_name: string | null;
  brand_color: string;
  logo_path: string | null;
  my_role: OrgRole;
  unread_channels: number;
  mention_count: number;
}

export interface OrgSettings {
  edit_window_minutes: number | null;
  allow_guests: boolean;
  member_can_create_channels: boolean;
  member_can_invite: boolean;
  default_invite_hours: number;
}

export interface Server {
  id: UUID;
  org_id: UUID;
  name: string;
  description: string | null;
  icon_emoji: string | null;
  position: number;
  join_policy: 'open' | 'approval' | 'invite';
  requested?: boolean; // the caller has a pending request to this server
  archived: boolean;
  my_role: ServerRole | null;
  member_count: number;
  // member: joined; partial: reaches only shared channels (guest grants); browse: can see it, not joined
  access: 'member' | 'partial' | 'browse';
}

export type ChannelKind = 'text' | 'audio' | 'dm' | 'group_dm';

export interface ChannelBase {
  id: UUID;
  org_id: UUID;
  server_id: UUID | null;
  kind: ChannelKind;
  name: string | null;
  topic: string | null;
  description: string | null;
  visibility: 'public' | 'private';
  posting_policy: 'everyone' | 'admins';
  allow_replies: boolean;
  allow_reactions: boolean;
  auto_join: boolean;
  archived: boolean;
  position: number;
  category: string | null;
  created_by: UUID | null;
  created_at: ISO;
}

export interface Channel extends ChannelBase {
  member: boolean;
  my_role: 'owner' | 'member' | null;
  notify: NotifyLevel;
  muted_until: ISO | null;
  hidden?: boolean;
  last_seq: number;
  last_read_seq: number;
  unread: number;
  mentions: number;
  last_message_at: ISO | null;
  member_count: number;
  dm_user_ids: UUID[] | null;
}

export interface Attachment {
  id: UUID;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  path: string;
  thumb_path: string | null;
  status: 'pending' | 'ready' | 'rejected';
}

export interface Message {
  id: UUID;
  org_id: UUID;
  channel_id: UUID;
  seq: number;
  thread_root_id: UUID | null;
  author_id: UUID | null;
  kind: 'user' | 'system';
  body: string;
  mentions: UUID[];
  mention_all: boolean;
  client_id: UUID | null;
  created_at: ISO;
  edited_at: ISO | null;
  deleted_at: ISO | null;
  updated_at: ISO;
  reply_count: number;
  last_reply_at: ISO | null;
  reply_user_ids: UUID[];
  reactions: Record<string, UUID[]>;
  attachments: Attachment[];
  pinned: boolean;
  also_in_channel: boolean;
  meta: Record<string, unknown>;
}

export interface InboxCursor {
  v: number; user: UUID; org: UUID; kind: 'threads' | 'mentions'; unread: boolean;
  order: string; at: ISO; id: UUID;
}
export interface ThreadInboxItem {
  root: Message;
  channel: Channel;
  unread_replies: number;
  last_reply_at: ISO | null;
  activity_at: ISO;
  last_reply_seq: number;
}
export interface MentionInboxItem { message: Message; channel: Channel; read: boolean }

export interface CallParticipant {
  user_id: UUID;
  state: 'ringing' | 'joined' | 'left' | 'declined' | 'missed';
  session_id: UUID | null;
  joined_at: ISO | null;
  // 0914: this person's SFU session and the tracks it publishes (mic-N, cam-N, screen-N).
  sfu_session?: string | null;
  sfu_tracks?: string[];
}

export interface Call {
  id: UUID;
  org_id: UUID;
  channel_id: UUID;
  kind: 'direct' | 'room';
  media: 'audio' | 'video';
  started_by: UUID;
  created_at: ISO;
  ended_at: ISO | null;
  end_reason: string | null;
  participants: CallParticipant[];
  // 0914: grows with every call.upd (keep the newest copy); true while the call goes
  // through the SFU (a group call, with the switch on). Absent from older servers.
  version?: number;
  sfu?: boolean;
}

export interface Device {
  id: UUID;
  kind: 'webpush' | 'fcm' | 'apns';
  label: string | null;
  platform: string | null;
  created_at: ISO;
  last_seen_at: ISO | null;
  last_attempt_at: ISO | null;
  last_success_at: ISO | null;
  last_status: string | null;
  failure_count: number;
  enabled: boolean;
}

export interface NotificationPrefs {
  default_level: 'all' | 'mentions' | 'none';
  dm_level: 'all' | 'none';
  thread_replies: boolean;
  quiet_start: string | null;
  quiet_end: string | null;
  quiet_tz: string;
  preview: 'full' | 'name_only' | 'none';
}

export interface MeResult {
  user_id: UUID;
  email: string;
  profile: Profile;
  orgs: OrgSummary[];
  prefs: NotificationPrefs;
  is_platform_admin: boolean;
}

export interface BootstrapResult {
  org: OrgSummary & { settings: OrgSettings };
  servers: Server[];
  channels: Channel[];
  profiles: Profile[];
  topics: string[];
  server_time: ISO;
}

export interface MessagePage {
  messages: Message[];
  has_more: boolean;
  last_seq: number;
}

export interface AroundPage {
  messages: Message[];
  has_more_before: boolean;
  has_more_after: boolean;
  last_seq: number;
}

export interface ThreadPage {
  root: Message;
  replies: Message[];
  has_more: boolean;
  following: boolean;
  last_read_reply_seq: number;
}

export interface SyncResult {
  new: Message[];
  changed: Message[];
  last_seq: number;
  truncated: boolean;
}

export interface MessageContext {
  channel: Channel;
  message: Message;
  thread_root: Message | null;
}

export interface MemberItem {
  profile: Profile;
  role: string;
  status?: string;
  joined_at: ISO;
}

export interface InviteCreated {
  id: UUID;
  code: string;
  expires_at: ISO;
  url_path: string;
}

export interface InviteSummary {
  id: UUID;
  code: string | null;
  server_id: UUID | null;
  role: 'member' | 'guest';
  email: string | null;
  created_by: UUID | null;
  created_at: ISO;
  expires_at: ISO;
  max_uses: number | null;
  use_count: number;
  revoked_at: ISO | null;
  requires_approval: boolean;
}

export interface InvitePreview {
  valid: boolean;
  reason: null | 'expired' | 'revoked' | 'used_up' | 'not_found';
  org_name: string | null;
  org_brand_color: string | null;
  server_name: string | null;
  inviter_name: string | null;
  requires_approval: boolean;
}

export interface JoinRequest {
  id: UUID;
  user: Profile;
  email: string | null;
  server_id: UUID | null;
  invite_id: UUID | null;
  note: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  created_at: ISO;
}

// browse_channels (0916): a light row per channel. locked = private and not a member:
// the name and size show, the topic never does.
export interface BrowseChannel {
  id: UUID;
  server_id: UUID | null;
  name: string | null;
  kind: 'text' | 'audio';
  visibility: 'public' | 'private';
  category: string | null;
  position: number;
  posting_policy: 'everyone' | 'admins';
  member: boolean;
  locked: boolean;
  topic: string | null;
  member_count: number;
  requested: boolean;
}

export interface ChannelRequest {
  id: UUID;
  note: string | null;
  created_at: ISO;
  user: Profile;
  channel: { id: UUID; name: string | null; kind: 'text' | 'audio'; server_id: UUID | null; member_count: number };
}

export interface Report {
  id: UUID;
  kind: 'message' | 'user';
  reason: 'spam' | 'harassment' | 'inappropriate' | 'other';
  details: string | null;
  status: 'open' | 'actioned' | 'dismissed';
  reporter: Profile;
  target_user: Profile | null;
  message: Message | null;
  channel: Channel | null;
  created_at: ISO;
  resolved_by: UUID | null;
  resolved_at: ISO | null;
  resolution: string | null;
}

export interface AuditItem {
  id: number;
  actor: Profile | null;
  action: string;
  target_type: string | null;
  target_id: UUID | null;
  details: Record<string, unknown>;
  created_at: ISO;
}

export interface UploadTicket {
  attachment_id: UUID;
  bucket: 'media';
  path: string;
  thumb_path: string | null;
  max_bytes: number;
  // upload with exactly this Content-Type: the media bucket enforces an allow-list
  mime: string;
}

export interface Delivery {
  created_at: ISO;
  status: string;
  reason: string | null;
  device_id: UUID | null;
  kind: string | null;
}

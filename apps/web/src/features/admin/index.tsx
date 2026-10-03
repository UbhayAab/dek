// OWNER: admin and settings client builder.
import type { AdminSection } from '../../app/router';
export function AdminScreen(_props: { orgId: string; section: AdminSection }) {
  return <main style={{ padding: 24 }}>Admin placeholder.</main>;
}
export function ServerSettingsScreen(_props: { orgId: string; serverId: string }) {
  return <main style={{ padding: 24 }}>Server settings placeholder.</main>;
}
export function ChannelSettingsScreen(_props: { orgId: string; channelId: string }) {
  return <main style={{ padding: 24 }}>Channel settings placeholder.</main>;
}
export function BrowseScreen(_props: { orgId: string; serverId: string | null }) {
  return <main style={{ padding: 24 }}>Browse placeholder.</main>;
}

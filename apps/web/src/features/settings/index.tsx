// OWNER: admin and settings client builder (the health section renders the core
// platform builder's NotificationHealth).
//
// Settings for the signed-in person: profile and status, notifications, health,
// devices, appearance, install, blocked people, account. On phones /settings is a
// menu and each section a second layer with a back button; from 720 px of width
// the menu stays beside the section.
import type { ReactNode } from 'react';
import { useRoute, type SettingsSection } from '../../app/router';
import { Icon } from '../../ui/icons';
import { useMe } from '../admin/common/context';
import { XIcon } from '../admin/common/icons';
import { go, goBack, isBarePath, toHref } from '../admin/common/nav';
import { NavList, Screen, Split, useNarrowRef, type NavItem } from '../admin/common/ui';
import { AccountSection } from './sections/Account';
import { AppearanceSection } from './sections/Appearance';
import { BlockedSection } from './sections/Blocked';
import { DevicesSection } from './sections/Devices';
import { HealthSection } from './sections/Health';
import { InstallSection } from './sections/Install';
import { NotificationsSection } from './sections/Notifications';
import { ProfileSection } from './sections/Profile';
import '../admin/admin.css';
import './settings.css';

// main.tsx applies the stored Appearance choice before the first render.
export { applyStoredTheme } from './theme';

const SECTIONS: readonly { key: SettingsSection; label: string; description: string; icon: ReactNode }[] = [
  { key: 'profile', label: 'Profile and status', description: 'Name, picture, time zone, status', icon: <Icon name="user" /> },
  { key: 'notifications', label: 'Notifications', description: 'What may alert you, quiet hours, previews', icon: <Icon name="bell" /> },
  { key: 'health', label: 'Notification health', description: 'Check this device and send a test', icon: <XIcon name="activity" /> },
  { key: 'devices', label: 'Devices', description: 'Where notifications go', icon: <Icon name="smartphone" /> },
  { key: 'appearance', label: 'Appearance', description: 'Light, dark or like the device', icon: <XIcon name="palette" /> },
  { key: 'install', label: 'Install Dek', description: 'Home Screen and desktop app', icon: <Icon name="download" /> },
  { key: 'blocked', label: 'Blocked people', description: 'People who cannot message you', icon: <XIcon name="ban" /> },
  { key: 'account', label: 'Account', description: 'Sign out, leave, delete account', icon: <Icon name="shield" /> },
];

function body(section: SettingsSection): ReactNode {
  switch (section) {
    case 'notifications': return <NotificationsSection />;
    case 'health': return <HealthSection />;
    case 'devices': return <DevicesSection />;
    case 'appearance': return <AppearanceSection />;
    case 'install': return <InstallSection />;
    case 'blocked': return <BlockedSection />;
    case 'account': return <AccountSection />;
    default: return <ProfileSection />;
  }
}

export function SettingsScreen({ section }: { section: SettingsSection }) {
  const [rootRef, narrow] = useNarrowRef();
  const { me } = useMe();
  useRoute(); // re-render when the address changes between /settings and a section
  // The route has no "menu" section: /settings with nothing after it is the menu.
  const menu = narrow && isBarePath('/settings');
  const label = SECTIONS.find((s) => s.key === section)?.label ?? 'Settings';
  const items: NavItem[] = SECTIONS.map((s) => ({
    key: s.key,
    label: s.label,
    description: s.description,
    icon: s.icon,
    href: toHref({ name: 'settings', section: s.key }),
    onSelect: () => go({ name: 'settings', section: s.key }, 'auto'),
  }));
  const inLayer = narrow && !menu;

  return (
    <Screen
      rootRef={rootRef}
      narrow={narrow}
      title={inLayer ? label : 'Settings'}
      subtitle={me ? me.profile.display_name : undefined}
      backLabel={inLayer ? 'Back to settings' : 'Back to Dek'}
      onBack={inLayer ? () => goBack('/settings') : () => goBack({ name: 'home' })}
      className="set"
    >
      <Split navLabel="Settings sections" mode={menu ? 'nav' : 'content'} nav={<NavList items={items} current={menu ? null : section} />}>
        {body(section)}
      </Split>
    </Screen>
  );
}

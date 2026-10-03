// Notification health (DEK19): the platform builder's NotificationHealth (browser
// support, permission, subscription, last delivery, test notification) inside the
// settings layout. It brings its own heading; this adds the way to the choices.
import { NotificationHealth } from '../../notifications';
import { linkProps } from '../../admin/common/nav';

export function HealthSection() {
  return (
    <div className="set-health-wrap">
      <div className="set-health" data-audit-owner="platform">
        <NotificationHealth />
      </div>
      <p className="ap-hint">
        Which messages may notify you is set in <a {...linkProps({ name: 'settings', section: 'notifications' })}>Notifications</a>.
        Devices that get notifications are listed in <a {...linkProps({ name: 'settings', section: 'devices' })}>Devices</a>.
      </p>
    </div>
  );
}

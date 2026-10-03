// A thin, non-blocking line when the device is offline or the live connection is
// coming back. Reading always stays possible; sends wait in the outbox.
import { useEffect, useState } from 'react';
import { actions, useDek } from '../../store';
import { Icon } from '../../ui/icons';
import { Button } from '../../ui/kit';

const SHOW_RECONNECT_AFTER_MS = 2500;

export function ConnectionBanner() {
  const online = useDek((s) => s.connection.online);
  const realtime = useDek((s) => s.connection.realtime);
  const updateReady = useDek((s) => s.app?.updateReady ?? false);
  const reconnecting = online && (realtime === 'reconnecting' || realtime === 'offline');
  const [showReconnect, setShowReconnect] = useState(false);

  useEffect(() => {
    if (!reconnecting) {
      setShowReconnect(false);
      return undefined;
    }
    // A blip shorter than this is not worth a flash of yellow.
    const t = setTimeout(() => setShowReconnect(true), SHOW_RECONNECT_AFTER_MS);
    return () => clearTimeout(t);
  }, [reconnecting]);

  if (updateReady && online && !showReconnect) {
    // Updates apply only when the person chooses (never mid-message).
    return (
      <div className="dk-connbar dk-connbar--update" role="status">
        <Icon name="download" size={16} />
        <span>A new version of Dek is ready.</span>
        <Button size="md" variant="ghost" onClick={() => { try { actions.applyUpdate(); } catch { window.location.reload(); } }}>Update now</Button>
      </div>
    );
  }
  if (!online) {
    return (
      <div className="dk-connbar dk-connbar--offline" role="status">
        <Icon name="wifiOff" size={16} />
        <span>You are offline. You can keep reading; messages you send will go out when you are back online.</span>
      </div>
    );
  }
  if (showReconnect) {
    return (
      <div className="dk-connbar dk-connbar--reconnecting" role="status">
        <Icon name="refresh" size={16} />
        <span>Reconnecting. New messages will appear in a moment.</span>
      </div>
    );
  }
  return null;
}

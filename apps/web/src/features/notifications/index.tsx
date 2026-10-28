// OWNER: core platform builder. Push permission, subscription, health (DEK14-DEK19).
//
// <NotificationPrompt/>: the small push banner the shell renders: the ask (from a
//   click only), the iPhone Home Screen steps, or how to allow a blocked
//   permission. Renders nothing when there is nothing to say.
// <NotificationHealth/>: the settings "health" section (DEK19).
import './notifications.css';

export { NotificationPrompt } from './Prompt';
export { NotificationHealth } from './Health';

// The top bar of every full screen (views, search, conversations): a back button
// on phones, an icon and title, an optional subtitle, and trailing actions.
import type { ReactNode } from 'react';
import { Icon, type IconName } from '../../ui/icons';
import { IconButton } from '../../ui/kit';

interface Props {
  title: ReactNode;
  icon?: IconName;
  subtitle?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  actions?: ReactNode;
  titleId?: string;
}

export function ScreenHeader({ title, icon, subtitle, onBack, backLabel = 'Back', actions, titleId }: Props) {
  return (
    <header className="dk-screenhead">
      {onBack ? <IconButton icon="chevronLeft" label={backLabel} onClick={onBack} className="dk-screenhead__back" /> : null}
      <div className="dk-screenhead__titles">
        <h1 className="dk-screenhead__title" id={titleId}>
          {icon ? <Icon name={icon} size={18} /> : null}
          <span className="dk-screenhead__text">{title}</span>
        </h1>
        {subtitle ? <p className="dk-screenhead__sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="dk-screenhead__actions">{actions}</div> : null}
    </header>
  );
}

// Appearance: light, dark, or the same as the device. Saved on this device only
// (localStorage dek.theme), applied at once as data-theme on <html>.
import { XIcon, type ExtraIconName } from '../../admin/common/icons';
import { cx, Section } from '../../admin/common/ui';
import { setTheme, useTheme, type ThemeChoice } from '../theme';

const CHOICES: readonly { value: ThemeChoice; label: string; description: string; icon: ExtraIconName }[] = [
  { value: 'light', label: 'Light', description: 'Dark text on light backgrounds.', icon: 'sun' },
  { value: 'dark', label: 'Dark', description: 'Light text on dark backgrounds. Easier at night.', icon: 'moon' },
  { value: 'system', label: 'Same as this device', description: 'Follows your phone or computer setting.', icon: 'monitor' },
];

export function AppearanceSection() {
  const theme = useTheme();
  return (
    <Section title="Appearance" description="Saved on this device only, so your phone and computer can differ.">
      <fieldset className="ap-radios">
        <legend className="ap-legend">Theme</legend>
        <div className="set-themes">
          {CHOICES.map((c) => (
            <label key={c.value} className={cx('set-theme', theme === c.value && 'is-checked')}>
              <input type="radio" name="dek-theme" value={c.value} checked={theme === c.value} onChange={() => setTheme(c.value)}
                aria-labelledby={`set-theme-${c.value}-l`} aria-describedby={`set-theme-${c.value}-d`} />
              <span className={cx('set-theme__swatch', `set-theme__swatch--${c.value}`)} aria-hidden="true">
                <XIcon name={c.icon} size={22} />
              </span>
              <span className="set-theme__text">
                <span className="set-theme__label" id={`set-theme-${c.value}-l`}>{c.label}</span>
                <span className="set-theme__desc" id={`set-theme-${c.value}-d`}>{c.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </Section>
  );
}

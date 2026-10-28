// Appearance: the five shared themes (Fixboard #17), the same choices as Arc, Patient
// Navigator and Fixboard. Saved on this device only (localStorage dek.theme), applied at
// once as data-theme on <html>. Each swatch is drawn from the shared themes.css.
import { cx, Section } from '../../admin/common/ui';
import { setTheme, THEMES, useTheme } from '../theme';

export function AppearanceSection() {
  const theme = useTheme();
  return (
    <Section title="Appearance" description="The same five looks as the other JCF tools. Saved on this device only, so your phone and computer can differ.">
      <fieldset className="ap-radios">
        <legend className="ap-legend">Theme</legend>
        <div className="set-themes">
          {THEMES.map((t) => (
            <label key={t.id} className={cx('set-theme', theme === t.id && 'is-checked')} data-testid={`theme-${t.id}`}>
              <input type="radio" name="dek-theme" value={t.id} checked={theme === t.id} onChange={() => setTheme(t.id)}
                aria-labelledby={`set-theme-${t.id}-l`} aria-describedby={`set-theme-${t.id}-d`} />
              <span className="set-theme__swatch theme-swatch" data-for={t.id} aria-hidden="true" />
              <span className="set-theme__text">
                <span className="set-theme__label" id={`set-theme-${t.id}-l`}>{t.label}</span>
                <span className="set-theme__desc" id={`set-theme-${t.id}-d`}>{t.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </Section>
  );
}

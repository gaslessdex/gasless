import type { Theme } from '../../types/app';

export function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  return (
    <div className="theme-toggle" role="group" aria-label="Color theme">
      <span className={`theme-toggle__indicator is-${theme}`} aria-hidden="true" />
      <button type="button" aria-label="Use light theme" aria-pressed={theme === 'light'} className={theme === 'light' ? 'is-active' : ''} onClick={() => onChange('light')}><span className="theme-word">LIGHT</span><span className="theme-symbol" aria-hidden="true">☼</span></button>
      <button type="button" aria-label="Use dark theme" aria-pressed={theme === 'dark'} className={theme === 'dark' ? 'is-active' : ''} onClick={() => onChange('dark')}><span className="theme-word">DARK</span><span className="theme-symbol" aria-hidden="true">◐</span></button>
    </div>
  );
}

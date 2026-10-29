/** Follow the system theme until the operator chooses an appearance. */
import { useEffect, useRef, useState } from 'react';
import { Moon, Sun } from '@phosphor-icons/react';

type Theme = 'light' | 'dark';
/** Keep browser chrome aligned with the active surface color. */
function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  const color = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
}

export default function ThemeToggle() {
  const explicitChoice = useRef<Theme | null>(null);
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    function sync() {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem('fomo:theme');
      } catch {
        // Appearance still works when browser storage is unavailable.
      }
      const next =
        explicitChoice.current ??
        (saved === 'light' || saved === 'dark' ? saved : media.matches ? 'dark' : 'light');
      applyTheme(next);
      setTheme(next);
    }
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    explicitChoice.current = next;
    applyTheme(next);
    setTheme(next);
    try {
      localStorage.setItem('fomo:theme', next);
    } catch {
      // Keep the selected theme for this page even without persistence.
    }
  }

  return (
    <button
      className="icon-button theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
    </button>
  );
}

// theme.js
// Appearance setting, as in the MSFS Buddy EFB: Automatic follows the device's light/dark setting;
// Light and Dark force one. The choice is applied as <html data-theme="..."> (css/glass.css reads it)
// and kept in this browser only.

const KEY = 'skywatch.appearance';
const CHOICES = ['system', 'light', 'dark'];

export function getAppearance() {
  try {
    const v = localStorage.getItem(KEY);
    return CHOICES.includes(v) ? v : 'system';
  } catch {
    return 'system'; // storage blocked: Automatic
  }
}

// The theme actually showing: the chosen one, or the device's when Automatic.
export function resolvedTheme(appearance = getAppearance()) {
  if (appearance !== 'system') return appearance;
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyAppearance(appearance) {
  const root = document.documentElement;
  if (appearance === 'system') delete root.dataset.theme;
  else root.dataset.theme = appearance;
  // Browser chrome / iOS status bar: the page background of the theme in use.
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.removeAttribute('media'));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolvedTheme(appearance) === 'dark' ? '#000000' : '#f2f2f7');
}

// Wires up the segmented control: <div class="seg" id="appearance"><button data-appearance="system">…
export function initTheme(container, onChange) {
  let current = getAppearance();
  applyAppearance(current);
  const show = () => container?.querySelectorAll('[data-appearance]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.appearance === current)));
  show();
  container?.addEventListener('click', (e) => {
    const choice = e.target.closest('[data-appearance]')?.dataset.appearance;
    if (!CHOICES.includes(choice) || choice === current) return;
    current = choice;
    try {
      localStorage.setItem(KEY, choice);
    } catch {
      // not important: it just won't be remembered
    }
    applyAppearance(choice);
    show();
    onChange?.(resolvedTheme(choice));
  });
  // Automatic: follow the device while the page is open.
  globalThis.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => current === 'system' && applyAppearance('system'));
}

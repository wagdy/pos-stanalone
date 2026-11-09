import { Injectable, signal } from '@angular/core';

export type Theme = 'light' | 'dark';

// Light (Slate & Indigo) or dark, this browser's choice, kept with it: <html data-theme="…">,
// which styles.scss reads.
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<Theme>(read());

  constructor() {
    apply(this.theme());
  }

  toggle(): void {
    this.set(this.theme() === 'dark' ? 'light' : 'dark');
  }

  set(theme: Theme): void {
    this.theme.set(theme);
    apply(theme);
    try {
      localStorage.setItem('pos.theme', theme);
    } catch {
      // This tab only.
    }
  }
}

function read(): Theme {
  try {
    return localStorage.getItem('pos.theme') === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function apply(theme: Theme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset['theme'] = theme;
  }
}

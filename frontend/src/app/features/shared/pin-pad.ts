import { Component, HostListener, effect, input, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

// A four-digit PIN typed on big keys (or the keyboard): dots fill as it is typed, and the fourth
// digit sends it. Wrong, the dots shake and empty. The till's sign-in, the captain's and the kitchen's.
@Component({
  selector: 'app-pin-pad',
  imports: [MatIconModule],
  template: `
    <div class="pin" [class.shake]="shake()">
      <div class="dots" role="status" [attr.aria-label]="digits().length + ' of ' + length() + ' digits'">
        @for (i of slots(); track i) {
          <span class="dot" [class.on]="i < digits().length"></span>
        }
      </div>
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
      <div class="keys">
        @for (k of keys; track k) {
          <button type="button" class="key" (click)="press(k)" [disabled]="disabled()" [attr.aria-label]="'Digit ' + k">{{ k }}</button>
        }
        <button type="button" class="key quiet" (click)="clear()" [disabled]="disabled()" aria-label="Clear"><mat-icon>close</mat-icon></button>
        <button type="button" class="key" (click)="press('0')" [disabled]="disabled()" aria-label="Digit 0">0</button>
        <button type="button" class="key quiet" (click)="back()" [disabled]="disabled()" aria-label="Delete a digit"><mat-icon>backspace</mat-icon></button>
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .pin {
      display: grid;
      justify-items: center;
      gap: 14px;
    }
    .dots {
      display: flex;
      gap: 14px;
      height: 20px;
    }
    .dot {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      border: 2px solid var(--mat-sys-outline);
      transition: background-color 120ms ease, transform 120ms ease;
    }
    .dot.on {
      background: var(--mat-sys-primary);
      border-color: var(--mat-sys-primary);
      transform: scale(1.1);
    }
    .error {
      margin: 0;
      color: var(--mat-sys-error);
      font: var(--mat-sys-body-medium);
      text-align: center;
    }
    .keys {
      display: grid;
      grid-template-columns: repeat(3, 76px);
      gap: 12px;
    }
    .key {
      height: 64px;
      border: 1px solid var(--app-line, #e2e8f0);
      border-radius: 18px;
      background: var(--mat-sys-surface-container-lowest);
      color: var(--mat-sys-on-surface);
      font: 600 26px/1 var(--app-font, inherit);
      cursor: pointer;
      touch-action: manipulation;
      transition: background-color 100ms ease, transform 80ms ease;
      box-shadow: 0 1px 2px rgb(15 23 42 / 6%);
    }
    .key:hover {
      background: var(--mat-sys-surface-container);
    }
    .key:active {
      transform: scale(0.95);
      background: var(--mat-sys-primary-container);
    }
    .key:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .key.quiet {
      background: transparent;
      box-shadow: none;
      border-color: transparent;
      color: var(--mat-sys-on-surface-variant);
    }
    .shake {
      animation: pin-shake 360ms ease;
    }
    @keyframes pin-shake {
      20%,
      60% {
        transform: translateX(-8px);
      }
      40%,
      80% {
        transform: translateX(8px);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .shake {
        animation: none;
      }
    }
  `,
})
export class PinPad {
  readonly length = input(4);
  readonly disabled = input(false);
  // A wrong PIN's message: the dots shake and empty when it is set.
  readonly error = input<string | null>(null);
  readonly entered = output<string>();

  protected readonly keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  protected readonly digits = signal('');
  protected readonly shake = signal(false);
  protected readonly slots = () => Array.from({ length: this.length() }, (_, i) => i);

  constructor() {
    effect(() => {
      if (this.error()) {
        this.digits.set('');
        this.shake.set(true);
        setTimeout(() => this.shake.set(false), 400);
      }
    });
  }

  @HostListener('window:keydown', ['$event'])
  protected key(event: KeyboardEvent): void {
    if ((event.target as HTMLElement)?.tagName === 'INPUT' || document.querySelector('.cdk-overlay-container .mat-mdc-dialog-container')) return;
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      this.press(event.key);
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      this.back();
    } else if (event.key === 'Escape') {
      this.clear();
    }
  }

  protected press(digit: string): void {
    if (this.disabled() || this.digits().length >= this.length()) return;
    const next = this.digits() + digit;
    this.digits.set(next);
    if (next.length === this.length()) {
      this.entered.emit(next);
      // Emptied for the next one; a wrong one also empties through the error.
      setTimeout(() => this.digits.set(''), 150);
    }
  }

  protected back(): void {
    this.digits.update((d) => d.slice(0, -1));
  }

  protected clear(): void {
    this.digits.set('');
  }
}

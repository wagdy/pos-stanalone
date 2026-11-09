import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { AuthService } from '../../core/auth/auth.service';
import { Permission } from '../../core/auth/permissions';
import { errorMessage } from '../../core/http/error-message';
import { LiveService } from '../../core/pos/live.service';
import { Company } from '../../core/settings/company';
import { PinPad } from '../shared/pin-pad';

// A full-screen station (the captain's phone, the kitchen screen) behind a PIN: whoever holds one
// that may work it is let in, and the live line opens; anyone else is told so and the pad stays.
@Component({
  selector: 'app-staff-gate',
  imports: [MatButtonModule, MatIconModule, PinPad],
  template: `
    @if (allowed()) {
      <ng-content />
    } @else {
      <main class="gate">
        <section class="card">
          <div class="mark"><mat-icon>{{ icon() }}</mat-icon></div>
          <h1>{{ titleEn() }} <span class="ar">{{ titleAr() }}</span></h1>
          <p class="muted">{{ company.name() }}</p>
          @if (auth.isSignedIn()) {
            <p class="denied" role="alert">{{ auth.me()?.fullName }} does not work this screen. Another PIN? · ليس لديك صلاحية</p>
          }
          <app-pin-pad [disabled]="busy()" [error]="error()" (entered)="enter($event)" />
        </section>
      </main>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .gate {
      display: grid;
      place-items: center;
      min-height: 100dvh;
      padding: 16px;
      box-sizing: border-box;
      background:
        radial-gradient(50rem 30rem at 0% 0%, color-mix(in srgb, var(--mat-sys-primary) 14%, transparent), transparent 60%),
        var(--mat-sys-surface-container-low);
    }
    .card {
      display: grid;
      justify-items: center;
      gap: 6px;
      width: min(380px, 100%);
      padding: 28px 20px;
      box-sizing: border-box;
      border-radius: 28px;
      background: var(--mat-sys-surface-container-lowest);
      box-shadow: var(--app-card-shadow);
    }
    .mark {
      display: grid;
      place-items: center;
      width: 56px;
      height: 56px;
      border-radius: 18px;
      background: var(--mat-sys-primary);
      color: var(--mat-sys-on-primary);
    }
    h1 {
      margin: 8px 0 0;
      font: var(--mat-sys-headline-small);
      font-weight: 650;
    }
    .ar {
      direction: rtl;
      unicode-bidi: isolate;
      opacity: 0.75;
    }
    .muted {
      margin: 0 0 12px;
      color: var(--mat-sys-on-surface-variant);
    }
    .denied {
      color: var(--mat-sys-error);
      text-align: center;
    }
  `,
})
export class StaffGate {
  protected readonly auth = inject(AuthService);
  protected readonly company = inject(Company);
  private readonly live = inject(LiveService);

  readonly titleEn = input.required<string>();
  readonly titleAr = input.required<string>();
  readonly icon = input('lock');
  readonly permission = input.required<Permission>();

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly allowed = computed(() => this.auth.isSignedIn() && this.auth.can(this.permission()));

  constructor() {
    effect(() => {
      if (this.allowed()) void this.live.start();
    });
  }

  protected async enter(pin: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.signInWithPin(pin);
    } catch (error) {
      this.error.set(errorMessage(error, 'That PIN is not right.'));
    } finally {
      this.busy.set(false);
    }
  }
}

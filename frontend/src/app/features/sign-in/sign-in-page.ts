import { Component, ViewEncapsulation, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { homeFor } from '../../core/auth/guards';
import { errorMessage } from '../../core/http/error-message';
import { Company } from '../../core/settings/company';
import { PinPad } from '../shared/pin-pad';

// The sign-in: at a terminal, the four-digit PIN on a pad; a manager may sign in with their email
// and password instead. Each goes on to their role's screen: the terminal, the captain's tables or
// the kitchen screen.
//
// Unencapsulated, to style the Material fields inside; every rule is under .sign-in.
@Component({
  selector: 'app-sign-in-page',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, MatProgressSpinnerModule, PinPad],
  templateUrl: './sign-in-page.html',
  styleUrl: './sign-in-page.scss',
  encapsulation: ViewEncapsulation.None,
})
export class SignInPage {
  protected readonly company = inject(Company);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  // ?reason=expired, when the API stopped accepting the last session.
  readonly reason = input<string>();

  // The PIN pad first; the email and password for a manager away from a terminal.
  protected readonly mode = signal<'pin' | 'password'>('pin');
  protected readonly pinError = signal<string | null>(null);
  protected readonly login = signal('');
  protected readonly secret = signal('');
  protected readonly showSecret = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  // The company's mark when it has no logo: its name's first letters.
  protected readonly initials = computed(() =>
    this.company
      .name()
      .split(/[\s&·-]+/)
      .filter((word) => /^\p{L}/u.test(word))
      .slice(0, 2)
      .map((word) => word[0].toUpperCase())
      .join(''),
  );

  protected async submit(): Promise<void> {
    if (this.busy()) {
      return;
    }
    const login = this.login().trim();
    if (!login || !this.secret()) {
      this.error.set('Enter your email and your password.');
      return;
    }
    if (!login.includes('@')) {
      this.error.set('Enter your email: it has an @ in it.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const me = await this.auth.signIn(login, this.secret());
      await this.router.navigate([homeFor(me.role)]);
    } catch (error) {
      this.error.set(errorMessage(error, 'Sign-in failed.'));
      this.secret.set('');
    } finally {
      this.busy.set(false);
    }
  }

  protected async signInWithPin(pin: string): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    this.pinError.set(null);
    try {
      const me = await this.auth.signInWithPin(pin);
      await this.router.navigate([homeFor(me.role)]);
    } catch (error) {
      this.pinError.set(errorMessage(error, 'That PIN is not right.'));
    } finally {
      this.busy.set(false);
    }
  }
}

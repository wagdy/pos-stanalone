import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { UserRole } from '../api/models';
import { AuthService } from './auth.service';
import { Permission } from './permissions';

// Where a user lands, by their role: the cashier's terminal, the captain's tables on the phone, or
// the kitchen screen.
export const homePath = '/';

export function homeFor(role: UserRole | undefined): string {
  switch (role) {
    case 'Captain':
      return '/pos/captain';
    case 'Kitchen':
      return '/pos/kds';
    default:
      return '/pos/terminal';
  }
}

// Signed in, as /api/auth/me confirmed at start-up or sign-in.
export const signedInGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.isSignedIn() ? true : inject(Router).createUrlTree(['/sign-in']);
};

// The sign-in: one already signed in goes on to their screen.
export const signedOutGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.isSignedIn() ? inject(Router).createUrlTree([homeFor(auth.me()?.role)]) : true;
};

// The bare address: on to the screen of the role signed in.
export const homeGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return inject(Router).createUrlTree([auth.isSignedIn() ? homeFor(auth.me()?.role) : '/sign-in']);
};

// A section only some roles have: its link is hidden from the rest, and this keeps a typed
// address from opening it. The API refuses the data either way.
export const permissionGuard =
  (permission: Permission): CanActivateFn =>
  () => {
    const auth = inject(AuthService);
    return auth.can(permission) ? true : inject(Router).createUrlTree([homeFor(auth.me()?.role)]);
  };

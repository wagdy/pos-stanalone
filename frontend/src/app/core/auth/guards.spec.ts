import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree, provideRouter } from '@angular/router';
import { UserRole } from '../api/models';
import { AuthService } from './auth.service';
import { homeFor, homeGuard, permissionGuard, signedInGuard, signedOutGuard } from './guards';
import { Permissions } from './permissions';

describe('the section guards', () => {
  function run(guard: () => unknown, auth: { signedIn?: boolean; can?: (p: string) => boolean; role?: UserRole }): string | boolean {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: AuthService,
          useValue: { me: () => (auth.role ? { role: auth.role } : null), isSignedIn: () => auth.signedIn ?? true, can: auth.can ?? (() => true) },
        },
      ],
    });
    const result = TestBed.runInInjectionContext(guard) as boolean | UrlTree;
    return typeof result === 'boolean' ? result : TestBed.inject(Router).serializeUrl(result);
  }

  const route = {} as ActivatedRouteSnapshot;
  const state = {} as RouterStateSnapshot;

  it('sends each role home to its own screen', () => {
    expect([homeFor('Manager'), homeFor('Cashier'), homeFor('Captain'), homeFor('Kitchen')]).toEqual(['/pos/terminal', '/pos/terminal', '/pos/captain', '/pos/kds']);
    expect(run(() => homeGuard(route, state), { role: 'Kitchen' })).toBe('/pos/kds');
    expect(run(() => homeGuard(route, state), { signedIn: false })).toBe('/sign-in');
  });

  it('lets a manager into the setup and the staff', () => {
    expect(run(() => permissionGuard(Permissions.SetupManage)(route, state), { role: 'Manager' })).toBe(true);
    expect(run(() => permissionGuard(Permissions.UsersManage)(route, state), { role: 'Manager' })).toBe(true);
  });

  // A captain who typed the address goes back to their tables.
  it('sends a captain from a manager’s section back to their own screen', () => {
    const captain = new Set<string>([Permissions.OrdersTake]);
    expect(run(() => permissionGuard(Permissions.SetupManage)(route, state), { role: 'Captain', can: (p) => captain.has(p) })).toBe('/pos/captain');
  });

  it('sends whoever is not signed in to sign in, and whoever is away from it', () => {
    expect(run(() => signedInGuard(route, state), { signedIn: false })).toBe('/sign-in');
    expect(run(() => signedOutGuard(route, state), { signedIn: true, role: 'Cashier' })).toBe('/pos/terminal');
  });
});

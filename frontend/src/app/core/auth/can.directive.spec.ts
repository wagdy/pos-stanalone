import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Me } from '../api/models';
import { cashierMe, managerMe } from '../../../testing/fixtures';
import { AuthService } from './auth.service';
import { CanDirective } from './can.directive';
import { Permissions } from './permissions';

@Component({
  imports: [CanDirective],
  template: `
    <button *appCan="P.OrdersSettle" id="change">Pay</button>
    <button *appCan="P.OrdersAuthorize" id="approve">Void after</button>
    <a *appCan="P.UsersManage" id="users">Staff</a>
    <span *appCan="[P.OrdersAuthorize, P.UsersManage]" id="any-manager">manager</span>
  `,
})
class Screen {
  protected readonly P = Permissions;
}

describe('role-based buttons', () => {
  let auth: AuthService;
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  // The sign-in response is answered with a manager's rights on purpose: the app must ignore it
  // and believe only GET /api/auth/me.
  async function signInAs(me: Me): Promise<void> {
    const signedIn = me.email ? auth.signIn(me.email, 'a-password') : auth.signInWithPin('2468');
    const signIn = http.expectOne(me.email ? '/api/auth/sign-in' : '/api/auth/pin');
    expect(signIn.request.body).toEqual(me.email ? { email: me.email, password: 'a-password' } : { pin: '2468' });
    signIn.flush({ token: 'token-' + me.id, expiresAtUtc: '2026-10-04T00:00:00Z', user: managerMe });
    await new Promise((resolve) => setTimeout(resolve));
    const meRequest = http.expectOne('/api/auth/me');
    expect(meRequest.request.headers.has('Authorization')).toBe(false); // the interceptor is not in this test bed
    meRequest.flush(me);
    await signedIn;
  }

  async function render(): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(Screen);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('takes the role from /api/auth/me, never from the sign-in response', async () => {
    await signInAs(cashierMe);

    expect(auth.me()?.role).toBe('Cashier');
    expect(auth.can(Permissions.UsersManage)).toBe(false);
    expect(auth.can(Permissions.OrdersSettle)).toBe(true);
    expect(localStorage.getItem('pos.token')).toBe('token-user-cashier');
  });

  it('shows a cashier what they settle, and nothing a manager decides', async () => {
    await signInAs(cashierMe);
    const screen = await render();

    expect(screen.querySelector('#change')).not.toBeNull();
    expect(screen.querySelector('#approve')).toBeNull();
    expect(screen.querySelector('#users')).toBeNull();
    expect(screen.querySelector('#any-manager')).toBeNull();
  });

  it('gives a manager everything', async () => {
    await signInAs(managerMe);
    const screen = await render();

    for (const id of ['change', 'approve', 'users', 'any-manager']) {
      expect(screen.querySelector('#' + id), id).not.toBeNull();
    }
  });

  it('keeps the new token when the password is changed, and asks who it is again', async () => {
    await signInAs(managerMe);

    const changed = auth.changePassword('a-password', 'a-better-one');
    const request = http.expectOne('/api/auth/password');
    expect(request.request.body).toEqual({ currentPassword: 'a-password', newPassword: 'a-better-one' });
    request.flush({ token: 'token-new', expiresAtUtc: '2026-10-04T00:00:00Z', user: managerMe });
    await new Promise((resolve) => setTimeout(resolve));
    http.expectOne('/api/auth/me').flush(managerMe);
    await changed;

    expect(auth.token()).toBe('token-new');
    expect(localStorage.getItem('pos.token')).toBe('token-new');
  });
});

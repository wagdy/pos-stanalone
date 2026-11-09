import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialog } from '@angular/material/dialog';
import { of } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { NotifyService } from '../../core/ui/notify.service';
import { User, UsersApi } from '../../core/users/users.api';
import { managerMe } from '../../../testing/fixtures';
import { UserDialog } from './user-dialogs';
import { UsersPage } from './users-page';

const text = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();

function aUser(overrides: Partial<User>): User {
  return {
    id: 'u', email: null, fullName: 'U', role: 'Cashier', isActive: true, hasPin: true, hasPassword: false, employeeId: null,
    createdAtUtc: '2026-10-01T08:00:00Z', lastSignInAtUtc: null, isLocked: false, ...overrides,
  };
}

const omar = aUser({ id: managerMe.id, email: 'omar@example.com', fullName: 'Omar', role: 'Manager', hasPassword: true, lastSignInAtUtc: '2026-10-26T08:00:00Z' });
const mona = aUser({ id: 'mona', fullName: 'Mona', isLocked: true });
const karim = aUser({ id: 'karim', fullName: 'Karim', role: 'Captain', isActive: false });

describe('the users', () => {
  const api = { all: vi.fn(), create: vi.fn(), update: vi.fn(), resetPassword: vi.fn(), resetPin: vi.fn() };
  const open = vi.fn();
  const notify = { info: vi.fn(), error: vi.fn() };

  async function render() {
    TestBed.configureTestingModule({
      providers: [
        { provide: UsersApi, useValue: api },
        { provide: MatDialog, useValue: { open } },
        { provide: NotifyService, useValue: notify },
        { provide: AuthService, useValue: { me: signal(managerMe) } },
      ],
    });
    const fixture = TestBed.createComponent(UsersPage);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const refresh = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const button = (within: Element, label: string) => [...within.querySelectorAll('button')].find((b) => text(b).includes(label))!;
    return { el, refresh, button };
  }

  beforeEach(() => {
    api.all.mockReset().mockReturnValue(of([karim, mona, omar]));
    api.create.mockReset();
    api.update.mockReset();
    api.resetPassword.mockReset().mockReturnValue(of(undefined));
    api.resetPin.mockReset().mockReturnValue(of(undefined));
    open.mockReset();
    notify.info.mockReset();
  });

  const rows = (el: HTMLElement) => [...el.querySelectorAll('tbody tr')].map((r) => text(r.querySelector('td')!));

  it('lists the active first, managers before cashiers, and says who is locked or deactivated', async () => {
    const { el } = await render();

    expect(rows(el)).toEqual(['Omar You', 'Mona Locked: too many wrong tries', 'Karim Deactivated']);
  });

  it('adds a cashier with the PIN they sign in with', async () => {
    const asked = { email: null, fullName: 'Sara', role: 'Cashier', password: null, pin: '2468' };
    open.mockReturnValue({ afterClosed: () => of(asked) });
    api.create.mockReturnValue(of(aUser({ id: 'sara', fullName: 'Sara' })));
    const { el, refresh, button } = await render();

    button(el, 'Add staff').click();
    await refresh();

    expect(api.create).toHaveBeenCalledWith(asked);
    expect(rows(el)).toContain('Sara');
    expect(notify.info).toHaveBeenCalledWith('Sara signs in with their PIN.');
  });

  it('sets a new PIN, which lifts the lockout; a password is a manager’s alone', async () => {
    open.mockReturnValue({ afterClosed: () => of('8642') });
    const { el, refresh, button } = await render();
    const monaRow = el.querySelectorAll('tbody tr')[1];
    expect(button(monaRow, 'New password')).toBeUndefined();

    button(monaRow, 'New PIN').click();
    await refresh();

    expect(api.resetPin).toHaveBeenCalledWith('mona', '8642');
    expect(rows(el)[1]).toBe('Mona');
  });

  it('sets a manager a new password', async () => {
    open.mockReturnValue({ afterClosed: () => of('a-new-pass') });
    const { el, refresh, button } = await render();

    button(el.querySelectorAll('tbody tr')[0], 'New password').click();
    await refresh();

    expect(api.resetPassword).toHaveBeenCalledWith(managerMe.id, 'a-new-pass');
  });

  it('keeps a manager from taking their own rights away in the form', async () => {
    open.mockReturnValue({ afterClosed: () => of(undefined) });
    const { el, button } = await render();

    button(el.querySelectorAll('tbody tr')[0], 'Change').click();

    expect(open.mock.lastCall![1].data).toEqual({ user: omar, self: true });
  });
});

describe('the user form', () => {
  function form(data: object) {
    TestBed.configureTestingModule({ providers: [{ provide: MAT_DIALOG_DATA, useValue: data }] });
    const fixture = TestBed.createComponent(UserDialog);
    fixture.detectChanges();
    return fixture.componentInstance as unknown as Record<string, any>;
  }

  it('asks a new cashier for a four-digit PIN, and no email', () => {
    const dialog = form({});
    dialog['fullName'] = 'Sara';
    dialog['pin'] = '24';
    expect(dialog['ready']()).toBe(false);

    dialog['pin'] = '2468';
    expect(dialog['ready']()).toBe(true);
    expect(dialog['result']()).toEqual({ email: null, fullName: 'Sara', role: 'Cashier', password: null, pin: '2468' });
  });

  it('asks a new manager for an email and a password long enough; the PIN may wait', () => {
    const dialog = form({});
    dialog['fullName'] = 'Sara';
    dialog['role'] = 'Manager';
    dialog['password'] = 'long-enough';
    expect(dialog['ready']()).toBe(false);

    dialog['email'] = 'sara@example.com';
    expect(dialog['ready']()).toBe(true);
    expect(dialog['result']()).toEqual({ email: 'sara@example.com', fullName: 'Sara', role: 'Manager', password: 'long-enough', pin: null });
  });

  it('changes someone without a password, active or not', () => {
    const dialog = form({ user: mona });
    dialog['isActive'] = false;

    expect(dialog['ready']()).toBe(true);
    expect(dialog['result']()).toEqual({ email: null, fullName: 'Mona', role: 'Cashier', isActive: false });
  });
});

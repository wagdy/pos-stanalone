import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthService } from '../../core/auth/auth.service';
import { NotifyService } from '../../core/ui/notify.service';
import { cashierMe, managerMe } from '../../../testing/fixtures';
import { Me } from '../../core/api/models';
import { AccountPage } from './account-page';

const text = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();

describe('their own account', () => {
  const changePassword = vi.fn();
  const notify = { info: vi.fn(), error: vi.fn() };

  async function render(me: Me = managerMe) {
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { me: signal(me), changePassword } },
        { provide: NotifyService, useValue: notify },
      ],
    });
    const fixture = TestBed.createComponent(AccountPage);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const type = (name: string, value: string) => {
      const input = el.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    const send = async () => {
      el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    return { el, type, send };
  }

  beforeEach(() => {
    changePassword.mockReset().mockResolvedValue(undefined);
    notify.info.mockReset();
  });

  it('says who they are; one signing in by PIN alone has no password to change', async () => {
    const { el } = await render(cashierMe);

    expect([...el.querySelectorAll('.who dt, .who dd')].map(text)).toEqual([
      'Name', 'Mona', 'Email', '—', 'PIN', 'Set: you sign in at the terminals with it', 'Role', 'Cashierكاشير',
    ]);
    expect(el.querySelector('form')).toBeNull();
  });

  it('changes the password with the current one, typed twice the same', async () => {
    const { el, type, send } = await render();

    type('current', 'change-me-now');
    type('next', 'a-better-one');
    type('again', 'a-better-on');
    await send();
    expect(text(el.querySelector('.error')!)).toBe('The new password is not the same both times.');
    expect(changePassword).not.toHaveBeenCalled();

    type('again', 'a-better-one');
    await send();
    expect(changePassword).toHaveBeenCalledWith('change-me-now', 'a-better-one');
    expect(notify.info).toHaveBeenCalledWith('Password changed. You are signed out everywhere else.');
    expect(el.querySelector('.error')).toBeNull();
  });

  it('says what the API said when the current one is wrong', async () => {
    changePassword.mockRejectedValue(new HttpErrorResponse({ status: 400, error: { detail: 'Your current password is not right.' } }));
    const { el, type, send } = await render();

    type('current', 'not-it-at-all');
    type('next', 'a-better-one');
    type('again', 'a-better-one');
    await send();

    expect(text(el.querySelector('.error')!)).toBe('Your current password is not right.');
  });
});

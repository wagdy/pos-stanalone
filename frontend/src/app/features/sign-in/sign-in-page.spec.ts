import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Router, UrlTree, provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { signedOutGuard } from '../../core/auth/guards';
import { Company } from '../../core/settings/company';
import { aCompany, captainMe, managerMe } from '../../../testing/fixtures';
import { SignInPage } from './sign-in-page';

const text = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();

describe('the sign-in', () => {
  const signIn = vi.fn();
  const signInWithPin = vi.fn();

  async function render(reason?: string) {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthService, useValue: { me: () => null, signIn, signInWithPin, can: () => true } }],
    });
    TestBed.inject(Company).settings.set(aCompany({ name: 'Otantik Kitchen' }));
    const fixture = TestBed.createComponent(SignInPage);
    if (reason) {
      fixture.componentRef.setInput('reason', reason);
    }
    fixture.detectChanges();
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const field = (name: string) => el.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
    const type = async (name: string, value: string) => {
      field(name).value = value;
      field(name).dispatchEvent(new Event('input'));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const send = async () => {
      el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      await fixture.whenStable();
      fixture.detectChanges();
      // ngModel writes a field's new value on the turn after.
      await fixture.whenStable();
    };
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const settle = async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    // The manager's way in: the email and the password.
    const withPassword = async () => {
      [...el.querySelectorAll<HTMLButtonElement>('button.switch')].find((b) => text(b).includes('email'))!.click();
      await settle();
    };
    const digits = async (pin: string) => {
      for (const d of pin) el.querySelector<HTMLButtonElement>(`button[aria-label="Digit ${d}"]`)!.click();
      await settle();
    };
    return { el, field, type, send, navigate, withPassword, digits, settle };
  }

  // A block: a function handed back from beforeEach would be called as its teardown.
  beforeEach(() => {
    signIn.mockReset().mockResolvedValue(managerMe);
    signInWithPin.mockReset().mockResolvedValue(captainMe);
  });

  it('asks for a PIN on a pad, under the company’s name', async () => {
    const { el } = await render();

    expect(el.querySelectorAll('app-pin-pad .key')).toHaveLength(12);
    expect(el.querySelectorAll('.dots .dot')).toHaveLength(4);
    expect(el.querySelector('form')).toBeNull();
    // The company: its initials in place of a logo, its name, and the system's.
    expect(text(el.querySelector('.mark')!)).toBe('OK');
    expect(text(el.querySelector('h1')!)).toBe('Otantik Kitchen');
    expect(text(el.querySelector('.product')!)).toBe('Restaurant POS نقطة البيع');
  });

  it('signs in with the fourth digit, and sends each to their role’s screen', async () => {
    const { digits, navigate } = await render();

    await digits('2468');

    expect(signInWithPin).toHaveBeenCalledWith('2468');
    expect(navigate).toHaveBeenCalledWith(['/pos/captain']);
  });

  it('says a wrong PIN is wrong, and takes another', async () => {
    signInWithPin.mockRejectedValue(new HttpErrorResponse({ status: 401, error: { detail: 'That PIN is not right.' } }));
    const { el, digits, navigate } = await render();

    await digits('0000');

    expect(text(el.querySelector('app-pin-pad .error')!)).toBe('That PIN is not right.');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('gives a manager the email and the password, in one form', async () => {
    const { el, withPassword } = await render();
    await withPassword();

    expect([...el.querySelectorAll('mat-label')].map(text)).toEqual(['Email · البريد الإلكتروني', 'Password · كلمة المرور']);
    expect(el.querySelectorAll('form')).toHaveLength(1);
    expect(el.querySelector('app-pin-pad')).toBeNull();
  });

  it('signs a manager in with their email and password, and goes to the terminal', async () => {
    const { type, send, navigate, withPassword } = await render();
    await withPassword();

    await type('login', '  omar@example.com ');
    await type('secret', 'change-me-now');
    await send();

    expect(signIn).toHaveBeenCalledWith('omar@example.com', 'change-me-now');
    expect(navigate).toHaveBeenCalledWith(['/pos/terminal']);
  });

  it('sends nothing until both are there, and an email it can tell', async () => {
    const { el, type, send, withPassword } = await render();
    await withPassword();

    await type('login', 'omar@example.com');
    await send();
    expect(text(el.querySelector('.error > span')!)).toBe('Enter your email and your password.');

    await type('login', 'omar');
    await type('secret', 'change-me-now');
    await send();
    expect(text(el.querySelector('.error > span')!)).toBe('Enter your email: it has an @ in it.');
    expect(signIn).not.toHaveBeenCalled();
  });

  it('says what the API said when refused, and clears the password', async () => {
    signIn.mockRejectedValue(new HttpErrorResponse({ status: 401, error: { title: 'Sign-in failed.', detail: 'Wrong email or password.' } }));
    const { el, field, type, send, navigate, withPassword } = await render();
    await withPassword();

    await type('login', 'omar@example.com');
    await type('secret', 'wrong');
    await send();

    expect(text(el.querySelector('.error')!)).toContain('Wrong email or password.');
    expect(field('secret').value).toBe('');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('says the session has ended', async () => {
    const { el } = await render('expired');
    expect(text(el.querySelector('.notice > span')!)).toBe('Your session has ended. Sign in again. سجّل الدخول مرة أخرى');
  });
});

describe('the sign-in, for one already signed in', () => {
  function guard(user: boolean, role: 'Kitchen' | 'Cashier' = 'Cashier') {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthService, useValue: { isSignedIn: () => user, me: () => ({ role }) } }],
    });
    const result = TestBed.runInInjectionContext(() => signedOutGuard({} as never, {} as never));
    return result instanceof UrlTree ? TestBed.inject(Router).serializeUrl(result) : result;
  }

  it('sends a user on to their role’s screen', () => {
    expect(guard(true)).toBe('/pos/terminal');
    expect(guard(true, 'Kitchen')).toBe('/pos/kds');
    expect(guard(false)).toBe(true);
  });
});

import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Me } from '../../core/api/models';
import { AuthService } from '../../core/auth/auth.service';
import { Permission } from '../../core/auth/permissions';
import { LiveService } from '../../core/pos/live.service';
import { PrintService } from '../../core/pos/print';
import { SyncStatus } from '../../core/pos/sync-status.service';
import { cashierMe, managerMe } from '../../../testing/fixtures';
import { Shell } from './shell';

const text = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();

describe('the top bar', () => {
  const signOut = vi.fn();
  const start = { live: vi.fn(), sync: vi.fn(), listen: vi.fn() };
  const setStation = vi.fn();

  let detect: () => void;

  async function render(me: Me, state: { up?: boolean; pending?: number } = {}): Promise<HTMLElement> {
    const can = (permission: Permission) => me.permissions.includes(permission);
    const up = signal(state.up ?? true);
    const pending = signal(state.pending ?? 0);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { isSignedIn: () => true, me: signal(me), can, canAny: (permissions: readonly Permission[]) => permissions.some(can), signOut } },
        { provide: LiveService, useValue: { start: start.live, stop: vi.fn().mockResolvedValue(undefined), connected: signal(true) } },
        { provide: PrintService, useValue: { listen: start.listen, station: signal(true), setStation } },
        {
          provide: SyncStatus,
          useValue: {
            start: start.sync,
            stop: vi.fn(),
            serverUp: up,
            syncing: signal(false),
            label: computed(() =>
              !up()
                ? { en: `Offline / Local mode · ${pending()} pending sync`, ar: 'وضع محلي', tone: 'bad' }
                : pending()
                  ? { en: `Online · ${pending()} to sync`, ar: '', tone: 'warn' }
                  : { en: 'Online · All synced', ar: 'متصل', tone: 'ok' },
            ),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(Shell);
    detect = () => fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const nav = (el: HTMLElement) => [...el.querySelectorAll('nav a')].map((a) => a.getAttribute('aria-label'));

  beforeEach(() => {
    signOut.mockReset();
    Object.values(start).forEach((f) => f.mockReset());
    setStation.mockReset();
  });

  it('gives a manager the till, the staff and the company settings, and starts the live line', async () => {
    const el = await render(managerMe);

    expect(nav(el)).toEqual(['Point of sale', 'Staff', 'Company settings']);
    expect(text(el.querySelector('.user-name')!)).toBe('Omar');
    expect(start.live).toHaveBeenCalled();
    expect(start.sync).toHaveBeenCalled();
    expect(start.listen).toHaveBeenCalled();
    expect(el.querySelector('.banner')).toBeNull();
  });

  it('gives a cashier the till alone', async () => {
    const el = await render(cashierMe);

    expect(nav(el)).toEqual(['Point of sale']);
  });

  it('shows the sync light: all synced, or working locally with what waits', async () => {
    const el = await render(managerMe);
    expect(text(el.querySelector('.sync-pill')!)).toContain('Online · All synced');
    TestBed.resetTestingModule();

    const offline = await render(managerMe, { up: false, pending: 3 });
    expect(text(offline.querySelector('.sync-pill')!)).toContain('Offline / Local mode · 3 pending sync');
    expect(offline.querySelector('.sync-pill')!.classList).toContain('bad');
    expect(text(offline.querySelector('.banner')!)).toContain('Offline / local mode');
  });

  it('makes this browser the print station, or not', async () => {
    const el = await render(cashierMe);

    (el.querySelector('button[aria-label="Print station"]') as HTMLButtonElement).click();

    expect(setStation).toHaveBeenCalledWith(false);
  });

  it('signs out from the user’s menu, which names their role', async () => {
    const el = await render(cashierMe);

    (el.querySelector('button.user') as HTMLButtonElement).click();
    detect();
    expect(text(document.querySelector('.who')!)).toBe('MonaCashier');
    const out = [...document.querySelectorAll<HTMLButtonElement>('button[mat-menu-item]')].find((b) => text(b).includes('Sign out'))!;
    out.click();
    await new Promise((resolve) => setTimeout(resolve));

    expect(signOut).toHaveBeenCalled();
  });
});

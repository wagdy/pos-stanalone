import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { LiveService } from '../../../core/pos/live.service';
import { KitchenBoard, PosApi } from '../../../core/pos/pos.api';
import { NotifyService } from '../../../core/ui/notify.service';
import { kitchenMe } from '../../../../testing/fixtures';
import { aMenu, aTicket, aTicketLine } from '../../../../testing/pos-fixtures';
import { KdsPage } from './kds-page';

const text = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();

describe('the kitchen screen', () => {
  const kitchen = vi.fn();
  const bump = vi.fn();
  const signedIn = signal(true);
  const kitchenChanged = new Subject<void>();

  const board: KitchenBoard = {
    active: [
      aTicket({
        lines: [
          aTicketLine({ notes: 'بدون بصل', modifiers: 'Extra cheese' }),
          aTicketLine({ id: 'tl-2', stationId: 'st-bar', stationName: 'Bar', name: 'Cola', nameAr: 'كولا', quantity: 1 }),
        ],
      }),
      aTicket({ id: 'ticket-2', number: 8, kind: 'Void', lines: [aTicketLine({ id: 'tl-3', quantity: 1 })] }),
    ],
    recentlyDone: [aTicket({ id: 'ticket-0', number: 5, isDone: true })],
  };

  async function render() {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AuthService,
          useValue: { isSignedIn: signedIn, can: () => signedIn(), me: signal(kitchenMe), signInWithPin: vi.fn(), lock: vi.fn() },
        },
        {
          provide: LiveService,
          useValue: { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined), connected: signal(true), kitchenChanged, reconnected: new Subject<void>() },
        },
        { provide: PosApi, useValue: { kitchen, bump, recall: vi.fn(), menu: () => of(aMenu()) } },
        { provide: NotifyService, useValue: { info: vi.fn(), error: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(KdsPage);
    const settle = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    await settle();
    const el = fixture.nativeElement as HTMLElement;
    return { el, fixture, settle };
  }

  beforeEach(() => {
    signedIn.set(true);
    kitchen.mockReset().mockReturnValue(of(board));
    bump.mockReset().mockReturnValue(of(board.active[0]));
  });

  it('shows each ticket waiting: its table, its items by station with the notes loud, and a void as a banner', async () => {
    const { el } = await render();
    const tickets = el.querySelectorAll('.ticket');

    expect(tickets).toHaveLength(2);
    expect(text(tickets[0].querySelector('header')!)).toContain('#7');
    expect(text(tickets[0].querySelector('header')!)).toContain('T1');
    expect([...tickets[0].querySelectorAll('.station')].map(text)).toEqual(['Grill', 'Bar']);
    expect(text(tickets[0].querySelector('.note')!)).toBe('⚠ بدون بصل');
    expect(text(tickets[0].querySelector('.mod')!)).toBe('+ Extra cheese');
    expect(text(tickets[1].querySelector('.banner')!)).toBe('VOID · STOP بون إلغاء');
    expect(text(el.querySelector('.done-strip')!)).toContain('#5');
  });

  it('bumps all of a ticket at All, and one station’s part at that station', async () => {
    const { el, settle } = await render();

    el.querySelector<HTMLButtonElement>('.ticket .bump')!.click();
    await settle();
    expect(bump).toHaveBeenCalledWith('ticket-1', null, true);

    [...el.querySelectorAll<HTMLButtonElement>('.st')].find((b) => text(b).startsWith('Bar'))!.click();
    await settle();
    expect(kitchen).toHaveBeenLastCalledWith('st-bar');
    expect([...el.querySelectorAll('.ticket')[0].querySelectorAll('li .n strong')].map(text)).toEqual(['Cola']);
    expect(localStorage.getItem('pos.kdsStation')).toBe('st-bar');

    el.querySelector<HTMLButtonElement>('.ticket .bump')!.click();
    await settle();
    expect(bump).toHaveBeenLastCalledWith('ticket-1', 'st-bar', false);
  });

  it('asks again the moment a ticket is sent', async () => {
    await render();
    kitchen.mockClear();

    kitchenChanged.next();

    expect(kitchen).toHaveBeenCalled();
  });

  it('asks for a PIN before anyone works it', async () => {
    signedIn.set(false);
    const { el } = await render();

    expect(el.querySelector('app-pin-pad')).not.toBeNull();
    expect(el.querySelector('.ticket')).toBeNull();
    expect(kitchen).not.toHaveBeenCalled();
  });
});

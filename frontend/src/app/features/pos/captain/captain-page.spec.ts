import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { Subject, of } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { LiveService } from '../../../core/pos/live.service';
import { PosApi } from '../../../core/pos/pos.api';
import { SyncStatus } from '../../../core/pos/sync-status.service';
import { NotifyService } from '../../../core/ui/notify.service';
import { captainMe } from '../../../../testing/fixtures';
import { aFloor, aLine, aMenu, aTable, anOrder } from '../../../../testing/pos-fixtures';
import { OrderCommands, PosStore } from '../pos-store';
import { GuestsDialog } from '../terminal/dialogs';
import { CaptainPage } from './captain-page';

const text = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();

describe('the captain’s app', () => {
  const signedIn = signal(true);
  const signInWithPin = vi.fn();
  const commands = { open: vi.fn(), add: vi.fn(), send: vi.fn(), change: vi.fn(), void: vi.fn(), bill: vi.fn() };
  const open = vi.fn();
  const notify = { info: vi.fn(), error: vi.fn() };
  const start = vi.fn();
  const menu = aMenu();
  const busyTable = aTable({
    id: 'table-2', label: '2', x: 2, state: 'Occupied',
    checks: [{ orderId: 'order-2', number: 13, checkLabel: null, status: 'Open', total: 220, guests: 3, openedBy: 'Karim', openedAtUtc: '2026-11-09T12:00:00Z', hasDrafts: false }],
  });

  async function render() {
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { isSignedIn: signedIn, can: () => signedIn(), me: signal(captainMe), signInWithPin, lock: vi.fn() } },
        { provide: LiveService, useValue: { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined), connected: signal(true), ordersChanged: new Subject<string[]>() } },
        {
          provide: SyncStatus,
          useValue: { start: vi.fn(), stop: vi.fn(), pending: signal(0), label: computed(() => ({ en: 'Online · All synced', ar: '', tone: 'ok' })), offline: { queue: signal([]) } },
        },
        { provide: PosStore, useValue: { menu: signal(menu), floor: signal(aFloor([aTable(), busyTable])), open: signal([]), start } },
        { provide: PosApi, useValue: { order: (id: string) => of(anOrder({ id, tableLabel: '2', lines: [aLine({ status: 'Sent' })] })) } },
        { provide: OrderCommands, useValue: commands },
        { provide: MatDialog, useValue: { open } },
        { provide: NotifyService, useValue: notify },
      ],
    });
    const fixture = TestBed.createComponent(CaptainPage);
    const settle = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    await settle();
    const el = fixture.nativeElement as HTMLElement;
    const button = (label: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b).includes(label))!;
    return { el, settle, button };
  }

  beforeEach(() => {
    signedIn.set(true);
    Object.values(commands).forEach((f) => f.mockReset());
    open.mockReset();
    notify.info.mockReset();
    start.mockReset();
  });

  it('asks for the captain’s PIN on a pad', async () => {
    signedIn.set(false);
    const { el } = await render();

    expect(el.querySelector('app-pin-pad')).not.toBeNull();
    expect(el.querySelector('.tables')).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('shows the zone’s tables with their state', async () => {
    const { el } = await render();

    expect(start).toHaveBeenCalled();
    expect([...el.querySelectorAll('.table')].map((t) => [t.querySelector('strong')!.textContent, t.className.includes('Occupied')])).toEqual([
      ['1', false],
      ['2', true],
    ]);
    expect(text(el.querySelectorAll('.table')[1])).toContain('L.E 220.00');
  });

  it('opens a free table with its guests, puts items on with a tap, and sends them to the kitchen', async () => {
    open.mockReturnValue({ afterClosed: () => of(3) });
    commands.open.mockResolvedValue(anOrder({ lines: [] }));
    commands.add.mockResolvedValue(anOrder());
    commands.send.mockResolvedValue(
      anOrder({ lines: [aLine({ status: 'Sent' })], tickets: [{ id: 't', number: 9, kind: 'New', createdAtUtc: '', createdBy: 'Karim', isDone: false }] }),
    );
    const { el, settle, button } = await render();

    el.querySelector<HTMLButtonElement>('.table')!.click();
    await settle();
    expect(open.mock.lastCall![0]).toBe(GuestsDialog);
    expect(commands.open).toHaveBeenCalledWith('DineIn', 'table-1', 3);

    el.querySelector<HTMLButtonElement>('.items .quick')!.click();
    await settle();
    expect(commands.add.mock.lastCall![1]).toEqual([expect.objectContaining({ menuItemId: 'item-burger', quantity: 1 })]);
    expect(text(button('Send to kitchen'))).toContain('(2)');

    button('Send to kitchen').click();
    await settle();
    expect(commands.send).toHaveBeenCalled();
    expect(notify.info).toHaveBeenCalledWith('Sent on KOT 9. · أُرسل للمطبخ');
    expect(text(el.querySelector('.lines li')!)).toContain('Sent to kitchen');
  });

  it('opens a table already taken on its check, and asks for its bill', async () => {
    commands.bill.mockResolvedValue(anOrder({ status: 'BillPrinted' }));
    const { el, settle, button } = await render();

    el.querySelectorAll<HTMLButtonElement>('.table')[1].click();
    await settle();
    expect(text(el.querySelector('.bar .title')!)).toContain('Table 2');

    button('Bill').click();
    await settle();
    expect(commands.bill).toHaveBeenCalled();
    expect(notify.info).toHaveBeenCalledWith('The bill is printing at the cashier. · جاري طباعة الحساب');
  });
});

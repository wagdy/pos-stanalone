import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { LiveService } from '../../../core/pos/live.service';
import { OfflineStore } from '../../../core/pos/offline';
import { Order, PosApi } from '../../../core/pos/pos.api';
import { PrintService } from '../../../core/pos/print';
import { NotifyService } from '../../../core/ui/notify.service';
import { cashierMe } from '../../../../testing/fixtures';
import { aFloor, aLine, aMenu, anOrder } from '../../../../testing/pos-fixtures';
import { OrderCommands, PosStore } from '../pos-store';
import { TerminalPage } from './terminal-page';
import { VoidDialog } from './dialogs';

const text = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();

describe('the cashier’s terminal', () => {
  const commands = { open: vi.fn(), add: vi.fn(), send: vi.fn(), change: vi.fn(), void: vi.fn(), pay: vi.fn(), bill: vi.fn() };
  const open = vi.fn();
  const notify = { info: vi.fn(), error: vi.fn() };
  const printedHere = vi.fn();
  const menu = aMenu();
  const offline = { queue: signal<{ id: string; orderId: string; failed: boolean; body: unknown }[]>([]), forOrder: (id: string) => offline.queue().filter((c) => c.orderId === id) };

  async function render() {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: PosApi, useValue: { currentShift: () => of({ id: 'shift-1' }), order: (id: string) => of(anOrder({ id })) } },
        {
          provide: PosStore,
          useValue: {
            menu: signal(menu),
            floor: signal(aFloor()),
            open: signal([]),
            stale: signal(false),
            start: vi.fn(),
            item: (id: string) => menu.items.find((i) => i.id === id),
          },
        },
        { provide: OrderCommands, useValue: commands },
        { provide: OfflineStore, useValue: offline },
        { provide: MatDialog, useValue: { open } },
        { provide: NotifyService, useValue: notify },
        { provide: PrintService, useValue: { printedHere } },
        { provide: AuthService, useValue: { can: () => true, me: () => cashierMe } },
        { provide: LiveService, useValue: { ordersChanged: new Subject<string[]>(), shiftChanged: new Subject<void>() } },
      ],
    });
    const fixture = TestBed.createComponent(TerminalPage);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const settle = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const button = (label: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b).includes(label))!;
    const key = async (key: string) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key }));
      await settle();
    };
    return { el, fixture, settle, button, key };
  }

  beforeEach(() => {
    Object.values(commands).forEach((f) => f.mockReset());
    offline.queue.set([]);
    open.mockReset();
    notify.info.mockReset();
    notify.error.mockReset();
  });

  it('shows the menu by category, each item with its code and price', async () => {
    const { el, settle } = await render();
    const items = () => [...el.querySelectorAll('.item strong')].map(text);

    expect(items()).toEqual(['Beef burger', 'Cola', 'Orange juice']);
    (el.querySelectorAll<HTMLButtonElement>('.cat')[2]).click();
    await settle();
    expect(items()).toEqual(['Cola', 'Orange juice']);
    expect(text(el.querySelectorAll('.item')[1])).toContain('from L.E 45.00');
  });

  it('opens a takeaway with the first item tapped, and puts it on as a draft', async () => {
    const opened = anOrder({ id: 'order-9', type: 'Takeaway', tableId: null, tableLabel: null, lines: [] });
    commands.open.mockResolvedValue(opened);
    commands.add.mockResolvedValue(anOrder({ id: 'order-9', type: 'Takeaway', tableId: null, tableLabel: null }));
    const { el, settle } = await render();

    el.querySelector<HTMLButtonElement>('.item')!.click();
    await settle();

    expect(commands.open.mock.lastCall!.slice(0, 3)).toEqual(['Takeaway', null, 0]);
    const [order, lines] = commands.add.mock.lastCall!;
    expect(order.id).toBe('order-9');
    expect(lines).toEqual([expect.objectContaining({ menuItemId: 'item-burger', quantity: 1, sizeId: null })]);
    expect(text(el.querySelector('.line')!)).toContain('Not sent');
  });

  it('sends the drafts to the kitchen with F4, and says on which KOT', async () => {
    commands.open.mockResolvedValue(anOrder());
    commands.add.mockResolvedValue(anOrder());
    commands.send.mockResolvedValue(
      anOrder({
        lines: [aLine({ status: 'Sent', kitchenTicketNumber: 7 })],
        tickets: [{ id: 't', number: 7, kind: 'New', createdAtUtc: '', createdBy: 'Mona', isDone: false }],
      }),
    );
    const { el, settle, key } = await render();
    el.querySelector<HTMLButtonElement>('.item')!.click();
    await settle();

    await key('F4');

    expect(commands.send).toHaveBeenCalled();
    expect(notify.info).toHaveBeenCalledWith('Sent to the kitchen on KOT 7. · أُرسل للمطبخ.');
    expect(text(el.querySelector('.line .state')!)).toBe('Sent to kitchen · KOT 7');
  });

  it('voids an item after the kitchen with the reason, what became of it, and a manager’s PIN', async () => {
    const sent: Order = anOrder({ lines: [aLine({ status: 'Sent', kitchenTicketNumber: 7 })] });
    commands.open.mockResolvedValue(sent);
    commands.add.mockResolvedValue(sent);
    commands.void.mockResolvedValue(anOrder({ lines: [aLine({ status: 'Sent', quantity: 1, total: 180 })] }));
    const { el, settle, button } = await render();
    el.querySelector<HTMLButtonElement>('.item')!.click();
    await settle();

    el.querySelector<HTMLElement>('.line')!.click();
    await settle();
    open.mockReturnValue({ afterClosed: () => of({ quantity: 1, reason: 'Captain error', outcome: 'Waste', managerPin: '1234' }) });
    button('Void · إلغاء').click();
    await settle();

    expect(open.mock.lastCall![0]).toBe(VoidDialog);
    expect(commands.void).toHaveBeenCalledWith(sent, [{ lineId: 'line-1', quantity: 1 }], 'Captain error', 'Waste', '1234');
    expect(notify.info).toHaveBeenCalledWith('Voided: a VOID ticket went to the kitchen. · أُرسل بون إلغاء للمطبخ.');
  });

  it('goes on with a check opened while the server cannot be reached, its items shown as waiting', async () => {
    // The outbox keeps what it could not send: the check, then its item.
    commands.open.mockImplementation(async (type: string, tableId: string | null, guests: number, _c: unknown, id: string) => {
      offline.queue.update((q) => [...q, { id: 'q1', orderId: id, failed: false, body: { orderId: id, type, tableId, guests } }]);
      return null;
    });
    commands.add.mockImplementation(async (order: Order, items: unknown[]) => {
      offline.queue.update((q) => [...q, { id: 'q2', orderId: order.id, failed: false, body: { items } }]);
      return null;
    });
    commands.send.mockResolvedValue(null);
    const { el, settle, button } = await render();

    el.querySelector<HTMLButtonElement>('.item')!.click();
    await settle();

    expect(notify.info).toHaveBeenCalledWith(expect.stringContaining('The server cannot be reached'));
    const [order] = commands.add.mock.lastCall!;
    expect(order.id).toBe(commands.open.mock.lastCall![4]);
    expect(text(el.querySelector('.check-head')!)).toContain('Waiting to sync');
    const waiting = el.querySelector('.line.waiting')!;
    expect([text(waiting.querySelector('.qty')!), text(waiting.querySelector('.name')!)]).toEqual(['1×', 'Beef burger']);
    expect(text(waiting.querySelector('.state')!)).toContain('Waiting to sync');

    button('Send to kitchen').click();
    await settle();
    expect(commands.send).toHaveBeenCalled();
  });
});

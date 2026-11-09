import { aLine, aMenu, anOrder } from '../../../testing/pos-fixtures';
import { QueuedCommand } from './offline';
import { lineFrom, projectOrder, round2, totalsOf } from './projection';

let n = 0;
function command(url: string, body: unknown, method: 'POST' | 'PUT' = 'POST'): QueuedCommand {
  n += 1;
  return { id: `c${n}`, method, url, body, label: '', orderId: 'order-1', createdAt: `2026-11-09T20:0${n}:00Z`, attempts: 0, lastError: null, failed: false };
}

describe('a check as the server will have it', () => {
  beforeEach(() => (n = 0));

  it('rounds to the cent, halves away from zero, as the server does', () => {
    expect([round2(56.445), round2(1.005), round2(68.992), round2(-2.675), round2(0.1 + 0.2)]).toEqual([56.45, 1.01, 68.99, -2.68, 0.3]);
  });

  // The sums the server came to in the browser check: a table of four lines, and the same after a
  // void; a takeaway without service.
  it('comes to the server’s totals: service on the net, VAT on the net and the service', () => {
    const lines = [215, 165, 30, 30].map((unitPrice) => ({ quantity: 1, unitPrice, discount: 0 }));
    expect(totalsOf(lines, 0, 0, 12, 14, [])).toEqual({
      gross: 440, lineDiscounts: 0, billDiscount: 0, redemption: 0, net: 440, service: 52.8, tax: 68.99, total: 561.79, paid: 0, due: 561.79,
    });
    const afterVoid = [215, 165, 30, 150].map((unitPrice) => ({ quantity: 1, unitPrice, discount: 0 }));
    expect(totalsOf(afterVoid, 0, 0, 12, 14, [{ amount: 715.01 }])).toMatchObject({ service: 67.2, tax: 87.81, total: 715.01, due: 0 });
    expect(totalsOf([{ quantity: 1, unitPrice: 30, discount: 0 }], 0, 0, 0, 14, [])).toMatchObject({ net: 30, service: 0, tax: 4.2, total: 34.2 });
    // A bill discount and points never take more than is left.
    expect(totalsOf([{ quantity: 2, unitPrice: 50, discount: 10 }], 100, 20, 0, 0, [])).toMatchObject({ lineDiscounts: 10, billDiscount: 90, redemption: 0, total: 0 });
  });

  it('prices a line put on while waiting from the menu: the size, the modifiers, the unit to the cent', () => {
    const menu = aMenu();
    menu.items[0].modifiers = [{ id: 'mod-cheese', name: 'Extra cheese', nameAr: 'جبنة', price: 25 }];
    const line = lineFrom({ lineId: 'l9', menuItemId: 'item-burger', sizeId: null, modifierIds: ['mod-cheese'], quantity: 2, notes: ' بدون بصل ' }, menu, 'Mona', 'at');
    expect(line).toMatchObject({ unitPrice: 205, total: 410, modifiers: 'Extra cheese', modifiersAr: 'جبنة', notes: 'بدون بصل', status: 'Draft', stationName: 'Grill' });
    const juice = lineFrom({ lineId: 'l10', menuItemId: 'item-juice', sizeId: 'sz-l', modifierIds: [], quantity: 1, notes: null }, menu, 'Mona', 'at');
    expect([juice?.sizeName, juice?.unitPrice]).toEqual(['Large', 60]);
    expect(lineFrom({ lineId: 'x', menuItemId: 'gone', sizeId: null, modifierIds: [], quantity: 1, notes: null }, menu, 'Mona', 'at')).toBeNull();
  });

  it('applies what waits in order: items, a change, a void, the send, the bill and the payment, and the check is paid', () => {
    const menu = aMenu();
    const sent = aLine({ id: 'line-1', status: 'Sent', quantity: 2, total: 360, kitchenTicketNumber: 4 });
    const base = anOrder({
      lines: [sent],
      customer: { id: 'cust-1', name: 'Sara', phone: '0100', loyaltyUserId: null, points: 10, tier: null },
      totals: { gross: 360, lineDiscounts: 0, billDiscount: 0, redemption: 0, net: 360, service: 43.2, tax: 56.45, total: 459.65, paid: 0, due: 459.65 },
    });
    const items = { items: [{ lineId: 'l-cola', menuItemId: 'item-cola', sizeId: null, modifierIds: [], quantity: 1, notes: null }], sendToKitchen: false };
    const queue = [
      command('/api/orders/order-1/items', items),
      command('/api/orders/order-1/lines/l-cola', { quantity: 3, notes: null }, 'PUT'),
      command('/api/orders/order-1/voids', { items: [{ voidId: 'v1', lineId: 'line-1', quantity: 1 }], reason: 'Quality', outcome: 'Waste', managerPin: null }),
      command('/api/orders/order-1/send', {}),
      command('/api/orders/order-1/bill', { print: false }),
    ];
    const billed = projectOrder(base, queue, menu, 'Mona')!;
    // 180 + 3 × 35 = 285; service 34.20; VAT on 319.20 = 44.69; total 363.89.
    expect(billed.order.totals).toMatchObject({ gross: 285, service: 34.2, tax: 44.69, total: 363.89, due: 363.89 });
    expect(billed.order.status).toBe('BillPrinted');
    expect(billed.order.lines.map((l) => [l.name, l.quantity, l.status])).toEqual([['Beef burger', 1, 'Sent'], ['Cola', 3, 'Sent']]);
    expect(billed.order.voids).toEqual([expect.objectContaining({ kind: 'AfterKitchen', quantity: 1, amount: 180, reason: 'Quality', outcome: 'Waste' })]);
    expect([...billed.waitingLineIds]).toEqual(['l-cola', 'line-1']);
    expect(base.lines[0].quantity).toBe(2);

    const pay = command('/api/orders/order-1/pay', {
      payments: [{ paymentId: 'p1', method: 'Cash', amount: 363.89, tendered: 400, reference: null }],
      printReceipt: false,
    });
    const paid = projectOrder(base, [...queue, pay], { ...menu, pointsPerCurrencyUnit: 0.1 }, 'Mona')!.order;
    expect(paid.status).toBe('Paid');
    expect(paid.payments).toEqual([expect.objectContaining({ amount: 363.89, tendered: 400, change: 36.11, by: 'Mona' })]);
    expect([paid.totals.due, paid.paidAtUtc, paid.settledBy, paid.pointsEarned]).toEqual([0, pay.createdAt, 'Mona', 36]);
  });

  it('leaves a check partly paid open, and sends what was not sent before the payment, as the server does', () => {
    const base = anOrder({ lines: [aLine({ status: 'Draft' })] });
    const part = command('/api/orders/order-1/pay', { payments: [{ paymentId: 'p1', method: 'Card', amount: 100, tendered: null, reference: '1234' }] });
    const projected = projectOrder(base, [part], aMenu(), 'Mona')!.order;
    expect([projected.status, projected.lines[0].status, projected.totals.paid, projected.totals.due]).toEqual(['Open', 'Sent', 100, 359.65]);
  });

  it('is the check itself when nothing waits', () => {
    const base = anOrder();
    expect(projectOrder(base, [], aMenu(), 'Mona')!.order).toBe(base);
    expect(projectOrder(null, [], aMenu(), 'Mona')).toBeNull();
  });
});

import { QueuedCommand } from './offline';
import { Menu, NewLine, NewPayment, Order, OrderLine, Payment, StockOutcome, Totals, VoidEntry } from './pos.api';

// A check as the server will have it once this terminal's outbox reaches it: the check as last
// seen, with what waits applied in order (items put on, changed, voided, sent, the bill, payments),
// and its totals worked out exactly as the server's Order does. So while the server cannot be
// reached the terminal shows what the guest owes, takes the payment, prints the receipt and frees
// the table; the server then takes the same commands, by the same ids, and comes to the same sums.

// Two places, halves away from zero, as the server's Order.Round (decimal). The nudge is far above
// a double's error at these sizes and far below a cent.
export function round2(value: number): number {
  const rounded = Math.round(Math.abs(value) * 100 + 1e-7) / 100;
  return value < 0 ? -rounded : rounded;
}

const sum = (values: number[]) => values.reduce((n, v) => n + v, 0);

// As Order.Totals: the gross, the lines' own discounts, the bill's discount and the points off (each
// at most what is left), the service on the net (dine-in), VAT on the net and the service.
export function totalsOf(
  lines: Pick<OrderLine, 'quantity' | 'unitPrice' | 'discount'>[],
  discountAmount: number,
  redemptionAmount: number,
  servicePercent: number,
  taxPercent: number,
  payments: Pick<Payment, 'amount'>[],
): Totals {
  const live = lines.filter((l) => l.quantity > 0);
  const gross = round2(sum(live.map((l) => l.quantity * l.unitPrice)));
  const lineDiscounts = round2(sum(live.map((l) => l.discount)));
  const afterLines = round2(gross - lineDiscounts);
  const billDiscount = Math.min(discountAmount, afterLines);
  const redemption = Math.min(redemptionAmount, round2(afterLines - billDiscount));
  const net = round2(afterLines - billDiscount - redemption);
  const service = round2((net * servicePercent) / 100);
  const tax = round2(((net + service) * taxPercent) / 100);
  const total = round2(net + service + tax);
  const paid = round2(sum(payments.map((p) => p.amount)));
  return { gross, lineDiscounts, billDiscount, redemption, net, service, tax, total, paid, due: Math.max(0, round2(total - paid)) };
}

// A line put on while waiting, priced from the menu as the server prices it: the size's price (or
// the item's) and the modifiers', the unit rounded to the cent.
export function lineFrom(line: NewLine, menu: Menu | null, by: string, atUtc: string): OrderLine | null {
  const item = menu?.items.find((i) => i.id === line.menuItemId);
  if (!item) return null;
  const size = item.sizes.find((s) => s.id === line.sizeId) ?? null;
  const modifiers = item.modifiers.filter((m) => line.modifierIds.includes(m.id));
  const unitPrice = round2((size?.price ?? item.price) + sum(modifiers.map((m) => m.price)));
  const station = menu?.stations.find((s) => s.id === item.stationId) ?? null;
  return {
    id: line.lineId,
    menuItemId: item.id,
    code: item.code,
    name: item.name,
    nameAr: item.nameAr,
    sizeName: size?.name ?? null,
    sizeNameAr: size?.nameAr ?? null,
    modifiers: modifiers.map((m) => m.name).join(', '),
    modifiersAr: modifiers.some((m) => m.nameAr) ? modifiers.map((m) => m.nameAr ?? m.name).join('، ') : null,
    notes: line.notes?.trim() || null,
    unitPrice,
    quantity: line.quantity,
    discount: 0,
    total: round2(unitPrice * line.quantity),
    status: 'Draft',
    stationId: item.stationId,
    stationName: station?.name ?? null,
    kitchenTicketNumber: null,
    sentAtUtc: null,
    preparedAtUtc: null,
    addedBy: by,
    addedAtUtc: atUtc,
  };
}

export interface Projection {
  order: Order;
  // Lines put on, changed or voided by what waits: shown as waiting to sync.
  waitingLineIds: Set<string>;
  // How many of this terminal's commands on it wait.
  waiting: number;
}

// The check with what waits applied. Commands are this check's, oldest first, failed ones left out.
export function projectOrder(base: Order | null, commands: QueuedCommand[], menu: Menu | null, by: string): Projection | null {
  if (!base) return null;
  if (!commands.length) return { order: base, waitingLineIds: new Set(), waiting: 0 };

  const order: Order = { ...base, lines: base.lines.map((l) => ({ ...l })), voids: [...base.voids], payments: [...base.payments] };
  const waitingLineIds = new Set<string>();
  const line = (id: string) => order.lines.find((l) => l.id === id);
  const prefix = `/api/orders/${base.id}`;
  let lastPaidAt: string | null = null;

  for (const command of commands) {
    if (!command.url.startsWith(prefix)) continue;
    const path = command.url.slice(prefix.length);
    const body = (command.body ?? {}) as Record<string, unknown>;

    if (command.method === 'POST' && path === '/items') {
      for (const added of (body['items'] as NewLine[]) ?? []) {
        if (line(added.lineId)) continue;
        const made = lineFrom(added, menu, by, command.createdAt);
        if (!made) continue;
        if (body['sendToKitchen']) made.status = 'Sent';
        order.lines.push(made);
        waitingLineIds.add(made.id);
      }
    } else if (command.method === 'PUT' && path.startsWith('/lines/')) {
      const changed = line(path.slice('/lines/'.length));
      if (changed && changed.status === 'Draft') {
        changed.quantity = Number(body['quantity']);
        changed.notes = (body['notes'] as string | null) ?? null;
        changed.total = round2(changed.quantity * changed.unitPrice - changed.discount);
        waitingLineIds.add(changed.id);
      }
    } else if (command.method === 'POST' && path === '/voids') {
      for (const v of (body['items'] as { voidId: string; lineId: string; quantity: number }[]) ?? []) {
        const voided = line(v.lineId);
        if (!voided || order.voids.some((x) => x.id === v.voidId)) continue;
        const quantity = Math.min(v.quantity, voided.quantity);
        const entry: VoidEntry = {
          id: v.voidId,
          lineId: voided.id,
          code: voided.code,
          itemName: voided.name,
          quantity,
          amount: round2(quantity * voided.unitPrice),
          kind: voided.status === 'Draft' ? 'BeforeKitchen' : 'AfterKitchen',
          reason: (body['reason'] as string | null) ?? null,
          outcome: (body['outcome'] as StockOutcome) ?? 'None',
          authorizedBy: null,
          voidedBy: by,
          atUtc: command.createdAt,
          kitchenTicketNumber: null,
        };
        order.voids.push(entry);
        voided.quantity -= quantity;
        voided.total = round2(voided.quantity * voided.unitPrice - voided.discount);
        waitingLineIds.add(voided.id);
      }
    } else if (command.method === 'POST' && path === '/send') {
      sendDrafts(order, waitingLineIds);
    } else if (command.method === 'POST' && path === '/bill') {
      if (order.status === 'Open') order.status = 'BillPrinted';
      order.billPrints += 1;
    } else if (command.method === 'POST' && path === '/pay') {
      // As the server: what is not sent yet goes to the kitchen first.
      sendDrafts(order, waitingLineIds);
      for (const p of (body['payments'] as NewPayment[]) ?? []) {
        if (order.payments.some((x) => x.id === p.paymentId)) continue;
        const amount = round2(p.amount);
        const tendered = p.method === 'Cash' ? p.tendered : null;
        order.payments.push({
          id: p.paymentId,
          method: p.method,
          amount,
          tendered,
          change: tendered != null ? round2(Math.max(0, tendered - amount)) : 0,
          reference: p.reference,
          by,
          atUtc: command.createdAt,
        });
        lastPaidAt = command.createdAt;
      }
    }
  }

  order.totals = totalsOf(order.lines, order.discountAmount, base.totals.redemption, order.servicePercent, order.taxPercent, order.payments);
  if (lastPaidAt && order.totals.due === 0 && (order.status === 'Open' || order.status === 'BillPrinted')) {
    order.status = 'Paid';
    order.paidAtUtc = lastPaidAt;
    order.settledBy = by;
    order.pointsEarned = order.customer?.id ? Math.floor(order.totals.total * (menu?.pointsPerCurrencyUnit ?? 0)) : 0;
  }
  return { order, waitingLineIds, waiting: commands.length };
}

function sendDrafts(order: Order, waitingLineIds: Set<string>): void {
  for (const l of order.lines) {
    if (l.status === 'Draft' && l.quantity > 0) {
      l.status = 'Sent';
      waitingLineIds.add(l.id);
    }
  }
}

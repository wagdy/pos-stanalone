import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { LiveService } from '../../core/pos/live.service';
import { OfflineStore } from '../../core/pos/offline';
import {
  Floor,
  Menu,
  MenuItem,
  NewLine,
  NewPayment,
  Order,
  OrderSummary,
  OrderType,
  PosApi,
  StockOutcome,
  Table,
  newId,
} from '../../core/pos/pos.api';

const OpenOrdersKey = 'open-orders';

// What the till's screens share: the menu and the floor (kept in this browser too, so they open
// while the server cannot be reached) and the open checks, each reloaded the moment the server says
// it changed.
@Injectable({ providedIn: 'root' })
export class PosStore {
  private readonly api = inject(PosApi);
  private readonly offline = inject(OfflineStore);
  private readonly live = inject(LiveService);

  readonly menu = signal<Menu | null>(null);
  readonly floor = signal<Floor | null>(null);
  readonly open = signal<OrderSummary[]>([]);
  // The menu or floor shown is this browser's copy: the server could not be asked.
  readonly stale = signal(false);
  readonly itemsById = computed(() => new Map((this.menu()?.items ?? []).map((i) => [i.id, i])));

  private started = false;

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    void this.loadMenu();
    void this.loadFloor();
    void this.loadOpen();
    this.live.menuChanged.subscribe(() => void this.loadMenu());
    this.live.floorChanged.subscribe(() => {
      void this.loadFloor();
      void this.loadOpen();
    });
    this.live.ordersChanged.subscribe(() => void this.loadOpen());
    this.live.reconnected.subscribe(() => {
      void this.loadMenu();
      void this.loadFloor();
      void this.loadOpen();
    });
  }

  async loadMenu(): Promise<void> {
    try {
      const { value, stale } = await this.offline.cached('menu', () => this.api.menu());
      this.menu.set(value);
      this.stale.set(stale);
    } catch {
      // Neither the server nor a copy: the screens say the menu could not be loaded.
    }
  }

  async loadFloor(): Promise<void> {
    try {
      const { value, stale } = await this.offline.cached('floor', () => this.api.floor());
      this.floor.set(value);
      this.stale.set(stale);
    } catch {
      // As the menu.
    }
  }

  async loadOpen(): Promise<void> {
    try {
      this.open.set(await firstValueFrom(this.api.openOrders()));
      this.snapshotSoon();
    } catch {
      // Kept as they were.
    }
  }

  // ---- The terminal's copy of every open check, whole, for when the server cannot be reached ----

  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  // A moment after the checks change (many changes at once make one request): all of them, kept.
  private snapshotSoon(): void {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      firstValueFrom(this.api.openOrdersFull())
        .then((orders) => this.offline.write(OpenOrdersKey, orders))
        .catch(() => undefined);
    }, 1500);
  }

  // A check as this terminal last had it.
  async cachedOrder(id: string): Promise<Order | null> {
    const kept = (await this.offline.read<Order[]>(OpenOrdersKey)) ?? [];
    return kept.find((o) => o.id === id) ?? null;
  }

  // The check as a command just answered it, kept in the copy (or taken out of it once closed).
  async keep(order: Order): Promise<void> {
    const kept = ((await this.offline.read<Order[]>(OpenOrdersKey)) ?? []).filter((o) => o.id !== order.id);
    const closed = order.status === 'Paid' || order.status === 'Cancelled' || order.status === 'Merged';
    await this.offline.write(OpenOrdersKey, closed ? kept : [...kept, order]);
  }

  // ---- What this terminal did while the server could not be reached, on the floor at once ----

  // A table opened here: taken on this terminal's floor until the server says how it is.
  markOpenedOffline(order: Order): void {
    if (!order.tableId) return;
    this.updateFloor((t) =>
      t.id === order.tableId
        ? {
            ...t,
            state: 'Occupied',
            checks: [
              ...t.checks,
              { orderId: order.id, number: 0, checkLabel: null, status: 'Open', total: 0, guests: order.guests, openedBy: order.openedBy, openedAtUtc: order.openedAtUtc, hasDrafts: true },
            ],
          }
        : t,
    );
  }

  // A check paid here: off the open checks and its table free, on this terminal, until the server
  // has the payment and says so itself.
  settledOffline(order: Order): void {
    this.open.update((all) => all.filter((o) => o.id !== order.id));
    this.updateFloor((t) => {
      if (!t.checks.some((c) => c.orderId === order.id)) return t;
      const checks = t.checks.filter((c) => c.orderId !== order.id);
      return { ...t, checks, state: checks.length ? t.state : 'Available' };
    });
    void this.keep({ ...order, status: 'Paid' });
  }

  private updateFloor(change: (table: Table) => Table): void {
    const floor = this.floor();
    if (!floor) return;
    const next = { ...floor, tables: floor.tables.map(change) };
    this.floor.set(next);
    void this.offline.write('floor', next);
  }

  item(id: string): MenuItem | undefined {
    return this.itemsById().get(id);
  }
}

// A check opened while the server could not be reached: the terminal works on it by its id (the
// server takes it with that id once it answers); what is put on it shows as waiting until then.
export function pendingOrder(
  id: string,
  type: OrderType,
  tableId: string | null,
  tableLabel: string | null,
  guests: number,
  openedBy: string,
  menu: Menu | null,
  openedAtUtc = new Date().toISOString(),
): Order {
  const now = openedAtUtc;
  return {
    id, number: 0, businessDate: now.slice(0, 10), type, status: 'Open', tableId, tableLabel, checkLabel: null, guests, splitFromId: null,
    mergedIntoId: null, splitWays: null, openedBy, openedAtUtc: now, notes: null, customer: null, deliveryAddress: null, driverName: null,
    servicePercent: type === 'DineIn' ? (menu?.servicePercent ?? 0) : 0, taxPercent: menu?.taxPercent ?? 0, discountAmount: 0, discountReason: null, pointsRedeemed: 0, pointsEarned: 0, billPrints: 0,
    billPrintedAtUtc: null, paidAtUtc: null, settledBy: null, shiftId: null,
    totals: { gross: 0, lineDiscounts: 0, billDiscount: 0, redemption: 0, net: 0, service: 0, tax: 0, total: 0, paid: 0, due: 0 },
    lines: [], voids: [], payments: [], tickets: [],
  };
}

// A check as the sync drawer names it: its number, or "New check" while it waits to reach the server.
function checkName(order: Pick<Order, 'number'>): string {
  return order.number ? `Check #${order.number}` : 'New check';
}

// The till's commands on a check, sent through the terminal's outbox: when the server cannot be
// reached each is kept, with the ids it was made with, and sent once it can. The answer is the
// check as the server now has it, or null when it waits.
@Injectable({ providedIn: 'root' })
export class OrderCommands {
  private readonly offline = inject(OfflineStore);
  private readonly api = inject(PosApi);

  open(type: OrderType, tableId: string | null, guests: number, customer: { name?: string | null; phone?: string | null } = {}, orderId = newId()) {
    return this.offline.send<Order>({
      method: 'POST',
      url: '/api/orders',
      body: { orderId, type, tableId, guests, customerName: customer.name ?? null, customerPhone: customer.phone ?? null },
      label: `New ${type === 'DineIn' ? 'table' : type.toLowerCase()} check`,
      orderId,
    });
  }

  add(order: Pick<Order, 'id' | 'number'>, items: NewLine[], sendToKitchen = false) {
    return this.offline.send<Order>({
      method: 'POST',
      url: `/api/orders/${order.id}/items`,
      body: { items, sendToKitchen },
      label: `${checkName(order)}: ${items.reduce((n, i) => n + i.quantity, 0)} items${sendToKitchen ? ', sent to the kitchen' : ''}`,
      orderId: order.id,
    });
  }

  send(order: Pick<Order, 'id' | 'number'>) {
    return this.offline.send<Order>({ method: 'POST', url: `/api/orders/${order.id}/send`, body: {}, label: `${checkName(order)}: sent to the kitchen`, orderId: order.id });
  }

  change(order: Pick<Order, 'id' | 'number'>, lineId: string, quantity: number, notes: string | null) {
    return this.offline.send<Order>({
      method: 'PUT',
      url: `/api/orders/${order.id}/lines/${lineId}`,
      body: { quantity, notes },
      label: `${checkName(order)}: item changed`,
      orderId: order.id,
    });
  }

  // With a manager's PIN, straight to the server: a PIN is never kept in the browser to send later.
  void(order: Pick<Order, 'id' | 'number'>, items: { lineId: string; quantity: number }[], reason: string | null, outcome: StockOutcome, managerPin: string | null) {
    if (managerPin) {
      return firstValueFrom(this.api.void(order.id, { items: items.map((i) => ({ voidId: newId(), ...i })), reason, outcome, managerPin }));
    }
    return this.offline.send<Order>({
      method: 'POST',
      url: `/api/orders/${order.id}/voids`,
      body: { items: items.map((i) => ({ voidId: newId(), ...i })), reason, outcome, managerPin },
      label: `${checkName(order)}: ${items.length} voided`,
      orderId: order.id,
    });
  }

  // Kept to send later, it asks the server for no receipt: this terminal printed it already.
  pay(order: Pick<Order, 'id' | 'number'>, payments: NewPayment[], printReceipt: boolean) {
    return this.offline.send<Order>({
      method: 'POST',
      url: `/api/orders/${order.id}/pay`,
      body: { payments, printReceipt },
      bodyIfQueued: { payments, printReceipt: false },
      label: `${checkName(order)}: paid`,
      orderId: order.id,
    });
  }

  bill(order: Pick<Order, 'id' | 'number'>) {
    return this.offline.send<Order>({
      method: 'POST',
      url: `/api/orders/${order.id}/bill`,
      body: { print: true },
      bodyIfQueued: { print: false },
      label: `${checkName(order)}: bill printed`,
      orderId: order.id,
    });
  }
}

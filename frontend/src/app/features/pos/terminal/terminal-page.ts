import { DatePipe } from '@angular/common';
import { Component, ElementRef, HostListener, OnInit, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';
import { Observable, firstValueFrom, isObservable } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { Permissions } from '../../../core/auth/permissions';
import { errorMessage } from '../../../core/http/error-message';
import { LiveService } from '../../../core/pos/live.service';
import { OfflineStore, QueuedCommand, isUnreachable } from '../../../core/pos/offline';
import { projectOrder } from '../../../core/pos/projection';
import {
  MenuItem,
  NewLine,
  Order,
  OrderLine,
  OrderSummary,
  OrderType,
  PaymentMethod,
  PosApi,
  Shift,
  lineStatusLabels,
  newId,
  orderTypeLabels,
  tableTag,
} from '../../../core/pos/pos.api';
import { PrintService } from '../../../core/pos/print';
import { Company } from '../../../core/settings/company';
import { MoneyPipe } from '../../../core/ui/money.pipe';
import { NotifyService } from '../../../core/ui/notify.service';
import { OrderCommands, PosStore, pendingOrder } from '../pos-store';
import {
  CustomerDialog,
  DiscountChoice,
  DiscountData,
  DiscountDialog,
  ItemChoice,
  ItemOptionsData,
  ItemOptionsDialog,
  PayChoice,
  PayData,
  PayDialog,
  SplitChoice,
  SplitData,
  SplitDialog,
  TablePick,
  TablePickData,
  TablePickDialog,
  VoidChoice,
  VoidData,
  VoidDialog,
} from './dialogs';

// The cashier's terminal (نقطة البيع), laid out as a register: the menu (the checks open in a strip
// above it, folded or not as the cashier leaves it; the categories in their own bar; the tiles) and
// the check being worked, its header (how it is served, the table and guests, the customer), its
// lines, and its totals and keys docked at the foot. Items go on as drafts and to the kitchen with
// Send to Kitchen (F4); more later go on an add-on ticket. The bill prints for the guest (F8), the
// check is paid in cash or by card or any other way (F9), voided, split, moved or merged. Every
// screen hears each change at once; what is done while the server cannot be reached waits in this
// terminal's outbox and is shown as waiting.
@Component({
  selector: 'app-terminal-page',
  imports: [DatePipe, FormsModule, MatButtonModule, MatIconModule, MatMenuModule, MatProgressBarModule, MatTooltipModule, MoneyPipe, RouterLink],
  templateUrl: './terminal-page.html',
  styleUrl: './terminal-page.scss',
})
export class TerminalPage implements OnInit {
  private readonly api = inject(PosApi);
  protected readonly store = inject(PosStore);
  private readonly commands = inject(OrderCommands);
  private readonly offline = inject(OfflineStore);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotifyService);
  private readonly printer = inject(PrintService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly live = inject(LiveService);
  protected readonly company = inject(Company);
  private readonly searchBox = viewChild<ElementRef<HTMLInputElement>>('searchBox');

  // A check to open with: /pos/terminal?order=… (from the floor plan).
  readonly order = input<string | undefined>(undefined, { alias: 'order' });

  protected readonly typeLabels = orderTypeLabels;
  protected readonly tableTag = tableTag;
  protected readonly statusLabels = lineStatusLabels;
  protected readonly types: OrderType[] = ['DineIn', 'Takeaway', 'Delivery'];

  // The check as the server last answered it (or as kept here); what is shown is it with this
  // terminal's waiting commands applied (current).
  private readonly base = signal<Order | null>(null);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly category = signal<string | null>(null);
  protected readonly search = signal('');
  protected readonly selectedLine = signal<string | null>(null);
  // The strip of open checks above the menu, shown or folded: the cashier's choice, kept here.
  protected readonly checksShown = signal(readChecksShown());
  protected readonly shift = signal<Shift | null | undefined>(undefined);
  protected redeemPoints: number | null = null;

  protected readonly canSettle = computed(() => this.auth.can(Permissions.OrdersSettle));
  protected readonly isManager = computed(() => this.auth.can(Permissions.OrdersAuthorize));

  protected readonly categories = computed(() => (this.store.menu()?.categories ?? []).filter((c) => c.isActive));
  protected readonly items = computed(() => {
    const menu = this.store.menu();
    if (!menu) return [];
    const text = this.search().trim().toLowerCase();
    const active = new Set(this.categories().map((c) => c.id));
    return menu.items.filter(
      (i) =>
        i.isActive &&
        active.has(i.categoryId) &&
        (text
          ? i.name.toLowerCase().includes(text) || (i.nameAr ?? '').includes(text) || String(i.code).startsWith(text)
          : !this.category() || i.categoryId === this.category()),
    );
  });
  protected readonly colorOf = computed(() => new Map(this.categories().map((c) => [c.id, c.color ?? '#4f46e5'])));

  // The open checks, and those opened here waiting for the server, the oldest first.
  protected readonly openChecks = computed(() =>
    [...this.store.open(), ...this.pendingChecks()].sort((a, b) => a.openedAtUtc.localeCompare(b.openedAtUtc)),
  );

  // What this terminal did on the check that waits to reach the server.
  protected readonly waiting = computed(() => {
    const order = this.base();
    if (!order) return [];
    return this.offline.queue().filter((c) => c.orderId === order.id && !c.failed);
  });
  // The check with what waits applied: its lines, totals and state as the server will have them.
  private readonly view = computed(() => projectOrder(this.base(), this.waiting(), this.store.menu(), this.auth.me()?.fullName ?? ''));
  protected readonly current = computed(() => this.view()?.order ?? null);
  protected readonly waitingLineIds = computed(() => this.view()?.waitingLineIds ?? new Set<string>());
  protected readonly waitingCount = computed(() => this.view()?.waiting ?? 0);

  // Checks opened here while the server could not be reached, not yet paid: listed with the rest.
  private readonly pendingChecks = computed<OrderSummary[]>(() => {
    const known = new Set(this.store.open().map((o) => o.id));
    const queue = this.offline.queue().filter((c) => !c.failed);
    return queue
      .filter((c) => isOpening(c) && c.orderId && !known.has(c.orderId))
      .map((c) => {
        const base = this.pendingBase(c);
        const order = projectOrder(base, queue.filter((q) => q.orderId === c.orderId), this.store.menu(), base.openedBy)!.order;
        return order;
      })
      .filter((o) => o.status !== 'Paid')
      .map((o) => ({
        id: o.id, number: 0, type: o.type, status: o.status, tableLabel: o.tableLabel, checkLabel: null, guests: o.guests, openedBy: o.openedBy,
        openedAtUtc: o.openedAtUtc, customerName: null, total: o.totals.total, due: o.totals.due,
        items: o.lines.reduce((n, l) => n + l.quantity, 0), hasDrafts: o.lines.some((l) => l.status === 'Draft'), paidAtUtc: null,
      }));
  });

  protected readonly drafts = computed(() => this.current()?.lines.filter((l) => l.status === 'Draft' && l.quantity > 0) ?? []);
  protected readonly liveLines = computed(() => this.current()?.lines.filter((l) => l.quantity > 0) ?? []);
  // The line picked on the check, for Void in Discount / Void.
  protected readonly selected = computed(() => this.liveLines().find((l) => l.id === this.selectedLine()) ?? null);
  // Nothing reached the kitchen and nothing was paid: the check may simply be cancelled.
  protected readonly canCancel = computed(() => {
    const order = this.current();
    return !!order && !order.payments.length && !order.lines.some((l) => l.quantity > 0 && l.status !== 'Draft');
  });
  protected readonly closed = computed(() => ['Paid', 'Cancelled', 'Merged'].includes(this.current()?.status ?? ''));

  constructor() {
    this.live.ordersChanged.pipe(takeUntilDestroyed()).subscribe((ids) => {
      const order = this.base();
      if (order && ids.includes(order.id)) void this.reload(order.id, false);
    });
    this.live.shiftChanged.pipe(takeUntilDestroyed()).subscribe(() => void this.loadShift());
    effect(() => {
      const id = this.order();
      if (id) untracked(() => void this.reload(id));
    });
  }

  ngOnInit(): void {
    this.store.start();
    void this.loadShift();
  }

  // ---- Keyboard: F2 takeaway, F4 send, F8 the bill, F9 pay, / search, Escape clears ----

  @HostListener('window:keydown', ['$event'])
  protected key(event: KeyboardEvent): void {
    if (document.querySelector('.cdk-overlay-container .mat-mdc-dialog-container')) return;
    const typing = (event.target as HTMLElement)?.tagName === 'INPUT';
    switch (event.key) {
      case 'F2':
        event.preventDefault();
        void this.newCheck('Takeaway');
        break;
      case 'F4':
        event.preventDefault();
        void this.send();
        break;
      case 'F8':
        event.preventDefault();
        void this.printBill();
        break;
      case 'F9':
        event.preventDefault();
        void this.pay();
        break;
      case '/':
        if (!typing) {
          event.preventDefault();
          this.searchBox()?.nativeElement.focus();
        }
        break;
      case 'Escape':
        if (typing) this.search.set('');
        break;
    }
  }

  // ---- Checks ----

  protected async select(id: string): Promise<void> {
    this.selectedLine.set(null);
    await this.reload(id);
  }

  protected async newCheck(type: OrderType): Promise<void> {
    if (type === 'DineIn') {
      const floor = this.store.floor();
      if (!floor) return;
      const pick = await firstValueFrom(
        this.dialog.open<TablePickDialog, TablePickData, TablePick>(TablePickDialog, { data: { floor, mode: 'open' }, width: '720px', maxWidth: '96vw' }).afterClosed(),
      );
      if (!pick) return;
      // A table taken: its check.
      if (pick.table.checks.length) {
        await this.select(pick.table.checks[0].orderId);
        return;
      }
      await this.openCheck('DineIn', pick.table.id, pick.table.label, pick.guests);
      return;
    }
    await this.openCheck(type, null, null, 0);
  }

  // Opened by its id; the server unreachable, the terminal goes on with it as waiting.
  private async openCheck(type: OrderType, tableId: string | null, tableLabel: string | null, guests: number): Promise<Order | null> {
    const id = newId();
    const opened = await this.run(() => this.commands.open(type, tableId, guests, {}, id), 'The check could not be opened.');
    if (opened) return opened;
    if (this.offline.forOrder(id).length) {
      const waiting = pendingOrder(id, type, tableId, tableLabel, guests, this.auth.me()?.fullName ?? '', this.store.menu());
      this.base.set(waiting);
      this.store.markOpenedOffline(waiting);
      return waiting;
    }
    return null;
  }

  // A check opened here while the server could not be reached, from the command that opened it.
  private pendingBase(opening: QueuedCommand): Order {
    const body = opening.body as { orderId: string; type: OrderType; tableId: string | null; guests: number };
    const table = this.store.floor()?.tables.find((t) => t.id === body.tableId);
    return pendingOrder(body.orderId, body.type, body.tableId, table?.label ?? null, body.guests, this.auth.me()?.fullName ?? '', this.store.menu(),
      opening.createdAt);
  }

  protected async addItem(item: MenuItem): Promise<void> {
    let choice: ItemChoice | undefined = { sizeId: null, modifierIds: [], quantity: 1, notes: null };
    if (item.sizes.length || item.modifiers.length) {
      choice = await firstValueFrom(
        this.dialog
          .open<ItemOptionsDialog, ItemOptionsData, ItemChoice>(ItemOptionsDialog, {
            data: { item, quickNotes: this.store.menu()?.quickNotes ?? [] },
            width: '560px',
            maxWidth: '96vw',
          })
          .afterClosed(),
      );
      if (!choice) return;
    }
    // No check open: a takeaway, the quickest.
    if (!this.current() || this.closed()) {
      const opened = await this.openCheck('Takeaway', null, null, 0);
      if (!opened) return;
    }
    const order = this.current()!;
    // The same plain item tapped again while its line is still a draft: one more on that line.
    const plain = !choice.sizeId && !choice.modifierIds.length && !choice.notes;
    const same = plain
      ? order.lines.find((l) => l.menuItemId === item.id && l.status === 'Draft' && l.quantity > 0 && !l.sizeName && !l.modifiers && !l.notes)
      : undefined;
    if (same) {
      await this.run(() => this.commands.change(order, same.id, same.quantity + choice.quantity, null), `${item.name} could not be added.`);
      return;
    }
    const line: NewLine = { lineId: newId(), menuItemId: item.id, sizeId: choice.sizeId, modifierIds: choice.modifierIds, quantity: choice.quantity, notes: choice.notes };
    await this.run(() => this.commands.add(order, [line]), `${item.name} could not be added.`);
  }

  protected async changeQuantity(line: OrderLine, by: number): Promise<void> {
    const order = this.current();
    if (!order || line.status !== 'Draft') return;
    if (line.quantity + by < 1) {
      await this.voidLine(line);
      return;
    }
    await this.run(() => this.commands.change(order, line.id, line.quantity + by, line.notes), 'The item could not be changed.');
  }

  protected async send(): Promise<void> {
    const order = this.current();
    if (!order || !this.drafts().length) return;
    const sent = await this.run(() => this.commands.send(order), 'The order could not be sent to the kitchen.');
    if (sent?.tickets.length) this.notify.info(`Sent to the kitchen on KOT ${sent.tickets.at(-1)?.number}. · أُرسل للمطبخ.`);
  }

  protected async printBill(): Promise<void> {
    const order = this.current();
    if (!order || this.closed() || !this.liveLines().length) return;
    if (this.drafts().length) {
      this.notify.error(null, 'Send the new items to the kitchen first (F4). · أرسل الأصناف الجديدة أولاً.');
      return;
    }
    const billed = await this.run(() => this.commands.bill(order), 'The bill could not be printed.');
    if (billed) {
      await this.printer.printedHere('Bill', billed.id, this.store.menu()?.cashierPrintsInBrowser ?? true);
    } else if (this.current()?.status === 'BillPrinted') {
      // Waiting for the server: printed here, from the check as this terminal has it.
      await this.printer.printOrder(this.current()!, false);
    }
  }

  // method: how it is to be paid (Pay cash, Pay card); any way, or several, otherwise (F9).
  protected async pay(method?: PaymentMethod): Promise<void> {
    const order = this.current();
    if (!order || this.closed() || !this.canSettle()) return;
    if (!this.shift()) {
      this.notify.error(null, 'Open the shift before taking payments. · افتح الوردية أولاً.');
      return;
    }
    const choice = await firstValueFrom(
      this.dialog.open<PayDialog, PayData, PayChoice>(PayDialog, { data: { order, method }, width: '620px', maxWidth: '96vw' }).afterClosed(),
    );
    if (!choice?.payments.length) return;
    const paid = await this.run(() => this.commands.pay(order, choice.payments, choice.printReceipt), 'The payment could not be taken.');
    if (paid?.status === 'Paid') {
      const change = paid.payments.reduce((n, p) => n + p.change, 0);
      this.notify.info(`Paid${change ? `: change ${this.company.money(change)}` : ''}. · تم الدفع.`);
      if (choice.printReceipt) await this.printer.printedHere('Receipt', paid.id, this.store.menu()?.cashierPrintsInBrowser ?? true);
      return;
    }
    // Waiting for the server: settled here all the same. The receipt prints from this terminal's
    // copy, the table is free, and the payment goes to the server (with the rest) once it answers.
    const settled = paid ? null : this.current();
    if (settled?.status === 'Paid') {
      if (choice.printReceipt) await this.printer.printOrder(settled, true);
      this.store.settledOffline(settled);
      const change = settled.payments.reduce((n, p) => n + p.change, 0);
      this.notify.info(`Paid offline${change ? `: change ${this.company.money(change)}` : ''}. It reaches the server once it answers. · تم الدفع (وضع محلي).`);
    }
  }

  protected async voidLine(line: OrderLine): Promise<void> {
    const order = this.current();
    if (!order) return;
    const choice = await firstValueFrom(
      this.dialog
        .open<VoidDialog, VoidData, VoidChoice>(VoidDialog, {
          data: { line, reasons: this.store.menu()?.voidReasons ?? [], isManager: this.isManager() },
          width: '600px',
          maxWidth: '96vw',
        })
        .afterClosed(),
    );
    if (!choice) return;
    const voided = await this.run(
      () => this.commands.void(order, [{ lineId: line.id, quantity: choice.quantity }], choice.reason, choice.outcome, choice.managerPin),
      'The item could not be voided.',
    );
    if (voided && line.status !== 'Draft') this.notify.info('Voided: a VOID ticket went to the kitchen. · أُرسل بون إلغاء للمطبخ.');
  }

  // Discount / Void → Void: the line picked on the check.
  protected async voidSelected(): Promise<void> {
    const line = this.selected();
    if (line) await this.voidLine(line);
  }

  protected async split(): Promise<void> {
    const order = this.current();
    if (!order) return;
    const choice = await firstValueFrom(
      this.dialog.open<SplitDialog, SplitData, SplitChoice>(SplitDialog, { data: { order }, width: '560px', maxWidth: '96vw' }).afterClosed(),
    );
    if (!choice) return;
    if ('ways' in choice) {
      await this.direct(() => this.api.splitEvenly(order.id, choice.ways), 'The check could not be split.');
      return;
    }
    const result = await this.direct(() => this.api.split(order.id, newId(), choice.moves), 'The check could not be split.', false);
    if (result) {
      this.base.set(result.created);
      this.notify.info(`Check ${result.created.checkLabel} opened with what moved. · تم فصل الشيك.`);
    }
  }

  protected async transfer(): Promise<void> {
    const order = this.current();
    const floor = this.store.floor();
    if (!order?.tableId || !floor) return;
    const pick = await firstValueFrom(
      this.dialog
        .open<TablePickDialog, TablePickData, TablePick>(TablePickDialog, { data: { floor, mode: 'transfer', fromTableId: order.tableId }, width: '720px', maxWidth: '96vw' })
        .afterClosed(),
    );
    if (!pick) return;
    const moved = await this.direct(() => this.api.transfer(order.tableId!, pick.table.id), 'The table could not be moved.', false);
    if (moved) {
      this.base.set(moved.find((o) => o.id === order.id) ?? moved[0]);
      this.notify.info(`Moved to table ${pick.table.label}: the kitchen was told. · تم النقل.`);
    }
  }

  protected async merge(): Promise<void> {
    const order = this.current();
    const floor = this.store.floor();
    if (!order || !floor) return;
    const pick = await firstValueFrom(
      this.dialog
        .open<TablePickDialog, TablePickData, TablePick>(TablePickDialog, { data: { floor, mode: 'merge', fromTableId: order.tableId }, width: '720px', maxWidth: '96vw' })
        .afterClosed(),
    );
    const target = pick?.table.checks[0];
    if (!target) return;
    const merged = await this.direct(() => this.api.merge(target.orderId, order.id), 'The tables could not be merged.', false);
    if (merged) {
      this.base.set(merged);
      this.notify.info(`Merged into table ${pick!.table.label}. · تم الدمج.`);
    }
  }

  protected async discount(): Promise<void> {
    const order = this.current();
    if (!order) return;
    const choice = await firstValueFrom(
      this.dialog
        .open<DiscountDialog, DiscountData, DiscountChoice>(DiscountDialog, {
          data: { order, limitPercent: this.store.menu()?.cashierDiscountLimitPercent ?? 10, isManager: this.isManager() },
          width: '480px',
          maxWidth: '96vw',
        })
        .afterClosed(),
    );
    if (choice) await this.direct(() => this.api.discount(order.id, choice), 'The discount could not be given.');
  }

  protected async customer(): Promise<void> {
    if (!this.current() || this.closed()) {
      const opened = await this.run(() => this.commands.open('Takeaway', null, 0), 'The check could not be opened.');
      if (!opened) return;
    }
    const order = this.current()!;
    const picked = await firstValueFrom(this.dialog.open(CustomerDialog, { width: '640px', maxWidth: '96vw' }).afterClosed());
    if (picked) await this.direct(() => this.api.attachCustomer(order.id, picked.id), 'The customer could not be put on the check.');
  }

  protected async dropCustomer(): Promise<void> {
    const order = this.current();
    if (order) await this.direct(() => this.api.attachCustomer(order.id, null), 'The customer could not be taken off.');
  }

  protected async redeem(): Promise<void> {
    const order = this.current();
    if (!order || this.redeemPoints == null) return;
    await this.direct(() => this.api.redeem(order.id, this.redeemPoints ?? 0), 'The points could not be redeemed.');
    this.redeemPoints = null;
  }

  protected async cancel(): Promise<void> {
    const order = this.current();
    if (order && confirm(`Cancel check #${order.number}? Nothing has reached the kitchen. · إلغاء الشيك؟`)) {
      await this.direct(() => this.api.cancel(order.id, 'Cancelled at the till'), 'The check could not be cancelled.');
    }
  }

  protected async saveDelivery(field: 'deliveryAddress' | 'driverName' | 'customerName' | 'customerPhone', value: string): Promise<void> {
    const order = this.current();
    if (!order) return;
    await this.direct(
      () =>
        this.api.update(order.id, {
          guests: null,
          notes: order.notes,
          deliveryAddress: field === 'deliveryAddress' ? value : order.deliveryAddress,
          driverName: field === 'driverName' ? value : order.driverName,
          customerName: field === 'customerName' ? value : order.customer?.name ?? null,
          customerPhone: field === 'customerPhone' ? value : order.customer?.phone ?? null,
        }),
      'The delivery could not be saved.',
    );
  }

  protected async setGuests(by: number): Promise<void> {
    const order = this.current();
    if (!order || order.type !== 'DineIn') return;
    await this.direct(
      () =>
        this.api.update(order.id, {
          guests: Math.max(1, order.guests + by),
          notes: order.notes,
          deliveryAddress: null,
          driverName: null,
          customerName: null,
          customerPhone: null,
        }),
      'The guests could not be changed.',
    );
  }

  protected async reprint(): Promise<void> {
    const order = this.current();
    if (!order) return;
    const kind = order.status === 'Paid' ? 'Receipt' : 'Bill';
    // Waiting for the server: printed here from this terminal's copy.
    if (this.waitingCount()) {
      await this.printer.printOrder(order, kind === 'Receipt');
      return;
    }
    await this.direct(async () => {
      await firstValueFrom(this.api.print(kind, order.id));
      await this.printer.printedHere(kind, order.id, this.store.menu()?.cashierPrintsInBrowser ?? true);
      return order;
    }, 'It could not be printed.', false);
  }

  protected next(): void {
    this.base.set(null);
    this.selectedLine.set(null);
  }

  protected newCheckFromFloor(): void {
    void this.router.navigate(['/pos/floor']);
  }

  protected toggleChecks(): void {
    const shown = !this.checksShown();
    this.checksShown.set(shown);
    try {
      localStorage.setItem(ChecksShownKey, shown ? '1' : '0');
    } catch {
      // Kept for this page only.
    }
  }

  // A check in the strip: its table (T2·B), or its number (#12); one opened here, not yet numbered.
  protected where(o: OrderSummary): string {
    const at = o.tableLabel ? tableTag(o.tableLabel) : o.number ? `#${o.number}` : 'New';
    return o.checkLabel ? `${at}·${o.checkLabel}` : at;
  }

  protected age(utc: string): string {
    const minutes = Math.max(0, Math.round((Date.now() - new Date(utc).getTime()) / 60000));
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  // ---- Helpers ----

  // chosen: the check picked. Otherwise (another screen changed it) it is shown again only while it
  // is still the one on screen: a split or a move that put another there meanwhile stays.
  private async reload(id: string, chosen = true): Promise<void> {
    this.loading.set(true);
    try {
      const order = await firstValueFrom(this.api.order(id));
      if (chosen || this.base()?.id === id) this.base.set(order);
      void this.store.keep(order);
    } catch (error) {
      // The server cannot be reached: the check as this terminal last had it, or as it was opened here.
      const kept = isUnreachable(error) ? await this.keptCheck(id) : null;
      if (kept) {
        if (chosen || this.base()?.id === id) this.base.set(kept);
      } else {
        this.notify.error(error, 'The check could not be loaded.');
      }
    } finally {
      this.loading.set(false);
    }
  }

  private async keptCheck(id: string): Promise<Order | null> {
    const kept = await this.store.cachedOrder(id);
    if (kept) return kept;
    const opening = this.offline.queue().find((c) => c.orderId === id && isOpening(c));
    return opening ? this.pendingBase(opening) : null;
  }

  // Kept too: while the server cannot be reached the shift is the one last seen open.
  private async loadShift(): Promise<void> {
    try {
      this.shift.set((await this.offline.cached('shift', () => this.api.currentShift())).value);
    } catch {
      this.shift.set(undefined);
    }
  }

  // A command through the outbox: the check as the server has it now; when it waits, what was on
  // screen stays, the waiting shown beside it.
  private async run(call: () => Promise<Order | null>, failed: string): Promise<Order | null> {
    this.busy.set(true);
    try {
      const order = await call();
      if (order) {
        this.base.set(order);
        void this.store.keep(order);
      } else {
        this.notify.info('The server cannot be reached: it waits on this terminal and is sent once it can. · سيتم الإرسال عند الاتصال.');
      }
      return order;
    } catch (error) {
      this.notify.error(error, errorMessage(error, failed));
      return null;
    } finally {
      this.busy.set(false);
    }
  }

  // A command straight to the server: what needs it (a split, a move) is never left waiting.
  private async direct<T>(call: () => Observable<T> | Promise<T>, failed: string, setOrder = true): Promise<T | null> {
    this.busy.set(true);
    try {
      const result = call();
      const value = isObservable(result) ? await firstValueFrom(result) : await result;
      if (setOrder && value && (value as unknown as Order).lines) {
        this.base.set(value as unknown as Order);
        void this.store.keep(value as unknown as Order);
      }
      return value;
    } catch (error) {
      this.notify.error(error, errorMessage(error, failed));
      return null;
    } finally {
      this.busy.set(false);
    }
  }
}

const ChecksShownKey = 'pos.terminalChecksShown';

function readChecksShown(): boolean {
  try {
    return localStorage.getItem(ChecksShownKey) !== '0';
  } catch {
    return true;
  }
}

// The command that opened a check (POST /api/orders).
function isOpening(command: QueuedCommand): boolean {
  return command.method === 'POST' && command.url === '/api/orders';
}

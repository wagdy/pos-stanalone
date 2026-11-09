import { DatePipe } from '@angular/common';
import { Component, ElementRef, HostListener, OnInit, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';
import { Observable, firstValueFrom, isObservable } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { Permissions } from '../../../core/auth/permissions';
import { errorMessage } from '../../../core/http/error-message';
import { LiveService } from '../../../core/pos/live.service';
import { OfflineStore } from '../../../core/pos/offline';
import {
  MenuItem,
  NewLine,
  Order,
  OrderLine,
  OrderType,
  PosApi,
  Shift,
  lineStatusLabels,
  newId,
  orderTypeLabels,
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

// The cashier's terminal (نقطة البيع): the checks open, the menu, and the check being worked. Items
// go on as drafts and to the kitchen with Send to Kitchen (F4); more later go on an add-on ticket.
// The bill prints for the guest (F8), the check is paid (F9), voided, split, moved or merged; the
// customer's loyalty card is on the check. Every screen hears each change at once; what is done
// while the server cannot be reached waits in this terminal's outbox and is shown as waiting.
@Component({
  selector: 'app-terminal-page',
  imports: [DatePipe, FormsModule, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, MatMenuModule, MatProgressBarModule,
    MatTooltipModule, MoneyPipe, RouterLink],
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
  protected readonly statusLabels = lineStatusLabels;
  protected readonly types: OrderType[] = ['DineIn', 'Takeaway', 'Delivery'];

  protected readonly current = signal<Order | null>(null);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly category = signal<string | null>(null);
  protected readonly search = signal('');
  protected readonly selectedLine = signal<string | null>(null);
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

  // The open checks, by how they are served.
  protected readonly openByType = computed(() => {
    const open = this.store.open();
    return this.types.map((type) => ({ type, checks: open.filter((o) => o.type === type) }));
  });

  // What this terminal did on the check that waits to reach the server.
  protected readonly waiting = computed(() => {
    const order = this.current();
    if (!order) return [];
    return this.offline.queue().filter((c) => c.orderId === order.id && !c.failed);
  });
  protected readonly waitingLines = computed(() =>
    this.waiting().flatMap((c) =>
      ((c.body as { items?: NewLine[] } | null)?.items ?? [])
        .filter((l) => 'menuItemId' in l)
        .map((l) => ({ id: l.lineId, name: this.store.item(l.menuItemId)?.name ?? 'Item', quantity: l.quantity })),
    ),
  );

  protected readonly drafts = computed(() => this.current()?.lines.filter((l) => l.status === 'Draft' && l.quantity > 0) ?? []);
  protected readonly liveLines = computed(() => this.current()?.lines.filter((l) => l.quantity > 0) ?? []);
  // Nothing reached the kitchen and nothing was paid: the check may simply be cancelled.
  protected readonly canCancel = computed(() => {
    const order = this.current();
    return !!order && !order.payments.length && !order.lines.some((l) => l.quantity > 0 && l.status !== 'Draft');
  });
  protected readonly closed = computed(() => ['Paid', 'Cancelled', 'Merged'].includes(this.current()?.status ?? ''));

  constructor() {
    this.live.ordersChanged.pipe(takeUntilDestroyed()).subscribe((ids) => {
      const order = this.current();
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
      const waiting = pendingOrder(id, type, tableId, tableLabel, guests, this.auth.me()?.fullName ?? '');
      this.current.set(waiting);
      return waiting;
    }
    return null;
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
    if (!order || (!this.drafts().length && !this.waitingLines().length)) return;
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
    if (billed) await this.printer.printedHere('Bill', billed.id, this.store.menu()?.cashierPrintsInBrowser ?? true);
  }

  protected async pay(): Promise<void> {
    const order = this.current();
    if (!order || this.closed() || !this.canSettle()) return;
    if (!this.shift()) {
      this.notify.error(null, 'Open the shift before taking payments. · افتح الوردية أولاً.');
      return;
    }
    const choice = await firstValueFrom(
      this.dialog.open<PayDialog, PayData, PayChoice>(PayDialog, { data: { order }, width: '620px', maxWidth: '96vw' }).afterClosed(),
    );
    if (!choice?.payments.length) return;
    const paid = await this.run(() => this.commands.pay(order, choice.payments, choice.printReceipt), 'The payment could not be taken.');
    if (paid?.status === 'Paid') {
      const change = paid.payments.reduce((n, p) => n + p.change, 0);
      this.notify.info(`Paid${change ? `: change ${this.company.money(change)}` : ''}. · تم الدفع.`);
      if (choice.printReceipt) await this.printer.printedHere('Receipt', paid.id, this.store.menu()?.cashierPrintsInBrowser ?? true);
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
      this.current.set(result.created);
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
      this.current.set(moved.find((o) => o.id === order.id) ?? moved[0]);
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
      this.current.set(merged);
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
    await this.direct(async () => {
      await firstValueFrom(this.api.print(kind, order.id));
      await this.printer.printedHere(kind, order.id, this.store.menu()?.cashierPrintsInBrowser ?? true);
      return order;
    }, 'It could not be printed.', false);
  }

  protected newCheckFromFloor(): void {
    void this.router.navigate(['/pos/floor']);
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
      if (chosen || this.current()?.id === id) this.current.set(order);
    } catch (error) {
      this.notify.error(error, 'The check could not be loaded.');
    } finally {
      this.loading.set(false);
    }
  }

  private async loadShift(): Promise<void> {
    try {
      this.shift.set(await firstValueFrom(this.api.currentShift()));
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
        this.current.set(order);
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
      if (setOrder && value && (value as unknown as Order).lines) this.current.set(value as unknown as Order);
      return value;
    } catch (error) {
      this.notify.error(error, errorMessage(error, failed));
      return null;
    } finally {
      this.busy.set(false);
    }
  }
}

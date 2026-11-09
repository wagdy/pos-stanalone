import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { Permissions } from '../../../core/auth/permissions';
import { errorMessage } from '../../../core/http/error-message';
import { LiveService } from '../../../core/pos/live.service';
import { MenuItem, NewLine, Order, OrderLine, PosApi, Table, lineStatusLabels, newId } from '../../../core/pos/pos.api';
import { SyncStatus } from '../../../core/pos/sync-status.service';
import { MoneyPipe } from '../../../core/ui/money.pipe';
import { NotifyService } from '../../../core/ui/notify.service';
import { tableStateLabels } from '../floor/floor-page';
import { OrderCommands, PosStore } from '../pos-store';
import { StaffGate } from '../staff-gate';
import { GuestsData, GuestsDialog, ItemChoice, ItemOptionsData, ItemOptionsDialog, VoidChoice, VoidData, VoidDialog } from '../terminal/dialogs';

// The captain's app (/pos/captain), for a waiter's phone or tablet: signed in with their PIN, the
// zones and tables with their state; a table opened with its guests; items with their size,
// modifiers and kitchen notes (بدون بصل، تسوية زيادة) put on the check, sent to the kitchen, and the
// bill asked for. Every screen (the cashier, the kitchen, the printers) hears it at once.
@Component({
  selector: 'app-captain-page',
  imports: [FormsModule, MatButtonModule, MatIconModule, MatProgressBarModule, MoneyPipe, StaffGate],
  template: `
    <app-staff-gate titleEn="Captain" titleAr="الكابتن" icon="tablet_android" [permission]="Permissions.OrdersTake">
      <div class="captain">
        <header class="bar">
          @if (order()) {
            <button mat-icon-button (click)="back()" aria-label="Back to the tables"><mat-icon>arrow_back</mat-icon></button>
            <div class="title">
              <strong>Table {{ order()!.tableLabel }}{{ order()!.checkLabel ? ' · ' + order()!.checkLabel : '' }}</strong>
              <small>#{{ order()!.number }} · {{ order()!.guests }} guests · {{ order()!.totals.total | money }}</small>
            </div>
          } @else {
            <div class="title">
              <strong>{{ auth.me()?.fullName }}</strong>
              <small>Captain · الكابتن</small>
            </div>
          }
          <span class="spacer"></span>
          <span class="dot" [class]="sync.label().tone" [attr.aria-label]="sync.label().en" [title]="sync.label().en"></span>
          @if (sync.pending()) {
            <small class="pending">{{ sync.pending() }}</small>
          }
          <button mat-icon-button (click)="lock()" aria-label="Lock"><mat-icon>lock</mat-icon></button>
        </header>

        @if (busy()) {
          <mat-progress-bar mode="indeterminate" />
        }

        @if (!order()) {
          <!-- The tables -->
          <nav class="zones" aria-label="Zones">
            @for (z of zones(); track z.id) {
              <button type="button" class="chip" [class.on]="zone() === z.id" (click)="pickedZone.set(z.id)">{{ z.name }} <span class="ar">{{ z.nameAr }}</span></button>
            }
          </nav>
          <div class="tables">
            @for (t of tables(); track t.id) {
              <button type="button" class="table" [class]="t.state" (click)="openTable(t)" [disabled]="busy()"
                [attr.aria-label]="'Table ' + t.label + ', ' + stateLabels[t.state].en">
                <strong>{{ t.label }}</strong>
                <small>{{ stateLabels[t.state].en }} · {{ stateLabels[t.state].ar }}</small>
                @if (t.checks.length) {
                  <small class="amt">{{ t.checks[0].total | money }}{{ t.checks.length > 1 ? ' +' + (t.checks.length - 1) : '' }}</small>
                } @else {
                  <small><mat-icon inline>chair</mat-icon> {{ t.seats }}</small>
                }
              </button>
            }
          </div>
        } @else {
          <!-- The table's check -->
          <div class="tabs" role="tablist">
            <button type="button" role="tab" [class.on]="tab() === 'menu'" [attr.aria-selected]="tab() === 'menu'" (click)="tab.set('menu')">
              <mat-icon>restaurant_menu</mat-icon> Menu · المنيو
            </button>
            <button type="button" role="tab" [class.on]="tab() === 'check'" [attr.aria-selected]="tab() === 'check'" (click)="tab.set('check')">
              <mat-icon>receipt</mat-icon> Check · الشيك <span class="badge">{{ lines().length }}</span>
            </button>
          </div>

          @if (tab() === 'menu') {
            <div class="menu">
              <input class="search" type="search" placeholder="Search · بحث" [ngModel]="search()" (ngModelChange)="search.set($event)" aria-label="Search the menu" />
              <nav class="cats">
                @for (c of categories(); track c.id) {
                  <button type="button" class="chip" [class.on]="category() === c.id" [style.--cat]="c.color" (click)="pickedCategory.set(c.id)">{{ c.name }}</button>
                }
              </nav>
              <ul class="items">
                @for (i of items(); track i.id) {
                  <li>
                    <button type="button" class="item" (click)="options(i)">
                      <span class="name"><strong>{{ i.name }}</strong> <span class="ar">{{ i.nameAr }}</span></span>
                      <span class="price">{{ (i.sizes[0]?.price ?? i.price) | money }}</span>
                    </button>
                    <button mat-icon-button class="quick" (click)="quickAdd(i)" [attr.aria-label]="'Add one ' + i.name"><mat-icon>add_circle</mat-icon></button>
                  </li>
                }
              </ul>
            </div>
          } @else {
            <ul class="lines">
              @for (l of lines(); track l.id) {
                <li [class]="l.status">
                  <span class="q">{{ l.quantity }}×</span>
                  <span class="n">
                    <strong>{{ l.name }}{{ l.sizeName ? ' (' + l.sizeName + ')' : '' }}</strong>
                    @if (l.modifiers) {
                      <small>+ {{ l.modifiers }}</small>
                    }
                    @if (l.notes) {
                      <small class="note">{{ l.notes }}</small>
                    }
                    <small class="st">{{ statusLabels[l.status].en }} · {{ statusLabels[l.status].ar }}</small>
                  </span>
                  <span class="t">{{ l.total | money }}</span>
                  <span class="acts">
                    @if (l.status === 'Draft') {
                      <button mat-icon-button (click)="change(l, -1)" aria-label="One less"><mat-icon>remove</mat-icon></button>
                      <button mat-icon-button (click)="change(l, 1)" aria-label="One more"><mat-icon>add</mat-icon></button>
                    } @else {
                      <button mat-icon-button (click)="voidLine(l)" aria-label="Void"><mat-icon>block</mat-icon></button>
                    }
                  </span>
                </li>
              } @empty {
                <li class="empty">Nothing on the check yet: add from the menu. · أضف من المنيو</li>
              }
              @for (w of waiting(); track w) {
                <li class="waiting">{{ w }} · waiting to sync</li>
              }
            </ul>
          }

          <footer class="actions">
            <button mat-flat-button class="send" (click)="send()" [disabled]="busy() || !drafts()">
              <mat-icon>soup_kitchen</mat-icon> Send to kitchen{{ drafts() ? ' (' + drafts() + ')' : '' }} · إرسال
            </button>
            <button mat-stroked-button (click)="bill()" [disabled]="busy() || !lines().length || drafts() > 0">
              <mat-icon>receipt_long</mat-icon> Bill · الحساب
            </button>
          </footer>
        }
      </div>
    </app-staff-gate>
  `,
  styles: `
    :host {
      display: block;
      min-height: 100dvh;
      background: var(--mat-sys-surface-container-low);
    }
    .captain {
      display: flex;
      flex-direction: column;
      min-height: 100dvh;
      max-width: 820px;
      margin: 0 auto;
    }
    .bar {
      position: sticky;
      top: 0;
      z-index: 3;
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 56px;
      padding: 4px 8px 4px 14px;
      background: var(--mat-sys-surface-container-lowest);
      border-bottom: 1px solid var(--app-line);
    }
    .title {
      display: grid;
      min-width: 0;

      strong {
        font-size: 17px;
      }
      small {
        color: var(--mat-sys-on-surface-variant);
      }
    }
    .ar {
      direction: rtl;
      unicode-bidi: isolate;
      opacity: 0.75;
    }
    .dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--app-ok);

      &.warn {
        background: #f59e0b;
      }
      &.bad {
        background: var(--mat-sys-error);
      }
    }
    .pending {
      font-weight: 700;
    }
    .zones,
    .cats {
      display: flex;
      gap: 6px;
      padding: 10px 12px;
      overflow-x: auto;
    }
    .chip {
      flex: none;
      height: 40px;
      padding: 0 16px;
      border: 1.5px solid var(--cat, var(--app-line-strong));
      border-radius: 999px;
      background: var(--mat-sys-surface-container-lowest);
      color: inherit;
      font: var(--mat-sys-label-large);

      &.on {
        background: var(--cat, var(--mat-sys-primary));
        border-color: var(--cat, var(--mat-sys-primary));
        color: #fff;
      }
    }
    .tables {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
      gap: 10px;
      padding: 0 12px 16px;
    }
    .table {
      display: grid;
      justify-items: center;
      gap: 2px;
      padding: 14px 6px;
      border: 2px solid var(--app-line-strong);
      border-radius: 18px;
      background: var(--mat-sys-surface-container-lowest);
      color: inherit;
      font: inherit;
      touch-action: manipulation;

      strong {
        font-size: 24px;
      }
      small {
        font-size: 11.5px;
        color: var(--mat-sys-on-surface-variant);
      }
      .amt {
        font-weight: 700;
        color: var(--mat-sys-on-surface);
      }
      &.Occupied {
        border-color: #f59e0b;
        background: color-mix(in srgb, #f59e0b 14%, var(--mat-sys-surface-container-lowest));
      }
      &.BillRequested {
        border-color: #db2777;
        background: color-mix(in srgb, #db2777 12%, var(--mat-sys-surface-container-lowest));
      }
    }
    .tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      background: var(--mat-sys-surface-container-lowest);
      border-bottom: 1px solid var(--app-line);

      button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        height: 48px;
        border: 0;
        border-bottom: 3px solid transparent;
        background: transparent;
        color: var(--mat-sys-on-surface-variant);
        font: var(--mat-sys-label-large);

        &.on {
          border-bottom-color: var(--mat-sys-primary);
          color: var(--mat-sys-primary);
        }
      }
      .badge {
        min-width: 20px;
        padding: 0 6px;
        border-radius: 999px;
        background: var(--mat-sys-primary);
        color: var(--mat-sys-on-primary);
        font-size: 12px;
        line-height: 20px;
      }
    }
    .menu {
      flex: 1;
    }
    .search {
      box-sizing: border-box;
      width: calc(100% - 24px);
      height: 44px;
      margin: 10px 12px 0;
      padding: 0 14px;
      border: 1px solid var(--app-line-strong);
      border-radius: 12px;
      background: var(--mat-sys-surface-container-lowest);
      color: inherit;
      font: inherit;
    }
    .items,
    .lines {
      flex: 1;
      margin: 0;
      padding: 0 12px 96px;
      list-style: none;
    }
    .items li {
      display: flex;
      align-items: center;
      margin-bottom: 6px;
      border-radius: 14px;
      background: var(--mat-sys-surface-container-lowest);
      border: 1px solid var(--app-line);
    }
    .item {
      display: flex;
      flex: 1;
      align-items: center;
      gap: 8px;
      min-height: 56px;
      padding: 8px 12px;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: start;

      .name {
        display: grid;
        flex: 1;
      }
      .price {
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
    }
    .quick {
      color: var(--mat-sys-primary);
    }
    .lines {
      padding-top: 8px;

      li {
        display: grid;
        grid-template-columns: 34px 1fr auto;
        grid-template-areas: 'q n t' 'q n a';
        align-items: start;
        gap: 0 8px;
        padding: 10px;
        margin-bottom: 6px;
        border-radius: 14px;
        background: var(--mat-sys-surface-container-lowest);
        border: 1px solid var(--app-line);
      }
      li.Draft {
        border-color: #f59e0b;
      }
      .q {
        grid-area: q;
        font-weight: 800;
        font-size: 18px;
      }
      .n {
        grid-area: n;
        display: grid;
        gap: 2px;
      }
      .note {
        color: #b45309;
        font-weight: 700;
      }
      .st {
        color: var(--mat-sys-on-surface-variant);
      }
      .t {
        grid-area: t;
        font-weight: 700;
      }
      .acts {
        grid-area: a;
        justify-self: end;
      }
      .empty,
      .waiting {
        display: block;
        color: var(--mat-sys-on-surface-variant);
      }
    }
    .actions {
      position: sticky;
      bottom: 0;
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 8px;
      margin-top: auto;
      padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
      background: var(--mat-sys-surface-container-lowest);
      border-top: 1px solid var(--app-line);

      button {
        height: 52px;
      }
      .send {
        font-size: 16px;
      }
    }
  `,
})
export class CaptainPage {
  protected readonly auth = inject(AuthService);
  protected readonly sync = inject(SyncStatus);
  protected readonly store = inject(PosStore);
  private readonly live = inject(LiveService);
  private readonly api = inject(PosApi);
  private readonly commands = inject(OrderCommands);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotifyService);
  protected readonly Permissions = Permissions;
  protected readonly stateLabels = tableStateLabels;
  protected readonly statusLabels = lineStatusLabels;

  protected readonly order = signal<Order | null>(null);
  protected readonly tab = signal<'menu' | 'check'>('menu');
  protected readonly busy = signal(false);
  protected readonly search = signal('');
  protected readonly pickedZone = signal<string | null>(null);
  protected readonly pickedCategory = signal<string | null>(null);

  protected readonly zones = computed(() => [...(this.store.floor()?.zones ?? [])].sort((a, b) => a.sortOrder - b.sortOrder));
  protected readonly zone = computed(() => this.pickedZone() ?? this.zones()[0]?.id ?? null);
  protected readonly tables = computed(() => (this.store.floor()?.tables ?? []).filter((t) => t.zoneId === this.zone() && t.isActive));
  protected readonly categories = computed(() => (this.store.menu()?.categories ?? []).filter((c) => c.isActive));
  protected readonly category = computed(() => this.pickedCategory() ?? this.categories()[0]?.id ?? null);
  protected readonly items = computed(() => {
    const text = this.search().trim().toLowerCase();
    return (this.store.menu()?.items ?? []).filter(
      (i) =>
        i.isActive &&
        (text ? i.name.toLowerCase().includes(text) || (i.nameAr ?? '').includes(text) || String(i.code).startsWith(text) : i.categoryId === this.category()),
    );
  });
  protected readonly lines = computed(() => this.order()?.lines.filter((l) => l.quantity > 0) ?? []);
  protected readonly drafts = computed(() => this.lines().filter((l) => l.status === 'Draft').reduce((n, l) => n + l.quantity, 0));
  protected readonly waiting = computed(() => {
    const id = this.order()?.id;
    return id ? this.sync.offline.queue().filter((c) => c.orderId === id && !c.failed).map((c) => c.label) : [];
  });

  constructor() {
    effect(() => {
      if (this.auth.isSignedIn() && this.auth.can(Permissions.OrdersTake)) {
        untracked(() => {
          this.store.start();
          this.sync.start();
        });
      }
    });
    this.live.ordersChanged.pipe(takeUntilDestroyed()).subscribe((ids) => {
      const order = this.order();
      if (order && ids.includes(order.id)) void this.reload(order.id, false);
    });
  }

  protected async openTable(table: Table): Promise<void> {
    if (table.checks.length) {
      await this.reload(table.checks[0].orderId);
      this.tab.set(this.lines().length ? 'check' : 'menu');
      return;
    }
    const guests = await firstValueFrom(
      this.dialog.open<GuestsDialog, GuestsData, number>(GuestsDialog, { data: { tableLabel: table.label, seats: table.seats }, width: '420px', maxWidth: '96vw' }).afterClosed(),
    );
    if (!guests) return;
    const opened = await this.run(() => this.commands.open('DineIn', table.id, guests), 'The table could not be opened.');
    if (opened) this.tab.set('menu');
  }

  protected async options(item: MenuItem): Promise<void> {
    const choice = await firstValueFrom(
      this.dialog
        .open<ItemOptionsDialog, ItemOptionsData, ItemChoice>(ItemOptionsDialog, {
          data: { item, quickNotes: this.store.menu()?.quickNotes ?? [] },
          width: '560px',
          maxWidth: '100vw',
        })
        .afterClosed(),
    );
    if (choice) await this.add(item, choice);
  }

  protected async quickAdd(item: MenuItem): Promise<void> {
    if (item.sizes.length > 1) {
      await this.options(item);
      return;
    }
    await this.add(item, { sizeId: item.sizes[0]?.id ?? null, modifierIds: [], quantity: 1, notes: null });
  }

  protected async change(line: OrderLine, by: number): Promise<void> {
    const order = this.order();
    if (!order) return;
    if (line.quantity + by < 1) {
      await this.run(() => this.commands.void(order, [{ lineId: line.id, quantity: line.quantity }], null, 'None', null), 'The item could not be removed.');
      return;
    }
    await this.run(() => this.commands.change(order, line.id, line.quantity + by, line.notes), 'The item could not be changed.');
  }

  protected async voidLine(line: OrderLine): Promise<void> {
    const order = this.order();
    if (!order) return;
    const choice = await firstValueFrom(
      this.dialog
        .open<VoidDialog, VoidData, VoidChoice>(VoidDialog, {
          data: { line, reasons: this.store.menu()?.voidReasons ?? [], isManager: this.auth.can(Permissions.OrdersAuthorize) },
          width: '600px',
          maxWidth: '100vw',
        })
        .afterClosed(),
    );
    if (!choice) return;
    await this.run(
      () => this.commands.void(order, [{ lineId: line.id, quantity: choice.quantity }], choice.reason, choice.outcome, choice.managerPin),
      'The item could not be voided.',
    );
  }

  protected async send(): Promise<void> {
    const order = this.order();
    if (!order) return;
    const sent = await this.run(() => this.commands.send(order), 'The order could not be sent.');
    if (sent) {
      this.notify.info(`Sent on KOT ${sent.tickets.at(-1)?.number}. · أُرسل للمطبخ`);
      this.tab.set('check');
    }
  }

  // The bill printed at the cashier (the print station): the table shows it asked.
  protected async bill(): Promise<void> {
    const order = this.order();
    if (!order) return;
    const billed = await this.run(() => this.commands.bill(order), 'The bill could not be asked for.');
    if (billed) this.notify.info('The bill is printing at the cashier. · جاري طباعة الحساب');
  }

  protected back(): void {
    this.order.set(null);
    this.search.set('');
  }

  protected lock(): void {
    this.order.set(null);
    void this.live.stop();
    this.sync.stop();
    this.auth.lock();
  }

  private async add(item: MenuItem, choice: ItemChoice): Promise<void> {
    const order = this.order();
    if (!order) return;
    // Tapped again while its line is still a draft: one more on that line.
    const plain = !choice.sizeId && !choice.modifierIds.length && !choice.notes;
    const same = plain
      ? order.lines.find((l) => l.menuItemId === item.id && l.status === 'Draft' && l.quantity > 0 && !l.sizeName && !l.modifiers && !l.notes)
      : undefined;
    if (same) {
      const changed = await this.run(() => this.commands.change(order, same.id, same.quantity + choice.quantity, null), `${item.name} could not be added.`);
      if (changed) this.notify.info(`${same.quantity + choice.quantity}× ${item.name} · أُضيف`);
      return;
    }
    const line: NewLine ={ lineId: newId(), menuItemId: item.id, sizeId: choice.sizeId, modifierIds: choice.modifierIds, quantity: choice.quantity, notes: choice.notes };
    const added = await this.run(() => this.commands.add(order, [line]), `${item.name} could not be added.`);
    if (added) this.notify.info(`${choice.quantity}× ${item.name} added · أُضيف`);
  }

  // A change heard from another screen shows only while that check is still the one open here.
  private async reload(id: string, chosen = true): Promise<void> {
    try {
      const order = await firstValueFrom(this.api.order(id));
      if (chosen || this.order()?.id === id) this.order.set(order);
    } catch (error) {
      this.notify.error(error, 'The check could not be loaded.');
    }
  }

  private async run(call: () => Promise<Order | null>, failed: string): Promise<Order | null> {
    this.busy.set(true);
    try {
      const order = await call();
      if (order) this.order.set(order);
      else this.notify.info('Offline: it waits on this phone and is sent once the server answers. · سيتم الإرسال عند الاتصال');
      return order;
    } catch (error) {
      this.notify.error(error, errorMessage(error, failed));
      return null;
    } finally {
      this.busy.set(false);
    }
  }
}

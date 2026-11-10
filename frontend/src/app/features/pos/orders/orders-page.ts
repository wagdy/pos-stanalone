import { DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../../core/http/error-message';
import { LiveService } from '../../../core/pos/live.service';
import {
  Order,
  OrderStatus,
  OrderSummary,
  PosApi,
  PosSettings,
  TicketSummary,
  lineStatusLabels,
  orderTypeLabels,
  paymentLabels,
  ticketKindLabels,
} from '../../../core/pos/pos.api';
import { checkHtml, ticketHtml } from '../../../core/pos/print';
import { Company } from '../../../core/settings/company';
import { MoneyPipe } from '../../../core/ui/money.pipe';
import { NotifyService } from '../../../core/ui/notify.service';
import { PrintPreviewData, PrintPreviewDialog } from '../print-preview';

type Filter = 'all' | 'open' | 'paid' | 'cancelled';

// The day's checks (الشيكات): each with its items, voids (before and after the kitchen), payments
// and kitchen tickets. The check picked is shown beside the list as a slip of thermal paper; the
// check, the receipt or any of its tickets can be seen exactly as the 80 mm printer prints them, and
// printed again.
@Component({
  selector: 'app-orders-page',
  imports: [DatePipe, FormsModule, MatButtonModule, MatIconModule, MatProgressBarModule, MoneyPipe],
  template: `
    <div class="toolbar">
      <h1>Checks &amp; receipts <span class="inline-ar">الشيكات والإيصالات</span></h1>
      <span class="spacer"></span>
      <input type="date" [ngModel]="date()" (ngModelChange)="setDate($event)" aria-label="Day" />
      <label class="find">
        <mat-icon>search</mat-icon>
        <input type="search" placeholder="Check no., table, customer · بحث" [ngModel]="search()" (ngModelChange)="search.set($event)" aria-label="Find a check" />
      </label>
    </div>
    <div class="filters" role="tablist">
      @for (f of filters; track f.key) {
        <button type="button" role="tab" class="chip" [class.on]="filter() === f.key" (click)="filter.set(f.key)">{{ f.en }} · {{ f.ar }} <span>{{ count(f.key) }}</span></button>
      }
      <span class="spacer"></span>
      <span class="sum">Paid today: <strong>{{ paidTotal() | money }}</strong></span>
    </div>
    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }

    <div class="split">
      <div class="table-wrap">
        <table class="grid">
          <thead>
            <tr><th>#</th><th>Type</th><th>Table / customer</th><th>Opened</th><th>Status</th><th class="num">Total</th></tr>
          </thead>
          <tbody>
            @for (o of shown(); track o.id) {
              <tr class="clickable" [class.on]="selected()?.id === o.id" (click)="select(o.id)">
                <td><strong>{{ o.number }}</strong>{{ o.checkLabel ? '·' + o.checkLabel : '' }}</td>
                <td>{{ typeLabels[o.type].en }}</td>
                <td>{{ o.tableLabel ? 'Table ' + o.tableLabel : '' }}{{ o.customerName ? (o.tableLabel ? ' · ' : '') + o.customerName : '' }}</td>
                <td>{{ o.openedAtUtc | date: 'HH:mm' }} · {{ o.openedBy }}</td>
                <td><span class="tag" [class]="tone(o.status)">{{ o.status }}</span></td>
                <td class="num">{{ o.total | money }}</td>
              </tr>
            } @empty {
              <tr><td colspan="6" class="muted">No checks.</td></tr>
            }
          </tbody>
        </table>
      </div>

      <aside class="detail">
        @if (selected(); as o) {
          <div class="detail-head">
            <h2>Check #{{ o.number }}{{ o.checkLabel ? ' · ' + o.checkLabel : '' }}</h2>
            <span class="tag" [class]="tone(o.status)">{{ o.status }}</span>
          </div>
          <div class="acts">
            <button mat-stroked-button (click)="previewCheck(o, false)"><mat-icon>receipt</mat-icon> Check preview</button>
            @if (o.status === 'Paid') {
              <button mat-stroked-button (click)="previewCheck(o, true)"><mat-icon>receipt_long</mat-icon> Receipt preview</button>
            }
            <button mat-stroked-button (click)="reprint(o)"><mat-icon>print</mat-icon> Reprint</button>
            @if (o.status === 'Open' || o.status === 'BillPrinted') {
              <button mat-flat-button (click)="openInTerminal(o)"><mat-icon>point_of_sale</mat-icon> Open</button>
            }
          </div>

          <!-- The check as a slip of thermal paper -->
          <div class="paper">
            <article class="receipt" [attr.aria-label]="'Check ' + o.number + ' as printed'">
              <header class="r-head">
                <strong class="r-company">{{ company.name() }}</strong>
                <span class="r-kind">{{ o.status === 'Paid' ? 'RECEIPT · إيصال' : 'CHECK · شيك' }}</span>
                <span class="r-row"><span>Check #{{ o.number }}{{ o.checkLabel ? ' · ' + o.checkLabel : '' }}</span><span>{{ o.openedAtUtc | date: 'dd/MM HH:mm' }}</span></span>
                <span class="r-row"><span>{{ typeLabels[o.type].en }}{{ o.tableLabel ? ' · Table ' + o.tableLabel : '' }}</span><span>{{ o.guests }} guests</span></span>
                <span class="r-row"><span>By {{ o.openedBy }}</span>@if (o.settledBy) {<span>Settled {{ o.settledBy }}</span>}</span>
                @if (o.customer?.name) {
                  <span class="r-row"><span>{{ o.customer!.name }} {{ o.customer!.phone }}</span>@if (o.pointsEarned) {<span>+{{ o.pointsEarned }} pts</span>}</span>
                }
              </header>

              <ul class="r-lines">
                @for (l of o.lines; track l.id) {
                  <li [class.gone]="l.quantity === 0">
                    <span class="r-item">{{ l.quantity }}× <bdi>{{ l.name }}</bdi>{{ l.sizeName ? ' (' + l.sizeName + ')' : '' }}</span>
                    <span class="r-amt">{{ l.total | money }}</span>
                    @if (l.modifiers) {
                      <small>+ {{ l.modifiers }}</small>
                    }
                    <small class="r-state">{{ statusLabels[l.status].en }}</small>
                  </li>
                }
              </ul>

              @if (o.voids.length) {
                <p class="r-section">VOIDS · الإلغاءات</p>
                <ul class="r-lines">
                  @for (v of o.voids; track v.id) {
                    <li>
                      <span class="r-item">{{ v.quantity }}× <bdi>{{ v.itemName }}</bdi> <b>{{ v.kind === 'AfterKitchen' ? 'AFTER' : 'BEFORE' }}</b></span>
                      <span class="r-amt">{{ v.amount | money }}</span>
                      <small>{{ v.reason ?? '' }}{{ v.outcome === 'Waste' ? ' · waste' : v.outcome === 'ReturnToStock' ? ' · back to stock' : '' }}{{ v.authorizedBy ? ' · ' + v.authorizedBy : '' }}</small>
                    </li>
                  }
                </ul>
              }

              <dl class="r-totals">
                <div><dt>Subtotal</dt><dd>{{ o.totals.gross | money }}</dd></div>
                @if (o.totals.lineDiscounts + o.totals.billDiscount + o.totals.redemption > 0) {
                  <div><dt>Discounts</dt><dd>−{{ o.totals.lineDiscounts + o.totals.billDiscount + o.totals.redemption | money }}</dd></div>
                }
                @if (o.totals.service) {
                  <div><dt>Service</dt><dd>{{ o.totals.service | money }}</dd></div>
                }
                <div><dt>VAT</dt><dd>{{ o.totals.tax | money }}</dd></div>
                <div class="grand"><dt>TOTAL</dt><dd>{{ o.totals.total | money }}</dd></div>
              </dl>

              @if (o.payments.length) {
                <p class="r-section">PAYMENTS · المدفوعات</p>
                <ul class="r-lines">
                  @for (p of o.payments; track p.id) {
                    <li>
                      <span class="r-item">{{ payLabels[p.method].en }}</span>
                      <span class="r-amt">{{ p.amount | money }}</span>
                      <small>{{ p.atUtc | date: 'HH:mm' }} · {{ p.by }}{{ p.change ? ' · change ' + (p.change | money) : '' }}</small>
                    </li>
                  }
                </ul>
              }
              <p class="r-foot">Thank you · شكراً لزيارتكم</p>
            </article>
          </div>

          @if (o.tickets.length) {
            <h3>Kitchen tickets · بونات المطبخ</h3>
            <div class="tickets">
              @for (t of o.tickets; track t.id) {
                <button mat-stroked-button (click)="previewTicket(t)"><mat-icon>soup_kitchen</mat-icon> KOT {{ t.number }} · {{ kindLabels[t.kind].en }}</button>
              }
            </div>
          }
        } @else {
          <div class="pick">
            <mat-icon>receipt_long</mat-icon>
            <p>Pick a check to see it. · اختر شيكاً</p>
          </div>
        }
      </aside>
    </div>
  `,
  styleUrl: '../../shared/pages.scss',
  styles: `
    h1 {
      margin: 0;
      font: var(--mat-sys-headline-small);
      font-weight: 650;
    }
    .muted {
      color: var(--mat-sys-on-surface-variant);
    }
    input[type='date'] {
      height: 40px;
      padding: 0 10px;
      border: 1px solid var(--app-line-strong);
      border-radius: 10px;
      background: var(--mat-sys-surface-container-lowest);
      color: inherit;
      font: inherit;
    }
    // The search: wide enough for its hint whole.
    .find {
      display: flex;
      flex: 0 1 360px;
      align-items: center;
      gap: 6px;
      min-width: min(320px, 100%);
      height: 40px;
      padding: 0 12px;
      box-sizing: border-box;
      border: 1px solid var(--app-line-strong);
      border-radius: 10px;
      background: var(--mat-sys-surface-container-lowest);

      mat-icon {
        flex: none;
        color: var(--mat-sys-on-surface-variant);
      }
      input {
        flex: 1;
        min-width: 0;
        height: 100%;
        border: 0;
        outline: 0;
        background: transparent;
        color: inherit;
        font: inherit;
      }
      &:focus-within {
        border-color: var(--app-indigo-500, #6366f1);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-indigo-500, #6366f1) 18%, transparent);
      }
    }
    .filters {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin-bottom: 10px;
    }
    .chip {
      height: 34px;
      padding: 0 12px;
      border: 1px solid var(--app-line-strong);
      border-radius: 999px;
      background: transparent;
      color: inherit;
      font: var(--mat-sys-label-large);
      cursor: pointer;

      &.on {
        background: var(--mat-sys-primary);
        border-color: var(--mat-sys-primary);
        color: var(--mat-sys-on-primary);
      }
    }
    .split {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 380px;
      gap: 14px;
      align-items: start;
    }
    tr.on > td {
      background: var(--mat-sys-primary-container) !important;
    }
    .detail {
      position: sticky;
      top: calc(var(--app-sticky-top, 0px) + 16px);
      max-height: calc(100dvh - var(--app-sticky-top, 0px) - 32px);
      overflow-y: auto;
      padding: 14px;
      box-sizing: border-box;
      border-radius: 16px;
      border: 1px solid var(--app-line);
      background: var(--mat-sys-surface-container-low);
      box-shadow: var(--app-card-shadow);

      h3 {
        margin: 16px 0 6px;
        font: var(--mat-sys-title-small);
      }
    }
    .detail-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;

      h2 {
        margin: 0;
        font: var(--mat-sys-title-large);
      }
    }
    .acts,
    .tickets {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .pick {
      display: grid;
      justify-items: center;
      gap: 6px;
      padding: 48px 12px;
      color: var(--mat-sys-on-surface-variant);
      text-align: center;

      mat-icon {
        width: 48px;
        height: 48px;
        font-size: 48px;
        opacity: 0.35;
      }
    }

    // A slip of 80 mm paper: white whatever the theme, mono type, dashed rules, a torn foot.
    .paper {
      margin: 14px auto 18px;
      max-width: 320px;
      filter: drop-shadow(0 8px 14px rgb(15 23 42 / 16%)) drop-shadow(0 1px 1px rgb(15 23 42 / 10%));
    }
    .receipt {
      --paper: #fffefa;
      position: relative;
      padding: 18px 16px 14px;
      background: var(--paper);
      color: #111827;
      font: 12.5px/1.45 ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;

      &::after {
        content: '';
        position: absolute;
        inset: auto 0 -7px;
        height: 7px;
        background: conic-gradient(from -45deg at 50% 100%, var(--paper) 90deg, transparent 0) 0 0 / 12px 100% repeat-x;
      }
    }
    .r-head {
      display: grid;
      gap: 1px;
      padding-bottom: 8px;
      margin-bottom: 6px;
      border-bottom: 1px dashed #9ca3af;
      text-align: center;
    }
    .r-company {
      font-size: 15px;
      font-weight: 800;
      letter-spacing: 0.02em;
    }
    .r-kind {
      margin-bottom: 4px;
      font-weight: 700;
      letter-spacing: 0.12em;
    }
    .r-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 11.5px;
      text-align: start;
    }
    .r-section {
      margin: 8px 0 2px;
      padding-top: 6px;
      border-top: 1px dashed #9ca3af;
      font-weight: 700;
      letter-spacing: 0.08em;
    }
    .r-lines {
      margin: 0;
      padding: 0;
      list-style: none;

      li {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 0 8px;
        padding: 3px 0;
      }
      .r-item {
        overflow-wrap: anywhere;
      }
      .r-amt {
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      small {
        grid-column: 1 / -1;
        padding-inline-start: 2ch;
        color: #4b5563;
        font-size: 11px;
      }
      .gone {
        color: #9ca3af;
        text-decoration: line-through;
      }
      b {
        font-size: 10px;
        letter-spacing: 0.06em;
      }
    }
    .r-totals {
      margin: 6px 0 0;
      padding-top: 6px;
      border-top: 1px dashed #9ca3af;

      div {
        display: flex;
        justify-content: space-between;
      }
      dt,
      dd {
        margin: 0;
      }
      dd {
        font-variant-numeric: tabular-nums;
      }
      .grand {
        margin-top: 4px;
        padding-top: 4px;
        border-top: 2px solid #111827;
        font-size: 15px;
        font-weight: 800;
      }
    }
    .r-foot {
      margin: 10px 0 0;
      padding-top: 6px;
      border-top: 1px dashed #9ca3af;
      text-align: center;
      font-size: 11.5px;
    }
    @media (max-width: 1099.98px) {
      .split {
        grid-template-columns: minmax(0, 1fr);
      }
      .detail {
        position: static;
        max-height: none;
      }
    }
  `,
})
export class OrdersPage implements OnInit {
  private readonly api = inject(PosApi);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotifyService);
  private readonly router = inject(Router);
  protected readonly company = inject(Company);
  private readonly live = inject(LiveService);
  protected readonly typeLabels = orderTypeLabels;
  protected readonly statusLabels = lineStatusLabels;
  protected readonly payLabels = paymentLabels;
  protected readonly kindLabels = ticketKindLabels;
  protected readonly filters: { key: Filter; en: string; ar: string }[] = [
    { key: 'all', en: 'All', ar: 'الكل' },
    { key: 'open', en: 'Open', ar: 'مفتوح' },
    { key: 'paid', en: 'Paid', ar: 'مدفوع' },
    { key: 'cancelled', en: 'Cancelled', ar: 'ملغي' },
  ];

  protected readonly date = signal(today());
  protected readonly orders = signal<OrderSummary[]>([]);
  protected readonly selected = signal<Order | null>(null);
  protected readonly filter = signal<Filter>('all');
  protected readonly search = signal('');
  protected readonly loading = signal(false);
  private settings: PosSettings | null = null;

  protected readonly shown = computed(() => {
    const text = this.search().trim().toLowerCase();
    return this.orders().filter(
      (o) =>
        this.matches(o.status, this.filter()) &&
        (!text || String(o.number) === text || (o.tableLabel ?? '').toLowerCase() === text || (o.customerName ?? '').toLowerCase().includes(text)),
    );
  });
  protected readonly paidTotal = computed(() => this.orders().filter((o) => o.status === 'Paid').reduce((n, o) => n + o.total, 0));

  constructor() {
    this.live.ordersChanged.pipe(takeUntilDestroyed()).subscribe((ids) => {
      void this.load();
      const selected = this.selected();
      if (selected && ids.includes(selected.id)) void this.select(selected.id);
    });
  }

  ngOnInit(): void {
    void this.load();
  }

  protected count(filter: Filter): number {
    return this.orders().filter((o) => this.matches(o.status, filter)).length;
  }

  protected tone(status: OrderStatus): string {
    return status === 'Paid' ? 'ok' : status === 'Cancelled' ? 'bad' : status === 'Merged' ? 'faint' : status === 'BillPrinted' ? 'accent' : 'warn';
  }

  protected setDate(date: string): void {
    this.date.set(date || today());
    this.selected.set(null);
    void this.load();
  }

  protected async select(id: string): Promise<void> {
    try {
      this.selected.set(await firstValueFrom(this.api.order(id)));
    } catch (error) {
      this.notify.error(error, 'The check could not be loaded.');
    }
  }

  protected async previewCheck(order: Order, paid: boolean): Promise<void> {
    this.settings ??= await firstValueFrom(this.api.settings()).catch(() => null);
    this.preview(`${paid ? 'Receipt' : 'Check'} #${order.number}`, checkHtml(order, paid, this.company, this.settings, (utc) => this.company.formatLocal(utc)));
  }

  protected async previewTicket(ticket: TicketSummary): Promise<void> {
    try {
      const full = await firstValueFrom(this.api.ticket(ticket.id));
      this.preview(`KOT ${ticket.number}`, ticketHtml(full, null, (utc) => this.company.formatLocal(utc)));
    } catch (error) {
      this.notify.error(error, 'The ticket could not be loaded.');
    }
  }

  protected async reprint(order: Order): Promise<void> {
    try {
      await firstValueFrom(this.api.print(order.status === 'Paid' ? 'Receipt' : 'Bill', order.id));
      this.notify.info('Sent to the printer. · أُرسل للطابعة');
    } catch (error) {
      this.notify.error(error, errorMessage(error, 'It could not be printed.'));
    }
  }

  protected openInTerminal(order: Order): void {
    void this.router.navigate(['/pos/terminal'], { queryParams: { order: order.id } });
  }

  private preview(title: string, html: string): void {
    this.dialog.open<PrintPreviewDialog, PrintPreviewData>(PrintPreviewDialog, { data: { title, html }, maxWidth: '96vw' });
  }

  private matches(status: OrderStatus, filter: Filter): boolean {
    switch (filter) {
      case 'open':
        return status === 'Open' || status === 'BillPrinted';
      case 'paid':
        return status === 'Paid';
      case 'cancelled':
        return status === 'Cancelled' || status === 'Merged';
      default:
        return true;
    }
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.orders.set(await firstValueFrom(this.api.dayOrders(this.date())));
    } catch (error) {
      this.notify.error(error, 'The checks could not be loaded.');
    } finally {
      this.loading.set(false);
    }
  }
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

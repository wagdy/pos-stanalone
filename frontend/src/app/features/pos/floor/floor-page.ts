import { Component, ElementRef, OnDestroy, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../../core/http/error-message';
import { AuthService } from '../../../core/auth/auth.service';
import { Table, TableCheck, TableState, newId } from '../../../core/pos/pos.api';
import { MoneyPipe } from '../../../core/ui/money.pipe';
import { NotifyService } from '../../../core/ui/notify.service';
import { OrderCommands, PosStore, pendingOrder } from '../pos-store';
import { GuestsData, GuestsDialog } from '../terminal/dialogs';

// The plan's measures (as its styles give them): a cell, an aisle, the gap between them; and how
// small it may be drawn to fit.
const Cell = 148;
const Aisle = 16;
const Gap = 12;
const MinScale = 0.72;

export const tableStateLabels: Record<TableState, { en: string; ar: string }> = {
  Available: { en: 'Available', ar: 'متاحة' },
  Occupied: { en: 'Occupied', ar: 'مشغولة' },
  BillRequested: { en: 'Bill printed', ar: 'طُلب الحساب' },
};

// The floor plan (خريطة الصالة): each zone's tables where they stand on a dotted canvas, square and
// round ones as wide as they are tall, a long one two places wide, each coloured by its state
// (available, occupied, the bill printed) and showing its number, its state, and for an occupied
// one what its checks come to, the guests, how long it has sat and who opened it. A free table opens
// with its guests; an occupied one opens its check on the terminal.
@Component({
  selector: 'app-floor-page',
  imports: [MatButtonModule, MatIconModule, MatProgressBarModule, MoneyPipe],
  template: `
    <div class="floor-head">
      <div class="zones" role="tablist" aria-label="Zones">
        @for (z of zones(); track z.id) {
          <button type="button" role="tab" class="zone" [class.on]="zone() === z.id" [attr.aria-selected]="zone() === z.id" (click)="picked.set(z.id)">
            {{ z.name }} <span class="ar">{{ z.nameAr }}</span>
            <span class="busy">{{ busyIn(z.id) }}/{{ tablesIn(z.id).length }}</span>
          </button>
        }
      </div>
      <span class="spacer"></span>
      <ul class="legend" aria-label="Legend">
        @for (s of states; track s) {
          <li [class]="s"><span class="swatch"></span>{{ stateLabels[s].en }} <span class="ar">{{ stateLabels[s].ar }}</span> <strong>{{ counts()[s] }}</strong></li>
        }
      </ul>
    </div>

    @if (!store.floor()) {
      <mat-progress-bar mode="indeterminate" />
    }

    <div class="canvas" #canvas>
      @if (store.floor() && !tables().length) {
        <p class="muted none"><mat-icon>table_restaurant</mat-icon> No tables in this zone: Setup → Tables adds them. · لا توجد ترابيزات.</p>
      }
      <div class="plan" [style.grid-template-columns]="layout().columns" [style.grid-template-rows]="layout().rows" [style.zoom]="scale()">
        @for (t of tables(); track t.id) {
          <button type="button" class="table" [class]="t.state + ' ' + t.shape" [style.grid-column]="(t.x + 1) + ' / span ' + (t.shape === 'Long' ? 2 : 1)"
            [style.grid-row]="t.y + 1" (click)="open(t)" [disabled]="busy()"
            [attr.aria-label]="'Table ' + t.label + ', ' + stateLabels[t.state].en + (t.checks.length ? ', ' + t.checks.length + ' checks' : '')">
            <span class="top">
              <span class="label">{{ t.label }}</span>
              <span class="pill">{{ stateLabels[t.state].en }}</span>
            </span>
            @if (t.checks.length) {
              <span class="total">{{ sum(t.checks) | money }}</span>
              <span class="meta">
                <span class="guests"><mat-icon>groups</mat-icon>{{ guests(t.checks) }}</span>
                <span class="time" [class]="ageTone(t.checks[0].openedAtUtc)"><mat-icon>schedule</mat-icon>{{ age(t.checks[0].openedAtUtc) }}</span>
              </span>
              <span class="who"><mat-icon>person</mat-icon>{{ t.checks[0].openedBy }}</span>
              @if (t.checks.length > 1) {
                <span class="checks">
                  @for (c of t.checks; track c.orderId) {
                    <span class="check-chip" role="button" tabindex="0" (click)="$event.stopPropagation(); go(c)" (keydown.enter)="$event.stopPropagation(); go(c)">{{ c.checkLabel ?? '#' + c.number }}</span>
                  }
                </span>
              }
              @if (hasDrafts(t.checks)) {
                <span class="drafts" title="Items not sent yet · لم يُرسل"><mat-icon>pending</mat-icon></span>
              }
            } @else {
              <span class="seats"><mat-icon>chair</mat-icon>{{ t.seats }} seats</span>
              <span class="free">Tap to open · افتح</span>
            }
          </button>
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;

      --cell: 148px;
      --gap-cell: 16px;
      --plan-gap: 12px;
      --dot: color-mix(in srgb, var(--mat-sys-on-surface) 14%, transparent);
    }
    .floor-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 16px;
      margin-bottom: 12px;
    }
    .spacer {
      flex: 1;
    }
    .zones {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 4px;
      border-radius: 14px;
      background: var(--mat-sys-surface-container-high);
    }
    .zone {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 38px;
      padding: 0 14px;
      border: 0;
      border-radius: 10px;
      background: transparent;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-large);
      font-weight: 650;
      cursor: pointer;

      &.on {
        background: var(--mat-sys-surface-container-lowest);
        color: var(--mat-sys-on-surface);
        box-shadow: 0 1px 2px rgb(15 23 42 / 10%), 0 2px 6px -2px rgb(15 23 42 / 12%);
      }
      .busy {
        padding: 0 7px;
        border-radius: 999px;
        background: color-mix(in srgb, currentColor 12%, transparent);
        font-size: 12px;
        line-height: 20px;
      }
    }
    .ar {
      direction: rtl;
      unicode-bidi: isolate;
      opacity: 0.75;
    }
    .muted {
      color: var(--mat-sys-on-surface-variant);
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 0;
      padding: 0;
      list-style: none;
      font: var(--mat-sys-body-small);

      li {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 30px;
        padding: 0 10px;
        border: 1px solid var(--app-line);
        border-radius: 999px;
        background: var(--mat-sys-surface-container-lowest);
      }
      strong {
        font-size: 13px;
      }
    }
    .swatch {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--state);
    }

    // The states: their colour, and a soft tint of it for an occupied table's card.
    .Available {
      --state: #16a34a;
      --state-bg: var(--mat-sys-surface-container-lowest);
      --pill-bg: color-mix(in srgb, #16a34a 12%, transparent);
      --pill-fg: #15803d;
    }
    .Occupied {
      --state: #f59e0b;
      --state-bg: color-mix(in srgb, #f59e0b 9%, var(--mat-sys-surface-container-lowest));
      --pill-bg: color-mix(in srgb, #f59e0b 18%, transparent);
      --pill-fg: #b45309;
    }
    .BillRequested {
      --state: #db2777;
      --state-bg: color-mix(in srgb, #db2777 8%, var(--mat-sys-surface-container-lowest));
      --pill-bg: color-mix(in srgb, #db2777 15%, transparent);
      --pill-fg: #be185d;
    }

    // The room: a dotted canvas the plan stands on, scrolling inside itself when the room is wider.
    .canvas {
      min-height: calc(100dvh - var(--app-sticky-top, 64px) - 120px);
      padding: 20px;
      box-sizing: border-box;
      overflow: auto;
      border: 1px solid var(--app-line);
      border-radius: 18px;
      background-color: var(--mat-sys-surface-container-low);
      background-image: radial-gradient(circle, var(--dot) 1.2px, transparent 1.6px);
      background-size: 22px 22px;
    }
    .none {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 12px;
    }
    // Each place on the plan is a cell as wide as it is tall; a row or column with no table is a
    // thin aisle, so the room's gaps read as gaps.
    // A room wider than the canvas is drawn smaller to fit it (to 72%), each table as it is; wider
    // still, the canvas scrolls sideways inside itself.
    .plan {
      display: grid;
      gap: var(--plan-gap);
      width: max-content;
    }
    .table {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 4px;
      min-width: 0;
      width: var(--cell);
      height: var(--cell);
      padding: 10px 12px 10px;
      box-sizing: border-box;
      overflow: hidden;
      border: 1px solid color-mix(in srgb, var(--state) 40%, var(--app-line-strong));
      border-radius: 18px;
      background: var(--state-bg);
      color: var(--mat-sys-on-surface);
      font: inherit;
      text-align: start;
      cursor: pointer;
      box-shadow: 0 1px 2px rgb(15 23 42 / 6%), 0 10px 22px -16px rgb(15 23 42 / 45%);
      transition:
        transform 90ms ease,
        box-shadow 140ms ease;

      // Its state as a bar along its top.
      &::before {
        content: '';
        position: absolute;
        inset: 0 0 auto;
        height: 4px;
        background: var(--state);
      }
      &:hover:not(:disabled) {
        box-shadow: 0 1px 2px rgb(15 23 42 / 8%), 0 14px 28px -16px rgb(15 23 42 / 50%);
      }
      &:active:not(:disabled) {
        transform: scale(0.97);
      }
      &:focus-visible {
        outline: 3px solid var(--app-indigo-500, #6366f1);
        outline-offset: 2px;
      }
      &.Long {
        width: auto;
      }
      mat-icon {
        flex: none;
        width: 14px;
        height: 14px;
        font-size: 14px;
      }
      .top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        margin-top: 2px;
      }
      .label {
        min-width: 30px;
        padding: 3px 8px;
        box-sizing: border-box;
        border-radius: 9px;
        background: var(--state);
        color: #fff;
        font-size: 17px;
        font-weight: 800;
        line-height: 1.2;
        text-align: center;
      }
      &.Available .label {
        background: var(--mat-sys-surface-container-high);
        color: var(--mat-sys-on-surface);
      }
      .pill {
        overflow: hidden;
        padding: 2px 8px;
        border-radius: 999px;
        background: var(--pill-bg);
        color: var(--pill-fg);
        font-size: 11px;
        font-weight: 700;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .total {
        margin-top: 2px;
        font-size: 16px;
        font-weight: 800;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .meta {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .guests,
      .time,
      .who,
      .seats {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        min-width: 0;
        font-size: 12px;
        color: var(--mat-sys-on-surface-variant);
      }
      .time {
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--mat-sys-surface-container-high);
        font-weight: 650;
        font-variant-numeric: tabular-nums;

        &.warm {
          background: #fef3c7;
          color: #92400e;
        }
        &.late {
          background: #fee2e2;
          color: #b91c1c;
        }
      }
      .who {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .seats {
        margin-top: auto;
      }
      .free {
        font-size: 11.5px;
        color: var(--mat-sys-on-surface-variant);
        opacity: 0.8;
      }
      .drafts {
        position: absolute;
        bottom: 8px;
        inset-inline-end: 8px;
        color: #b45309;

        mat-icon {
          width: 18px;
          height: 18px;
          font-size: 18px;
        }
      }
      .checks {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: auto;
      }
      .check-chip {
        padding: 0 8px;
        border-radius: 999px;
        background: var(--mat-sys-surface-container-lowest);
        border: 1px solid var(--state);
        font-size: 12px;
        font-weight: 700;
        line-height: 20px;
      }

      // A round table: a circle, its words kept inside it, the waiter's name left to the check.
      &.Round {
        align-items: center;
        justify-content: center;
        gap: 3px;
        padding: 14px;
        border-radius: 50%;
        border-width: 3px;
        border-color: var(--state);
        text-align: center;

        &::before {
          display: none;
        }

        .top {
          flex-direction: column;
          gap: 3px;
          margin: 0;
        }
        .who,
        .checks,
        .free {
          display: none;
        }
        .seats {
          margin-top: 0;
        }
        .drafts {
          bottom: auto;
          top: 14px;
          inset-inline-end: 22px;
        }
      }
    }
    @media (max-width: 899.98px) {
      .canvas {
        padding: 12px;
      }
      .plan {
        width: auto;
        zoom: 1 !important;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)) !important;
        grid-template-rows: none !important;
        grid-auto-rows: 140px;
      }
      .table {
        grid-column: auto !important;
        grid-row: auto !important;
        width: auto;
        height: auto;
      }
    }
  `,
})
export class FloorPage implements OnDestroy {
  protected readonly store = inject(PosStore);
  private readonly commands = inject(OrderCommands);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);
  private readonly notify = inject(NotifyService);
  private readonly auth = inject(AuthService);

  protected readonly states: TableState[] = ['Available', 'Occupied', 'BillRequested'];
  protected readonly stateLabels = tableStateLabels;
  protected readonly busy = signal(false);
  protected readonly picked = signal<string | null>(null);
  // Minutes on the tables move on by themselves.
  private readonly now = signal(Date.now());
  private readonly timer = setInterval(() => this.now.set(Date.now()), 30000);

  protected readonly zones = computed(() => [...(this.store.floor()?.zones ?? [])].sort((a, b) => a.sortOrder - b.sortOrder));
  protected readonly zone = computed(() => this.picked() ?? this.zones()[0]?.id ?? null);
  protected readonly tables = computed(() => this.tablesIn(this.zone()));
  // The plan's columns and rows: a cell for each one a table stands in, a thin aisle for the rest.
  protected readonly layout = computed(() => {
    const tables = this.tables();
    const span = (t: Table) => (t.shape === 'Long' ? 2 : 1);
    const columns = Math.max(1, ...tables.map((t) => t.x + span(t)));
    const rows = Math.max(1, ...tables.map((t) => t.y + 1));
    const usedColumns = new Set(tables.flatMap((t) => Array.from({ length: span(t) }, (_, i) => t.x + i)));
    const usedRows = new Set(tables.map((t) => t.y));
    const track = (used: Set<number>, n: number) =>
      Array.from({ length: n }, (_, i) => (used.has(i) ? 'var(--cell)' : 'var(--gap-cell)')).join(' ');
    return {
      columns: track(usedColumns, columns),
      rows: track(usedRows, rows),
      // Its natural width: the cells, the aisles and the gaps between them.
      width: usedColumns.size * Cell + (columns - usedColumns.size) * Aisle + (columns - 1) * Gap,
    };
  });
  // The plan drawn smaller when the canvas is narrower than the room.
  private readonly canvas = viewChild<ElementRef<HTMLElement>>('canvas');
  private readonly room = signal(0);
  protected readonly scale = computed(() => {
    const room = this.room();
    const width = this.layout().width;
    return !room || width <= room ? 1 : Math.max(MinScale, Math.floor((room / width) * 1000) / 1000);
  });
  private observer?: ResizeObserver;
  protected readonly counts = computed(() => {
    const all = (this.store.floor()?.tables ?? []).filter((t) => t.isActive);
    return { Available: 0, Occupied: 0, BillRequested: 0, ...Object.fromEntries(this.states.map((s) => [s, all.filter((t) => t.state === s).length])) } as Record<TableState, number>;
  });

  constructor() {
    this.store.start();
    afterNextRender(() => {
      const canvas = this.canvas()?.nativeElement;
      if (!canvas || typeof ResizeObserver === 'undefined') return;
      const measure = () => {
        const style = getComputedStyle(canvas);
        this.room.set(canvas.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
      };
      this.observer = new ResizeObserver(measure);
      this.observer.observe(canvas);
      measure();
    });
  }

  ngOnDestroy(): void {
    clearInterval(this.timer);
    this.observer?.disconnect();
  }

  protected tablesIn(zoneId: string | null): Table[] {
    return (this.store.floor()?.tables ?? []).filter((t) => t.zoneId === zoneId && t.isActive);
  }

  protected busyIn(zoneId: string): number {
    return this.tablesIn(zoneId).filter((t) => t.state !== 'Available').length;
  }

  protected sum(checks: TableCheck[]): number {
    return checks.reduce((n, c) => n + c.total, 0);
  }

  protected guests(checks: TableCheck[]): number {
    return checks.reduce((n, c) => n + c.guests, 0);
  }

  protected hasDrafts(checks: TableCheck[]): boolean {
    return checks.some((c) => c.hasDrafts);
  }

  protected age(utc: string): string {
    const minutes = this.minutes(utc);
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  // How long a table has sat: amber past 45 minutes, red past 90.
  protected ageTone(utc: string): string {
    const minutes = this.minutes(utc);
    return minutes >= 90 ? 'time late' : minutes >= 45 ? 'time warm' : 'time';
  }

  private minutes(utc: string): number {
    return Math.max(0, Math.round((this.now() - new Date(utc).getTime()) / 60000));
  }

  protected async open(table: Table): Promise<void> {
    if (table.checks.length) {
      this.go(table.checks[0]);
      return;
    }
    const guests = await firstValueFrom(
      this.dialog.open<GuestsDialog, GuestsData, number>(GuestsDialog, { data: { tableLabel: table.label, seats: table.seats }, width: '420px', maxWidth: '96vw' }).afterClosed(),
    );
    if (!guests) return;
    this.busy.set(true);
    try {
      const id = newId();
      const order = await this.commands.open('DineIn', table.id, guests, {}, id);
      if (!order) {
        // Waiting for the server: the table is taken here at once, and the terminal goes on with it.
        this.store.markOpenedOffline(pendingOrder(id, 'DineIn', table.id, table.label, guests, this.auth.me()?.fullName ?? '', this.store.menu()));
        this.notify.info('The server cannot be reached: the table is opened here and sent once it answers. · سيتم الإرسال عند الاتصال.');
      }
      await this.router.navigate(['/pos/terminal'], { queryParams: { order: id } });
    } catch (error) {
      this.notify.error(error, errorMessage(error, 'The table could not be opened.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected go(check: TableCheck): void {
    void this.router.navigate(['/pos/terminal'], { queryParams: { order: check.orderId } });
  }
}

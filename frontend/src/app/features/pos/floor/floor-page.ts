import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
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

export const tableStateLabels: Record<TableState, { en: string; ar: string }> = {
  Available: { en: 'Available', ar: 'متاحة' },
  Occupied: { en: 'Occupied', ar: 'مشغولة' },
  BillRequested: { en: 'Bill printed', ar: 'طُلب الحساب' },
};

// The floor plan (خريطة الصالة): each zone's tables where they stand, coloured by their state
// (available, occupied, the bill printed), each occupied one with its total, guests and how long it
// has sat. A free table opens with its guests; an occupied one opens its check on the terminal.
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
          <li><span class="swatch" [class]="s"></span>{{ stateLabels[s].en }} <span class="ar">{{ stateLabels[s].ar }}</span> <strong>{{ counts()[s] }}</strong></li>
        }
      </ul>
    </div>

    @if (!store.floor()) {
      <mat-progress-bar mode="indeterminate" />
    } @else if (!tables().length) {
      <p class="muted">No tables in this zone: Setup → Tables adds them.</p>
    }

    <div class="plan">
      @for (t of tables(); track t.id) {
        <button type="button" class="table" [class]="t.state + ' ' + t.shape" [style.grid-column]="(t.x + 1) + ' / span ' + (t.shape === 'Long' ? 2 : 1)"
          [style.grid-row]="t.y + 1" (click)="open(t)" [disabled]="busy()"
          [attr.aria-label]="'Table ' + t.label + ', ' + stateLabels[t.state].en + (t.checks.length ? ', ' + t.checks.length + ' checks' : '')">
          <span class="label">{{ t.label }}</span>
          <span class="seats"><mat-icon inline>chair</mat-icon> {{ t.seats }}</span>
          @if (t.checks.length) {
            <span class="total">{{ sum(t.checks) | money }}</span>
            <span class="meta"><mat-icon inline>groups</mat-icon> {{ guests(t.checks) }} · {{ age(t.checks[0].openedAtUtc) }}</span>
            <span class="who">{{ t.checks[0].openedBy }}</span>
            @if (t.checks.length > 1) {
              <span class="checks">
                @for (c of t.checks; track c.orderId) {
                  <span class="check-chip" role="button" tabindex="0" (click)="$event.stopPropagation(); go(c)" (keydown.enter)="$event.stopPropagation(); go(c)">
                    {{ c.checkLabel ?? '#' + c.number }}
                  </span>
                }
              </span>
            }
            @if (hasDrafts(t.checks)) {
              <span class="drafts" title="Items not sent yet · لم يُرسل"><mat-icon inline>pending</mat-icon></span>
            }
          } @else {
            <span class="free">{{ stateLabels[t.state].en }}</span>
          }
        </button>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .floor-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 16px;
      margin-bottom: 12px;
    }
    .zones {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .zone {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 40px;
      padding: 0 14px;
      border: 1px solid var(--app-line-strong);
      border-radius: 999px;
      background: var(--mat-sys-surface-container-lowest);
      color: inherit;
      font: var(--mat-sys-label-large);
      cursor: pointer;

      &.on {
        background: var(--mat-sys-primary);
        border-color: var(--mat-sys-primary);
        color: var(--mat-sys-on-primary);
      }
      .busy {
        padding: 0 6px;
        border-radius: 999px;
        background: color-mix(in srgb, currentColor 14%, transparent);
        font-size: 12px;
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
      gap: 12px;
      margin: 0;
      padding: 0;
      list-style: none;
      font: var(--mat-sys-body-small);

      li {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
    }
    .swatch {
      width: 12px;
      height: 12px;
      border-radius: 4px;
      background: var(--state-bg);
      border: 2px solid var(--state-line);
    }
    .Available {
      --state-bg: var(--mat-sys-surface-container-lowest);
      --state-line: var(--app-line-strong);
      --state-fg: var(--mat-sys-on-surface);
    }
    .Occupied {
      --state-bg: color-mix(in srgb, #f59e0b 16%, var(--mat-sys-surface-container-lowest));
      --state-line: #f59e0b;
      --state-fg: var(--mat-sys-on-surface);
    }
    .BillRequested {
      --state-bg: color-mix(in srgb, #db2777 14%, var(--mat-sys-surface-container-lowest));
      --state-line: #db2777;
      --state-fg: var(--mat-sys-on-surface);
    }
    // Twelve columns; a row without tables stays thin, so the room's gaps read as gaps.
    .plan {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      grid-auto-rows: minmax(28px, auto);
      gap: 10px;
    }
    .table {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      min-width: 0;
      min-height: 104px;
      padding: 10px 12px;
      border: 2px solid var(--state-line);
      border-radius: 16px;
      background: var(--state-bg);
      color: var(--state-fg);
      font: inherit;
      text-align: start;
      cursor: pointer;
      box-shadow: var(--app-card-shadow);
      transition: transform 80ms ease;

      &:active {
        transform: scale(0.97);
      }
      // A round table: its words kept inside the circle, the waiter's name left to the check.
      &.Round {
        justify-self: center;
        width: min(100%, 118px);
        aspect-ratio: 1;
        min-height: 0;
        gap: 0;
        padding: 6px;
        border-radius: 50%;
        align-items: center;
        justify-content: center;
        text-align: center;
        overflow: hidden;

        .label {
          font-size: 18px;
        }
        .total {
          font-size: 12.5px;
          white-space: nowrap;
        }
        .seats,
        .meta {
          font-size: 11px;
        }
        .who {
          display: none;
        }
        .drafts {
          top: 10px;
          right: 18px;
        }
        &.Occupied .seats,
        &.BillRequested .seats {
          display: none;
        }
      }
      .label {
        font-size: 22px;
        font-weight: 800;
        line-height: 1;
      }
      .seats,
      .meta,
      .who,
      .free {
        font-size: 12px;
        color: var(--mat-sys-on-surface-variant);
      }
      .total {
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .who {
        overflow: hidden;
        max-width: 100%;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .drafts {
        position: absolute;
        top: 6px;
        right: 8px;
        color: #b45309;
      }
      .checks {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 2px;
      }
      .check-chip {
        padding: 1px 8px;
        border-radius: 999px;
        background: var(--mat-sys-surface-container-lowest);
        border: 1px solid var(--state-line);
        font-size: 12px;
        font-weight: 700;
      }
    }
    @media (max-width: 899.98px) {
      .plan {
        grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
      }
      .table {
        grid-column: auto !important;
        grid-row: auto !important;
        min-height: 112px;
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
  protected readonly counts = computed(() => {
    const all = (this.store.floor()?.tables ?? []).filter((t) => t.isActive);
    return { Available: 0, Occupied: 0, BillRequested: 0, ...Object.fromEntries(this.states.map((s) => [s, all.filter((t) => t.state === s).length])) } as Record<TableState, number>;
  });

  constructor() {
    this.store.start();
  }

  ngOnDestroy(): void {
    clearInterval(this.timer);
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
    const minutes = Math.max(0, Math.round((this.now() - new Date(utc).getTime()) / 60000));
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
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

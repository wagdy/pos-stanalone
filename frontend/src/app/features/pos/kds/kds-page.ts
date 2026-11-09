import { Component, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { Permissions } from '../../../core/auth/permissions';
import { errorMessage } from '../../../core/http/error-message';
import { LiveService } from '../../../core/pos/live.service';
import { KitchenBoard, PosApi, Station, Ticket, TicketLine, orderTypeLabels } from '../../../core/pos/pos.api';
import { Company } from '../../../core/settings/company';
import { NotifyService } from '../../../core/ui/notify.service';
import { ThemeService } from '../../../core/ui/theme';
import { StaffGate } from '../staff-gate';

const StationKey = 'pos.kdsStation';

const kindBanner: Record<string, { en: string; ar: string } | null> = {
  New: null,
  AddOn: { en: 'ADD-ON', ar: 'بون إلحاقي' },
  Void: { en: 'VOID · STOP', ar: 'بون إلغاء' },
  Transfer: { en: 'TABLE MOVED', ar: 'نقل ترابيزة' },
};

// The kitchen screen (KDS, /pos/kds): every ticket not yet made, oldest first, at all stations or
// this screen's one. Each shows its table, waiter and how long it has waited (green, then amber past
// 10 minutes, red past 20), its items by station with their modifiers and notes loud, and an add-on,
// void or move as a banner. Bump marks a station's part made; done ones can be recalled. It hears a
// new ticket the moment it is sent, with a chime.
@Component({
  selector: 'app-kds-page',
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, StaffGate],
  template: `
    <app-staff-gate titleEn="Kitchen screen" titleAr="شاشة المطبخ" icon="soup_kitchen" [permission]="Permissions.KitchenWork">
      <div class="kds">
        <header class="bar">
          <strong class="title"><mat-icon>soup_kitchen</mat-icon> Kitchen <span class="ar">المطبخ</span></strong>
          <div class="stations" role="tablist" aria-label="Station">
            <button type="button" role="tab" class="st" [class.on]="!station()" [attr.aria-selected]="!station()" (click)="pick(null)">All · الكل</button>
            @for (s of stations(); track s.id) {
              <button type="button" role="tab" class="st" [class.on]="station() === s.id" [attr.aria-selected]="station() === s.id" (click)="pick(s.id)">
                {{ s.name }} <span class="ar">{{ s.nameAr }}</span>
              </button>
            }
          </div>
          <span class="spacer"></span>
          <span class="count"><strong>{{ board().active.length }}</strong> open · مفتوح</span>
          <span class="live" [class.on]="live.connected()" [matTooltip]="live.connected() ? 'Live' : 'Reconnecting: asking every few seconds'">
            <mat-icon>{{ live.connected() ? 'wifi' : 'wifi_off' }}</mat-icon>
          </span>
          <span class="clock">{{ clock() }}</span>
          <button mat-icon-button (click)="sound.set(!sound())" [attr.aria-label]="sound() ? 'Mute the chime' : 'Chime on new tickets'">
            <mat-icon>{{ sound() ? 'notifications_active' : 'notifications_off' }}</mat-icon>
          </button>
          <button mat-icon-button (click)="theme.toggle()" aria-label="Light or dark"><mat-icon>contrast</mat-icon></button>
          <button mat-icon-button (click)="lock()" [matTooltip]="'Lock · ' + (auth.me()?.fullName ?? '')" aria-label="Lock the screen"><mat-icon>lock</mat-icon></button>
        </header>

        @if (!board().active.length) {
          <p class="empty"><mat-icon>check_circle</mat-icon> All caught up. · لا توجد طلبات</p>
        }

        <section class="tickets" aria-label="Tickets waiting">
          @for (t of board().active; track t.id) {
            <article class="ticket" [class]="'k-' + t.kind + ' ' + ageClass(t)" [class.fresh]="fresh().has(t.id)">
              <header>
                <div class="num">#{{ t.number }}</div>
                <div class="where">
                  @if (t.tableLabel) {
                    <strong>T{{ t.tableLabel }}{{ t.checkLabel ? '·' + t.checkLabel : '' }}</strong>
                  } @else {
                    <strong>{{ typeLabels[t.orderType].en }} · {{ typeLabels[t.orderType].ar }}</strong>
                  }
                  <small>Check {{ t.orderNumber }} · {{ t.createdBy }}{{ t.guests ? ' · ' + t.guests + ' guests' : '' }}</small>
                </div>
                <div class="age">{{ age(t) }}</div>
              </header>
              @if (banner(t); as b) {
                <div class="banner">{{ b.en }} <span class="ar">{{ b.ar }}</span></div>
              }
              @if (t.note) {
                <p class="tnote">{{ t.note }}</p>
              }
              @for (g of groups(t); track g.station) {
                @if (!station() && groups(t).length > 1) {
                  <p class="station">{{ g.station }}</p>
                }
                <ul>
                  @for (l of g.lines; track l.id) {
                    <li [class.done]="l.doneAtUtc">
                      <span class="q">{{ l.quantity }}</span>
                      <span class="n">
                        <strong>{{ l.name }}{{ l.sizeName ? ' (' + l.sizeName + ')' : '' }}</strong>
                        @if (l.nameAr) {
                          <span class="ar">{{ l.nameAr }}</span>
                        }
                        @if (l.modifiers) {
                          <span class="mod">+ {{ l.modifiers }}</span>
                        }
                        @if (l.notes) {
                          <span class="note">⚠ {{ l.notes }}</span>
                        }
                      </span>
                    </li>
                  }
                </ul>
              }
              <button mat-flat-button class="bump" (click)="bump(t)" [disabled]="busy() === t.id">
                <mat-icon>{{ t.kind === 'Void' || t.kind === 'Transfer' ? 'visibility' : 'done_all' }}</mat-icon>
                {{ t.kind === 'Void' || t.kind === 'Transfer' ? 'Seen · تم' : 'Bump · جاهز' }}
              </button>
            </article>
          }
        </section>

        @if (board().recentlyDone.length) {
          <section class="done-strip" aria-label="Recently done">
            <span class="label">Done · جاهز</span>
            @for (t of board().recentlyDone; track t.id) {
              <button type="button" class="recall" (click)="recall(t)" [matTooltip]="'Recall #' + t.number">
                #{{ t.number }} {{ t.tableLabel ? 'T' + t.tableLabel : typeLabels[t.orderType].en }} <mat-icon inline>undo</mat-icon>
              </button>
            }
          </section>
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
    .kds {
      display: flex;
      flex-direction: column;
      min-height: 100dvh;
    }
    .bar {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 12px;
      padding: 8px 14px;
      background: var(--mat-sys-surface-container-lowest);
      border-bottom: 1px solid var(--app-line);
    }
    .title {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font: var(--mat-sys-title-large);
    }
    .ar {
      direction: rtl;
      unicode-bidi: isolate;
      opacity: 0.75;
      margin-inline-start: 4px;
    }
    .stations {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .st {
      height: 38px;
      padding: 0 14px;
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
    .count strong {
      font-size: 20px;
    }
    .live {
      color: var(--mat-sys-error);
      &.on {
        color: var(--app-ok);
      }
    }
    .clock {
      font: 700 20px/1 ui-monospace, monospace;
      font-variant-numeric: tabular-nums;
    }
    .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin: 15vh 0 0;
      font: var(--mat-sys-headline-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .tickets {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      align-items: start;
      gap: 12px;
      padding: 12px;
    }
    .ticket {
      display: flex;
      flex-direction: column;
      border-radius: 14px;
      background: var(--mat-sys-surface-container-lowest);
      border: 3px solid var(--age, #16a34a);
      box-shadow: var(--app-card-shadow);
      overflow: hidden;

      &.warm {
        --age: #f59e0b;
      }
      &.late {
        --age: #dc2626;
      }
      &.fresh {
        animation: kds-flash 1.2s ease 2;
      }
      > header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        background: var(--age, #16a34a);
        color: #fff;
      }
      .num {
        font: 800 24px/1 system-ui;
      }
      .where {
        display: grid;
        flex: 1;
        min-width: 0;

        strong {
          font-size: 18px;
        }
        small {
          opacity: 0.9;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }
      }
      .age {
        font: 700 18px/1 ui-monospace, monospace;
      }
      .banner {
        padding: 6px 10px;
        font: 800 18px/1.2 system-ui;
        letter-spacing: 0.04em;
        text-align: center;
        background: #fde68a;
        color: #78350f;
      }
      &.k-Void .banner {
        background: #dc2626;
        color: #fff;
      }
      &.k-Transfer .banner {
        background: #2563eb;
        color: #fff;
      }
      &.k-Void ul {
        text-decoration: line-through;
        text-decoration-color: #dc2626;
      }
      .tnote {
        margin: 6px 10px 0;
        font-weight: 600;
      }
      .station {
        margin: 8px 10px 0;
        padding-bottom: 2px;
        border-bottom: 1px dashed var(--app-line-strong);
        font: var(--mat-sys-label-large);
        text-transform: uppercase;
        color: var(--mat-sys-on-surface-variant);
      }
      ul {
        margin: 0;
        padding: 4px 10px 8px;
        list-style: none;
      }
      li {
        display: flex;
        gap: 10px;
        padding: 6px 0;
        border-bottom: 1px solid var(--app-line);

        &.done {
          opacity: 0.45;
          text-decoration: line-through;
        }
      }
      .q {
        min-width: 28px;
        font: 800 22px/1.1 system-ui;
      }
      .n {
        display: grid;
        font-size: 17px;

        .ar {
          margin: 0;
          font-size: 15px;
        }
      }
      .mod {
        font-weight: 700;
        color: var(--mat-sys-primary);
      }
      .note {
        margin-top: 2px;
        padding: 2px 6px;
        border-radius: 6px;
        background: #fef3c7;
        color: #92400e;
        font-weight: 800;
      }
      .bump {
        margin: auto 10px 10px;
        height: 48px;
        font-size: 16px;
      }
    }
    .done-strip {
      position: sticky;
      bottom: 0;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin-top: auto;
      padding: 8px 14px;
      background: var(--mat-sys-surface-container-lowest);
      border-top: 1px solid var(--app-line);

      .label {
        font: var(--mat-sys-label-large);
        color: var(--mat-sys-on-surface-variant);
      }
    }
    .recall {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 6px 10px;
      border: 1px solid var(--app-line-strong);
      border-radius: 999px;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }
    @keyframes kds-flash {
      50% {
        box-shadow: 0 0 0 6px color-mix(in srgb, var(--mat-sys-primary) 50%, transparent);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .ticket.fresh {
        animation: none;
      }
    }
  `,
})
export class KdsPage implements OnDestroy {
  protected readonly auth = inject(AuthService);
  protected readonly live = inject(LiveService);
  protected readonly theme = inject(ThemeService);
  private readonly api = inject(PosApi);
  private readonly notify = inject(NotifyService);
  private readonly company = inject(Company);
  protected readonly Permissions = Permissions;
  protected readonly typeLabels = orderTypeLabels;

  protected readonly board = signal<KitchenBoard>({ active: [], recentlyDone: [] });
  protected readonly stations = signal<Station[]>([]);
  protected readonly station = signal<string | null>(readStation());
  protected readonly busy = signal<string | null>(null);
  protected readonly sound = signal(true);
  protected readonly fresh = signal(new Set<string>());
  private readonly now = signal(Date.now());
  protected readonly clock = computed(() => this.company.formatLocal(new Date(this.now()).toISOString(), false));
  private seen: Set<string> | null = null;
  private readonly timer = setInterval(() => {
    this.now.set(Date.now());
    // The live line down: asked every few seconds instead.
    if (this.auth.can(Permissions.KitchenWork) && !this.live.connected() && Math.floor(Date.now() / 1000) % 10 === 0) void this.load();
  }, 1000);

  constructor() {
    this.live.kitchenChanged.pipe(takeUntilDestroyed()).subscribe(() => void this.load());
    this.live.reconnected.pipe(takeUntilDestroyed()).subscribe(() => void this.load());
    effect(() => {
      const ready = this.auth.isSignedIn() && this.auth.can(Permissions.KitchenWork);
      this.station();
      if (ready) untracked(() => void this.load());
    });
    effect(() => {
      if (this.auth.isSignedIn() && this.auth.can(Permissions.KitchenWork)) untracked(() => void this.loadStations());
    });
  }

  ngOnDestroy(): void {
    clearInterval(this.timer);
  }

  protected pick(id: string | null): void {
    this.station.set(id);
    this.seen = null;
    try {
      localStorage.setItem(StationKey, id ?? '');
    } catch {
      // This tab only.
    }
  }

  protected banner(t: Ticket) {
    return kindBanner[t.kind];
  }

  // The ticket's lines for this screen, by station.
  protected groups(t: Ticket): { station: string; lines: TicketLine[] }[] {
    const lines = t.lines.filter((l) => !this.station() || l.stationId === this.station());
    const by = new Map<string, TicketLine[]>();
    for (const l of lines) {
      const key = l.stationName ?? 'Kitchen';
      by.set(key, [...(by.get(key) ?? []), l]);
    }
    return [...by].map(([station, ls]) => ({ station, lines: ls }));
  }

  protected age(t: Ticket): string {
    const seconds = Math.max(0, Math.floor((this.now() - new Date(t.createdAtUtc).getTime()) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  protected ageClass(t: Ticket): string {
    const minutes = (this.now() - new Date(t.createdAtUtc).getTime()) / 60000;
    return minutes >= 20 ? 'late' : minutes >= 10 ? 'warm' : '';
  }

  protected async bump(t: Ticket): Promise<void> {
    this.busy.set(t.id);
    try {
      const station = this.station();
      await firstValueFrom(this.api.bump(t.id, station, station === null));
      await this.load();
    } catch (error) {
      this.notify.error(error, errorMessage(error, 'The ticket could not be bumped.'));
    } finally {
      this.busy.set(null);
    }
  }

  protected async recall(t: Ticket): Promise<void> {
    try {
      await firstValueFrom(this.api.recall(t.id, this.station()));
      await this.load();
    } catch (error) {
      this.notify.error(error, errorMessage(error, 'The ticket could not be recalled.'));
    }
  }

  protected lock(): void {
    void this.live.stop();
    this.board.set({ active: [], recentlyDone: [] });
    this.seen = null;
    this.auth.lock();
  }

  private async loadStations(): Promise<void> {
    try {
      const menu = await firstValueFrom(this.api.menu());
      this.stations.set([...menu.stations].sort((a, b) => a.sortOrder - b.sortOrder));
    } catch {
      // The tabs stay as they were.
    }
  }

  private async load(): Promise<void> {
    try {
      const board = await firstValueFrom(this.api.kitchen(this.station()));
      const ids = new Set(board.active.map((t) => t.id));
      // New since the last look (not the first): flashed, and a chime.
      if (this.seen) {
        const added = [...ids].filter((id) => !this.seen!.has(id));
        if (added.length) {
          this.fresh.set(new Set(added));
          setTimeout(() => this.fresh.set(new Set()), 2500);
          if (this.sound()) chime();
        }
      }
      this.seen = ids;
      this.board.set(board);
    } catch {
      // Kept as it was; the next change or look tries again.
    }
  }
}

function readStation(): string | null {
  try {
    return localStorage.getItem(StationKey) || null;
  } catch {
    return null;
  }
}

// Two short notes, loud enough over a kitchen.
function chime(): void {
  try {
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    [880, 1320].forEach((frequency, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.25, ctx.currentTime + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.18);
      osc.stop(ctx.currentTime + i * 0.18 + 0.18);
    });
    setTimeout(() => void ctx.close(), 800);
  } catch {
    // No sound here: the flash says it.
  }
}

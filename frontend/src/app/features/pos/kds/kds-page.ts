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
import { KitchenBoard, PosApi, Station, Ticket, TicketLine, orderTypeLabels, tableTag } from '../../../core/pos/pos.api';
import { Company } from '../../../core/settings/company';
import { NotifyService } from '../../../core/ui/notify.service';
import { StaffGate } from '../staff-gate';

const StationKey = 'pos.kdsStation';
// The board light (for a bright kitchen) instead of dark: this screen's choice.
const LightKey = 'pos.kdsLight';

const kindBanner: Record<string, { en: string; ar: string } | null> = {
  New: null,
  AddOn: { en: 'ADD-ON', ar: 'بون إلحاقي' },
  Void: { en: 'VOID · STOP', ar: 'بون إلغاء' },
  Transfer: { en: 'TABLE MOVED', ar: 'نقل ترابيزة' },
};

// The kitchen screen (KDS, /pos/kds): a dark slate board (or a light one, for a bright kitchen) of
// every ticket not yet made, oldest first, in columns, at all stations or this screen's one. Each
// shows its table, waiter and a timer that goes from green to amber past 10 minutes and red past 20,
// its items under each station's header with their modifiers and notes loud, and an add-on, void or
// move as a banner. Bump (the full width of the ticket) marks a station's part made; done ones can be
// recalled. It hears a new ticket the moment it is sent, with a chime.
@Component({
  selector: 'app-kds-page',
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, StaffGate],
  template: `
    <app-staff-gate titleEn="Kitchen screen" titleAr="شاشة المطبخ" icon="soup_kitchen" [permission]="Permissions.KitchenWork">
      <div class="kds" [class.light]="light()">
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
          <button mat-icon-button (click)="toggleBoard()" [attr.aria-label]="light() ? 'Dark board' : 'Light board'" [matTooltip]="light() ? 'Dark board · داكن' : 'Light board · فاتح'"><mat-icon>contrast</mat-icon></button>
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
                    <strong>{{ tableTag(t.tableLabel) }}{{ t.checkLabel ? '·' + t.checkLabel : '' }}</strong>
                  } @else {
                    <strong>{{ typeLabels[t.orderType].en }} · {{ typeLabels[t.orderType].ar }}</strong>
                  }
                  <small>Check {{ t.orderNumber }} · {{ t.createdBy }}{{ t.guests ? ' · ' + t.guests + ' guests' : '' }}</small>
                </div>
                <div class="age"><mat-icon>timer</mat-icon>{{ age(t) }}</div>
              </header>
              @if (banner(t); as b) {
                <div class="banner">{{ b.en }} <span class="ar">{{ b.ar }}</span></div>
              }
              @if (t.note) {
                <p class="tnote">{{ t.note }}</p>
              }
              @for (g of groups(t); track g.station) {
                @if (!station()) {
                  <p class="station-head"><mat-icon>{{ stationIcon(g.station) }}</mat-icon><span class="station">{{ g.station }}</span><span class="items">{{ count(g.lines) }}</span></p>
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
                #{{ t.number }} {{ t.tableLabel ? tableTag(t.tableLabel) : typeLabels[t.orderType].en }} <mat-icon inline>undo</mat-icon>
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

    // The board: dark slate by default, light for a bright kitchen. The tickets are paper-white on
    // either, for the words to read from across the pass.
    .kds {
      --board: #0f172a;
      --bar: #0b1220;
      --bar-line: #1e293b;
      --ink: #e2e8f0;
      --ink-soft: #94a3b8;
      --pill: #1e293b;
      --pill-line: #334155;
      --pill-on: #f8fafc;
      --pill-on-ink: #0f172a;
      --ticket: #f8fafc;
      --ticket-ink: #0f172a;
      --ticket-line: #e2e8f0;
      --head: #1e293b;
      --fresh: #22c55e;
      --warm: #f59e0b;
      --late: #ef4444;

      display: flex;
      flex-direction: column;
      min-height: 100dvh;
      background: var(--board);
      color: var(--ink);

      &.light {
        --board: #f1f5f9;
        --bar: #ffffff;
        --bar-line: #e2e8f0;
        --ink: #0f172a;
        --ink-soft: #475569;
        --pill: #ffffff;
        --pill-line: #cbd5e1;
        --pill-on: #0f172a;
        --pill-on-ink: #ffffff;
        --ticket: #ffffff;
        --head: #0f172a;
      }
    }
    .bar {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 12px;
      padding: 10px 16px;
      background: var(--bar);
      border-bottom: 1px solid var(--bar-line);
      color: var(--ink);

      button[mat-icon-button] {
        color: var(--ink);
      }
    }
    .title {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font: var(--mat-sys-title-large);
      font-weight: 700;
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
      height: 40px;
      padding: 0 16px;
      border: 1px solid var(--pill-line);
      border-radius: 999px;
      background: var(--pill);
      color: var(--ink);
      font: var(--mat-sys-label-large);
      font-weight: 650;
      cursor: pointer;

      &.on {
        border-color: var(--pill-on);
        background: var(--pill-on);
        color: var(--pill-on-ink);
      }
      &:focus-visible {
        outline: 2px solid #818cf8;
        outline-offset: 2px;
      }
    }
    .spacer {
      flex: 1;
    }
    .count {
      color: var(--ink-soft);

      strong {
        color: var(--ink);
        font-size: 22px;
      }
    }
    .live {
      display: inline-flex;
      color: var(--late);

      &.on {
        color: var(--fresh);
      }
    }
    .clock {
      font: 700 22px/1 ui-monospace, monospace;
      font-variant-numeric: tabular-nums;
    }
    .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      margin: 18vh 0 0;
      font: var(--mat-sys-headline-small);
      color: var(--ink-soft);

      mat-icon {
        width: 32px;
        height: 32px;
        font-size: 32px;
        color: var(--fresh);
      }
    }

    // The tickets in columns, oldest first.
    .tickets {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      align-items: start;
      gap: 14px;
      padding: 16px;
    }
    .ticket {
      --age: var(--fresh);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border-radius: 14px;
      background: var(--ticket);
      color: var(--ticket-ink);
      border-top: 6px solid var(--age);
      box-shadow:
        0 1px 2px rgb(0 0 0 / 30%),
        0 14px 28px -18px rgb(0 0 0 / 60%);

      &.warm {
        --age: var(--warm);
      }
      &.late {
        --age: var(--late);
      }
      &.fresh {
        animation: kds-flash 1.2s ease 2;
      }
      > header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        background: var(--head);
        color: #f8fafc;
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
          line-height: 1.2;
        }
        small {
          opacity: 0.8;
          line-height: 1.3;
          overflow-wrap: anywhere;
        }
      }
      // The timer: its colour says how long the ticket has waited.
      .age {
        display: inline-flex;
        flex: none;
        align-items: center;
        gap: 4px;
        padding: 5px 10px;
        border-radius: 999px;
        background: var(--age);
        color: #0f172a;
        font: 800 17px/1 ui-monospace, monospace;
        font-variant-numeric: tabular-nums;

        mat-icon {
          width: 17px;
          height: 17px;
          font-size: 17px;
        }
      }
      &.late .age {
        color: #fff;
        animation: kds-pulse 1.6s ease-in-out infinite;
      }
      .banner {
        padding: 8px 10px;
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
        margin: 8px 12px 0;
        padding: 6px 8px;
        border-radius: 8px;
        background: #fef3c7;
        color: #92400e;
        font-weight: 700;
      }
      // A station's header: crisp, its icon and how many items it makes.
      .station-head {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 10px 12px 0;
        padding: 5px 8px;
        border-radius: 8px;
        background: #e2e8f0;
        color: #0f172a;
        font: var(--mat-sys-label-large);
        font-weight: 800;
        letter-spacing: 0.06em;
        text-transform: uppercase;

        mat-icon {
          width: 18px;
          height: 18px;
          font-size: 18px;
        }
        .items {
          margin-inline-start: auto;
          padding: 0 7px;
          border-radius: 999px;
          background: #0f172a;
          color: #fff;
          font-size: 11.5px;
          line-height: 18px;
          letter-spacing: 0;
        }
      }
      ul {
        margin: 0;
        padding: 4px 12px 10px;
        list-style: none;
      }
      li {
        display: flex;
        gap: 12px;
        padding: 8px 0;
        border-bottom: 1px solid var(--ticket-line);

        &:last-child {
          border-bottom: 0;
        }
        &.done {
          opacity: 0.4;
          text-decoration: line-through;
        }
      }
      .q {
        display: inline-grid;
        flex: none;
        place-items: center;
        min-width: 34px;
        height: 34px;
        border-radius: 9px;
        background: #0f172a;
        color: #fff;
        font: 800 19px/1 system-ui;
      }
      .n {
        display: grid;
        gap: 2px;
        min-width: 0;
        font-size: 17px;

        strong {
          line-height: 1.25;
        }
        .ar {
          margin: 0;
          font-size: 15px;
          text-align: left;
        }
      }
      .mod {
        font-weight: 700;
        color: #4338ca;
      }
      .note {
        justify-self: start;
        margin-top: 2px;
        padding: 2px 8px;
        border-radius: 6px;
        background: #fef3c7;
        color: #92400e;
        font-weight: 800;
      }
      // Bump: the width of the ticket, tactile.
      .bump {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        margin: auto 0 0;
        width: 100%;
        height: 60px;
        border-radius: 0;
        --mat-button-filled-container-color: #16a34a;
        --mat-button-filled-label-text-color: #fff;
        --mat-button-filled-container-shape: 0;
        font-size: 18px;
        font-weight: 800;
        letter-spacing: 0.02em;
        box-shadow: inset 0 3px 0 rgb(255 255 255 / 18%);
        transition: transform 80ms ease, filter 120ms ease;

        mat-icon {
          width: 24px;
          height: 24px;
          font-size: 24px;
        }
        &:hover:not(:disabled) {
          filter: brightness(1.08);
        }
        &:active:not(:disabled) {
          transform: translateY(1px);
          box-shadow: inset 0 3px 8px rgb(0 0 0 / 30%);
        }
      }
      &.k-Void .bump,
      &.k-Transfer .bump {
        --mat-button-filled-container-color: #334155;
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
      padding: 10px 16px;
      background: var(--bar);
      border-top: 1px solid var(--bar-line);

      .label {
        font: var(--mat-sys-label-large);
        color: var(--ink-soft);
      }
    }
    .recall {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 36px;
      padding: 0 12px;
      border: 1px solid var(--pill-line);
      border-radius: 999px;
      background: var(--pill);
      color: var(--ink);
      cursor: pointer;
    }
    @keyframes kds-flash {
      50% {
        box-shadow: 0 0 0 6px rgb(99 102 241 / 70%);
      }
    }
    @keyframes kds-pulse {
      50% {
        filter: brightness(1.25);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .ticket.fresh,
      .ticket.late .age {
        animation: none;
      }
    }
  `,
})
export class KdsPage implements OnDestroy {
  protected readonly auth = inject(AuthService);
  protected readonly live = inject(LiveService);
  private readonly api = inject(PosApi);
  private readonly notify = inject(NotifyService);
  private readonly company = inject(Company);
  protected readonly Permissions = Permissions;
  protected readonly typeLabels = orderTypeLabels;
  protected readonly tableTag = tableTag;

  protected readonly board = signal<KitchenBoard>({ active: [], recentlyDone: [] });
  protected readonly stations = signal<Station[]>([]);
  protected readonly station = signal<string | null>(readStation());
  protected readonly busy = signal<string | null>(null);
  protected readonly sound = signal(true);
  protected readonly light = signal(readLight());
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

  protected toggleBoard(): void {
    const light = !this.light();
    this.light.set(light);
    try {
      localStorage.setItem(LightKey, light ? '1' : '0');
    } catch {
      // This tab only.
    }
  }

  // A station's header: its icon by its name (the grill, the bar, the oven…), a pot otherwise.
  protected stationIcon(name: string): string {
    const n = name.toLowerCase();
    if (/bar|drink|juice|coffee|مشروب|بار/.test(n)) return 'local_bar';
    if (/grill|مشوي|شوي/.test(n)) return 'outdoor_grill';
    if (/pizza|oven|bake|فرن|بيتزا/.test(n)) return 'local_pizza';
    if (/dessert|sweet|حلو/.test(n)) return 'icecream';
    if (/cold|salad|سلط/.test(n)) return 'eco';
    return 'soup_kitchen';
  }

  protected count(lines: TicketLine[]): number {
    return lines.reduce((n, l) => n + l.quantity, 0);
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

function readLight(): boolean {
  try {
    return localStorage.getItem(LightKey) === '1';
  } catch {
    return false;
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

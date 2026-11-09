import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ConnectivityService } from '../connectivity/connectivity.service';
import { LiveService } from './live.service';
import { OfflineStore } from './offline';
import { PosApi, SyncState } from './pos.api';

// The header's light (حالة المزامنة): online with everything synced, or working locally with what
// waits counted. What waits is this terminal's commands the server has not had yet, and the
// server's own queue for the linked systems (Costing, loyalty, HR) when they cannot be reached.
@Injectable({ providedIn: 'root' })
export class SyncStatus {
  private readonly api = inject(PosApi);
  private readonly connectivity = inject(ConnectivityService);
  private readonly live = inject(LiveService);
  readonly offline = inject(OfflineStore);

  readonly server = signal<SyncState | null>(null);
  readonly syncing = signal(false);

  // The server answers this terminal.
  readonly serverUp = computed(() => this.connectivity.online());

  readonly pending = computed(() => this.offline.pending() + (this.server()?.pending ?? 0));
  readonly failed = computed(() => this.offline.failed() + (this.server()?.failed ?? 0));

  // Online: the server reached, nothing of this terminal's waiting, and the linked systems (if any)
  // taking what is sent.
  readonly allSynced = computed(() => this.serverUp() && this.pending() === 0 && this.failed() === 0 && !this.server()?.lastSendFailed);

  readonly label = computed(() =>
    !this.serverUp()
      ? { en: `Offline / Local mode · ${this.pending()} pending sync`, ar: 'وضع محلي', tone: 'bad' as const }
      : this.allSynced()
        ? { en: 'Online · All synced', ar: 'متصل · تمت المزامنة', tone: 'ok' as const }
        : this.server()?.lastSendFailed && this.pending() > 0
          ? { en: `Offline / Local mode · ${this.pending()} pending sync`, ar: 'وضع محلي · بانتظار المزامنة', tone: 'warn' as const }
          : { en: `Online · ${this.pending() + this.failed()} to sync`, ar: 'بانتظار المزامنة', tone: 'warn' as const },
  );

  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.timer) {
      return;
    }
    void this.refresh();
    this.live.syncChanged.subscribe(() => void this.refresh());
    this.live.reconnected.subscribe(() => void this.syncNow(false));
    // Every few seconds: the server's queue, and this terminal's sent again when the server answers.
    this.timer = setInterval(() => {
      void this.refresh();
      if (this.offline.pending() > 0) {
        void this.offline.flush();
      }
    }, 8000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async refresh(): Promise<void> {
    try {
      this.server.set(await firstValueFrom(this.api.syncState()));
    } catch {
      // Unreachable: the light says so from the connectivity.
    }
  }

  // "Sync now" (مزامنة الآن): this terminal's queue first, then the server's sent at once.
  async syncNow(retryFailed: boolean): Promise<void> {
    this.syncing.set(true);
    try {
      await this.offline.flush();
      try {
        this.server.set(await firstValueFrom(this.api.syncNow(retryFailed)));
      } catch {
        // Not this user's to do, or unreachable: the light refreshes on its own.
      }
    } finally {
      this.syncing.set(false);
    }
  }
}

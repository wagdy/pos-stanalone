import { DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { AuthService } from '../../core/auth/auth.service';
import { Permissions } from '../../core/auth/permissions';
import { PosApi, SyncItem } from '../../core/pos/pos.api';
import { SyncStatus } from '../../core/pos/sync-status.service';
import { NotifyService } from '../../core/ui/notify.service';

const systemLabels: Record<string, string> = { Costing: 'Costing', Loyalty: 'Online ordering & loyalty', Hr: 'HR' };

// The sync drawer (مزامنة الآن): what this terminal did while the server could not be reached, and
// what the server keeps for the linked systems (Costing, loyalty, HR), each with why it waits; and
// Sync Now to send it all at once.
@Component({
  selector: 'app-sync-drawer',
  imports: [DatePipe, MatButtonModule, MatDialogModule, MatIconModule, MatProgressBarModule],
  template: `
    <h2 mat-dialog-title>
      <mat-icon>{{ sync.allSynced() ? 'cloud_done' : sync.serverUp() ? 'cloud_sync' : 'cloud_off' }}</mat-icon>
      Sync <span class="ar">المزامنة</span>
    </h2>
    <mat-dialog-content>
      <p class="state" [class]="sync.label().tone">
        <strong>{{ sync.label().en }}</strong> <span class="ar">{{ sync.label().ar }}</span>
      </p>
      @if (sync.syncing()) {
        <mat-progress-bar mode="indeterminate" />
      }

      <h3>This terminal <span class="ar">هذا الجهاز</span></h3>
      @if (!sync.offline.queue().length) {
        <p class="muted">Nothing waits here: every change reached the server.</p>
      } @else {
        <ul class="items">
          @for (c of sync.offline.queue(); track c.id) {
            <li [class.failed]="c.failed">
              <mat-icon>{{ c.failed ? 'error' : 'schedule' }}</mat-icon>
              <span class="what">
                <strong>{{ c.label }}</strong>
                <small class="muted">{{ c.createdAt | date: 'HH:mm:ss' }}{{ c.attempts ? ' · ' + c.attempts + ' tries' : '' }}</small>
                @if (c.lastError) {
                  <small class="error">{{ c.lastError }}</small>
                }
              </span>
              @if (c.failed) {
                <button mat-button (click)="retry(c.id)">Retry</button>
                <button mat-button class="danger" (click)="discard(c.id)">Discard</button>
              }
            </li>
          }
        </ul>
      }

      @if (canSeeServer()) {
        <h3>Linked systems <span class="ar">الأنظمة المرتبطة</span></h3>
        @if (!sync.server()?.anyLinked) {
          <p class="muted">No system is linked: Settings → Integrations links Costing, loyalty and HR.</p>
        } @else if (!serverItems().length) {
          <p class="muted">Everything was sent{{ sync.server()?.lastSentAtUtc ? ', last at ' + (sync.server()!.lastSentAtUtc | date: 'HH:mm') : '' }}.</p>
        } @else {
          <ul class="items">
            @for (i of serverItems(); track i.id) {
              <li [class.failed]="i.status === 'Failed'">
                <mat-icon>{{ i.status === 'Failed' ? 'error' : 'schedule' }}</mat-icon>
                <span class="what">
                  <strong>{{ systemLabel(i.system) }}: {{ i.summary }}</strong>
                  <small class="muted">{{ i.kind }} · {{ i.createdAtUtc | date: 'HH:mm' }} · {{ i.attempts }} tries · next {{ i.nextAttemptAtUtc | date: 'HH:mm:ss' }}</small>
                  @if (i.lastError) {
                    <small class="error">{{ i.lastError }}</small>
                  }
                </span>
              </li>
            }
          </ul>
        }
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      @if (sync.failed() > 0) {
        <button mat-button (click)="syncNow(true)" [disabled]="sync.syncing()">Retry the failed too</button>
      }
      <button mat-button mat-dialog-close>Close</button>
      <button mat-flat-button (click)="syncNow(false)" [disabled]="sync.syncing()"><mat-icon>sync</mat-icon> Sync now · مزامنة الآن</button>
    </mat-dialog-actions>
  `,
  styles: `
    h2 {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    h3 {
      margin: 16px 0 6px;
      font: var(--mat-sys-title-small);
    }
    .ar {
      direction: rtl;
      unicode-bidi: isolate;
      opacity: 0.72;
      margin-inline-start: 6px;
    }
    .muted {
      color: var(--mat-sys-on-surface-variant);
    }
    .state {
      padding: 10px 14px;
      border-radius: 12px;
      background: var(--tag-ok-bg);
      color: var(--tag-ok-fg);

      &.warn {
        background: var(--tag-warn-bg);
        color: var(--tag-warn-fg);
      }
      &.bad {
        background: var(--tag-bad-bg);
        color: var(--tag-bad-fg);
      }
    }
    .items {
      margin: 0;
      padding: 0;
      list-style: none;

      li {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 8px 0;
        border-bottom: 1px solid var(--app-line);
      }
      li.failed mat-icon {
        color: var(--mat-sys-error);
      }
      .what {
        display: grid;
        flex: 1;
        gap: 2px;
      }
    }
    .error {
      color: var(--mat-sys-error);
    }
    .danger {
      color: var(--mat-sys-error);
    }
  `,
})
export class SyncDrawer implements OnInit {
  protected readonly sync = inject(SyncStatus);
  private readonly api = inject(PosApi);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotifyService);

  protected readonly serverItems = signal<SyncItem[]>([]);
  protected readonly canSeeServer = computed(() => this.auth.can(Permissions.OrdersSettle));

  ngOnInit(): void {
    void this.load();
  }

  protected systemLabel(system: string): string {
    return systemLabels[system] ?? system;
  }

  protected async syncNow(retryFailed: boolean): Promise<void> {
    await this.sync.syncNow(retryFailed);
    await this.load();
    this.notify.info(this.sync.allSynced() ? 'Everything is synced. · تمت المزامنة.' : `${this.sync.pending() + this.sync.failed()} still wait.`);
  }

  protected async retry(id: string): Promise<void> {
    await this.sync.offline.retry(id);
  }

  protected async discard(id: string): Promise<void> {
    if (confirm('Discard this change? It will never reach the server.')) {
      await this.sync.offline.discard(id);
    }
  }

  private async load(): Promise<void> {
    if (!this.canSeeServer()) return;
    try {
      this.serverItems.set(await firstValueFrom(this.api.syncQueue()));
    } catch {
      // Unreachable: the drawer shows this terminal's alone.
    }
  }
}

import { DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../../core/http/error-message';
import { LiveService } from '../../../core/pos/live.service';
import { Link, LinkedSystem, MenuPullResult, PosApi, SyncItem } from '../../../core/pos/pos.api';
import { SyncStatus } from '../../../core/pos/sync-status.service';
import { NotifyService } from '../../../core/ui/notify.service';
import { saveBlob } from '../../../core/ui/save-blob';

interface LinkForm {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  branchCode: string;
}

const about: Record<LinkedSystem, { en: string; ar: string; icon: string; sends: string[]; urlHint: string }> = {
  Costing: {
    en: 'Costing & Financials',
    ar: 'نظام التكاليف',
    icon: 'calculate',
    sends: [
      'At each Z close: the day\'s sold quantities by item code',
      'Voids after the kitchen, as waste (or back to stock), with their reasons',
      'The takings: cash, Visa, wallet, tax, discounts, voids before and after, paid outs',
    ],
    urlHint: 'https://costing.example.com',
  },
  Loyalty: {
    en: 'Online ordering & loyalty',
    ar: 'الطلب أونلاين ونقاط الولاء',
    icon: 'loyalty',
    sends: [
      'Customers looked up by phone, and new ones registered at the till',
      'Points earned on every paid check, and points redeemed as a discount',
      'Live points balance and tier on the check',
    ],
    urlHint: 'https://order.example.com',
  },
  Hr: {
    en: 'HR & payroll',
    ar: 'الموارد البشرية',
    icon: 'badge',
    sends: ['Staff and their PINs, pulled from HR (Sync staff)', 'Clock in and out at the till', 'Staff advances (سلفيات) paid from the drawer', 'Staff meals (وجبات عاملين)'],
    urlHint: 'https://hr.example.com',
  },
};

// The ecosystem's links (الربط): Costing, online ordering and loyalty, and HR, each switched on with
// its address, key and branch code, and tested. What the till sends them waits in the server's queue
// (each sent once, by its id) and goes when they answer; the queue is shown here, with Sync now.
@Component({
  selector: 'app-integrations-page',
  imports: [DatePipe, FormsModule, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSlideToggleModule],
  template: `
    <div class="toolbar">
      <h1>Ecosystem integrations <span class="inline-ar">ربط الأنظمة</span></h1>
      <span class="spacer"></span>
      <span class="tag" [class]="sync.label().tone">{{ sync.label().en }}</span>
    </div>
    <p class="note">
      <span class="note-ar">كل نظام مستقل: نقطة البيع تعمل وحدها، وترسل للأنظمة المرتبطة عند الاتصال.</span>
      Each system stays on its own: the till works without them, and what it sends them waits here until they answer. Nothing is queued for a link that is off.
    </p>

    <div class="links">
      @for (l of links(); track l.system) {
        @if (forms()[l.system]; as f) {
          <section class="card link" [class.on]="f.enabled">
            <header>
              <span class="icon"><mat-icon>{{ about[l.system].icon }}</mat-icon></span>
              <div>
                <h2>{{ about[l.system].en }}</h2>
                <span class="ar">{{ about[l.system].ar }}</span>
              </div>
              <span class="spacer"></span>
              <mat-slide-toggle [(ngModel)]="f.enabled" [attr.aria-label]="'Link ' + about[l.system].en" />
            </header>
            <ul class="sends">
              @for (s of about[l.system].sends; track s) {
                <li>{{ s }}</li>
              }
            </ul>
            <mat-form-field class="wide" subscriptSizing="dynamic">
              <mat-label>{{ l.system === 'Loyalty' ? 'URL / webhook' : 'URL' }}</mat-label>
              <input matInput [(ngModel)]="f.baseUrl" [placeholder]="about[l.system].urlHint" type="url" />
            </mat-form-field>
            <div class="row">
              <mat-form-field subscriptSizing="dynamic" class="grow">
                <mat-label>API key{{ l.hasApiKey ? ' (kept: ' + l.apiKeyHint + ')' : '' }}</mat-label>
                <input matInput [(ngModel)]="f.apiKey" type="password" autocomplete="off" [placeholder]="l.hasApiKey ? 'Leave empty to keep it' : 'The key the other system gave'" />
              </mat-form-field>
              <mat-form-field subscriptSizing="dynamic">
                <mat-label>Branch code</mat-label>
                <input matInput [(ngModel)]="f.branchCode" maxlength="40" />
              </mat-form-field>
            </div>
            <div class="status">
              @if (l.lastTestedAtUtc) {
                <span class="tag" [class.ok]="l.lastTestOk" [class.bad]="!l.lastTestOk">{{ l.lastTestOk ? 'Connected' : 'Not reached' }} · {{ l.lastTestedAtUtc | date: 'dd/MM HH:mm' }}</span>
                @if (l.lastTestMessage) {
                  <small class="muted">{{ l.lastTestMessage }}</small>
                }
              } @else {
                <span class="tag faint">Not tested</span>
              }
              @if (l.pending || l.failed) {
                <span class="tag warn">{{ l.pending }} waiting{{ l.failed ? ' · ' + l.failed + ' failed' : '' }}</span>
              }
            </div>
            <div class="row end">
              @if (l.system === 'Hr') {
                <button mat-button (click)="syncStaff()" [disabled]="!l.enabled || busy()"><mat-icon>group_add</mat-icon> Sync staff</button>
              }
              <button mat-button (click)="test(l.system)" [disabled]="busy()"><mat-icon>network_check</mat-icon> Test</button>
              <button mat-flat-button (click)="save(l.system)" [disabled]="busy()"><mat-icon>save</mat-icon> Save</button>
            </div>
            @if (l.system === 'Costing') {
              <div class="export pull">
                <strong>Menu from Costing · سحب المنيو من التكاليف</strong>
                <small class="muted">Takes Costing's categories, items, sizes, prices and codes as this POS's menu. Each item's kitchen station and
                  modifiers stay as set here; an item Costing no longer sells is taken off. Unlinked, the menu is kept by hand on Setup → Menu.</small>
                <div class="row">
                  <button mat-flat-button (click)="pullMenu()" [disabled]="!l.enabled || !l.hasApiKey || busy()"><mat-icon>cloud_download</mat-icon> Pull menu from Costing</button>
                  @if (pulled(); as p) {
                    <span class="tag ok">{{ p.items }} items · {{ p.itemsAdded }} new · {{ p.itemsUpdated }} updated · {{ p.itemsTakenOff }} taken off · {{ p.sizes }} sizes</span>
                  }
                </div>
              </div>
              <div class="export">
                <strong>Excel for Costing's import · تصدير إكسل</strong>
                <small class="muted">The day's sales, voids after the kitchen and takings, laid out as Costing's import sheets.</small>
                <div class="row">
                  <input type="date" [(ngModel)]="sheetDate" aria-label="Day" />
                  <button mat-stroked-button (click)="sheet()"><mat-icon>download</mat-icon> Download .xlsx</button>
                </div>
              </div>
            }
          </section>
        }
      }
    </div>

    <section class="card queue">
      <div class="toolbar">
        <h2>Sync queue · قائمة المزامنة</h2>
        <span class="spacer"></span>
        @if (failedCount()) {
          <button mat-button (click)="syncNow(true)" [disabled]="sync.syncing()">Retry the failed</button>
        }
        <button mat-flat-button (click)="syncNow(false)" [disabled]="sync.syncing()"><mat-icon>sync</mat-icon> Sync now · مزامنة الآن</button>
      </div>
      <div class="table-wrap">
        <table class="grid">
          <thead><tr><th>System</th><th>What</th><th>Status</th><th class="num">Tries</th><th>Queued</th><th>Next / sent</th><th>Error</th></tr></thead>
          <tbody>
            @for (i of queue(); track i.id) {
              <tr>
                <td>{{ about[i.system].en }}</td>
                <td><strong>{{ i.summary }}</strong> <small class="muted">{{ i.kind }}</small></td>
                <td><span class="tag" [class.ok]="i.status === 'Sent'" [class.warn]="i.status === 'Pending'" [class.bad]="i.status === 'Failed'">{{ i.status }}</span></td>
                <td class="num">{{ i.attempts }}</td>
                <td>{{ i.createdAtUtc | date: 'dd/MM HH:mm' }}</td>
                <td>{{ (i.sentAtUtc ?? i.nextAttemptAtUtc) | date: 'dd/MM HH:mm:ss' }}</td>
                <td class="err">{{ i.lastError }}</td>
              </tr>
            } @empty {
              <tr><td colspan="7" class="muted">Nothing waits: everything was sent.</td></tr>
            }
          </tbody>
        </table>
      </div>
    </section>
  `,
  styleUrl: '../../shared/pages.scss',
  styles: `
    h1 {
      margin: 0;
      font: var(--mat-sys-headline-small);
      font-weight: 650;
    }
    h2 {
      margin: 0;
      font: var(--mat-sys-title-medium);
    }
    .muted {
      color: var(--mat-sys-on-surface-variant);
    }
    .card {
      padding: 16px;
      border-radius: 16px;
      border: 1px solid var(--app-line);
      background: var(--mat-sys-surface-container-lowest);
      box-shadow: var(--app-card-shadow);
    }
    .links {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
      gap: 14px;
      margin-bottom: 14px;
    }
    .link {
      display: flex;
      flex-direction: column;
      gap: 10px;
      border-top: 4px solid var(--app-line-strong);

      &.on {
        border-top-color: var(--mat-sys-primary);
      }
      header {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .icon {
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        border-radius: 12px;
        background: var(--mat-sys-primary-container);
        color: var(--mat-sys-on-primary-container);
      }
      .ar {
        display: inline;
        font-size: 13px;
      }
    }
    .sends {
      margin: 0;
      padding-left: 18px;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }
    .wide {
      width: 100%;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;

      &.end {
        justify-content: flex-end;
        margin-top: auto;
      }
      .grow {
        flex: 1;
        min-width: 200px;
      }
    }
    .status {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .export {
      display: grid;
      gap: 6px;
      padding: 12px;
      border-radius: 12px;
      background: var(--mat-sys-surface-container-low);

      input {
        height: 36px;
        padding: 0 8px;
        border: 1px solid var(--app-line-strong);
        border-radius: 8px;
        background: transparent;
        color: inherit;
        font: inherit;
      }
    }
    .err {
      max-width: 280px;
      color: var(--mat-sys-error);
      font-size: 12.5px;
    }
    @media (max-width: 599.98px) {
      .links {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  `,
})
export class IntegrationsPage implements OnInit {
  private readonly api = inject(PosApi);
  private readonly notify = inject(NotifyService);
  private readonly live = inject(LiveService);
  protected readonly sync = inject(SyncStatus);
  protected readonly about = about;

  protected readonly links = signal<Link[]>([]);
  protected readonly forms = signal<Partial<Record<LinkedSystem, LinkForm>>>({});
  protected readonly queue = signal<SyncItem[]>([]);
  protected readonly busy = signal(false);
  protected readonly pulled = signal<MenuPullResult | null>(null);
  protected readonly failedCount = computed(() => this.queue().filter((i) => i.status === 'Failed').length);
  protected sheetDate = new Date().toISOString().slice(0, 10);

  constructor() {
    this.live.syncChanged.pipe(takeUntilDestroyed()).subscribe(() => {
      void this.loadQueue();
      void this.loadLinks(false);
    });
  }

  ngOnInit(): void {
    void this.loadLinks(true);
    void this.loadQueue();
  }

  protected async save(system: LinkedSystem): Promise<void> {
    const f = this.forms()[system];
    if (!f) return;
    await this.act(async () => {
      const saved = await firstValueFrom(
        this.api.saveLink(system, { enabled: f.enabled, baseUrl: f.baseUrl.trim() || null, apiKey: f.apiKey.trim() || null, branchCode: f.branchCode.trim() || null }),
      );
      this.take(saved, true);
      this.notify.info(`${about[system].en} ${saved.enabled ? 'linked' : 'saved, switched off'}.`);
    }, 'The link could not be saved.');
  }

  protected async test(system: LinkedSystem): Promise<void> {
    await this.act(async () => {
      const tested = await firstValueFrom(this.api.testLink(system));
      this.take(tested, false);
      if (tested.lastTestOk) this.notify.info(`${about[system].en} answered. · تم الاتصال`);
      else this.notify.error(null, `${about[system].en} was not reached: ${tested.lastTestMessage ?? ''}`);
    }, 'The test could not be run.');
  }

  protected async syncStaff(): Promise<void> {
    await this.act(async () => {
      const r = await firstValueFrom(this.api.syncHrStaff());
      this.notify.info(`From HR: ${r.received} staff, ${r.added} added, ${r.updated} updated, ${r.skipped} skipped.`);
    }, 'The staff could not be synced.');
  }

  protected async pullMenu(): Promise<void> {
    if (!confirm("Take Costing's menu as this POS's menu? Names, prices and sizes are replaced by Costing's; stations and modifiers stay. · سحب المنيو")) return;
    await this.act(async () => {
      const result = await firstValueFrom(this.api.pullCostingMenu());
      this.pulled.set(result);
      this.notify.info(`Menu pulled from Costing: ${result.items} items (${result.itemsAdded} new, ${result.itemsTakenOff} taken off). · تم سحب المنيو`);
    }, 'The menu could not be pulled from Costing.');
  }

  protected async sheet(): Promise<void> {
    try {
      saveBlob(await firstValueFrom(this.api.costingSheet(this.sheetDate)), `pos-costing-${this.sheetDate}.xlsx`);
    } catch (error) {
      this.notify.error(error, errorMessage(error, 'The sheet could not be made.'));
    }
  }

  protected async syncNow(retryFailed: boolean): Promise<void> {
    await this.sync.syncNow(retryFailed);
    await Promise.all([this.loadQueue(), this.loadLinks(false)]);
  }

  private async act(work: () => Promise<void>, failed: string): Promise<void> {
    this.busy.set(true);
    try {
      await work();
    } catch (error) {
      this.notify.error(error, errorMessage(error, failed));
    } finally {
      this.busy.set(false);
    }
  }

  // The links as saved; the forms (what is being typed) reset only when asked.
  private async loadLinks(resetForms: boolean): Promise<void> {
    try {
      const links = await firstValueFrom(this.api.links());
      this.links.set(links);
      if (resetForms || !Object.keys(this.forms()).length) {
        this.forms.set(Object.fromEntries(links.map((l) => [l.system, this.formOf(l)])));
      }
    } catch (error) {
      this.notify.error(error, 'The links could not be loaded.');
    }
  }

  private take(link: Link, resetForm: boolean): void {
    this.links.update((all) => all.map((l) => (l.system === link.system ? link : l)));
    if (resetForm) this.forms.update((forms) => ({ ...forms, [link.system]: this.formOf(link) }));
  }

  private formOf(l: Link): LinkForm {
    return { enabled: l.enabled, baseUrl: l.baseUrl ?? '', apiKey: '', branchCode: l.branchCode ?? '' };
  }

  private async loadQueue(): Promise<void> {
    try {
      this.queue.set(await firstValueFrom(this.api.syncQueue()));
    } catch {
      // Kept.
    }
  }
}

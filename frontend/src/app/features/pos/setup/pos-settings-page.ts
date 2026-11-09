import { DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../../core/http/error-message';
import { PosApi, PosSettings } from '../../../core/pos/pos.api';
import { NotifyService } from '../../../core/ui/notify.service';
import { PosStore } from '../pos-store';

type Editable = Omit<PosSettings, 'updatedBy' | 'updatedAtUtc'>;

// The till's own settings (إعدادات البيع): VAT and the dine-in service charge, what the check says at
// its head and foot, the loyalty points earned and what they are worth, how much a cashier may
// discount without a manager, the reasons a void after the kitchen is given, and the quick notes
// for the kitchen. And, into an empty system, a sample restaurant to start from.
@Component({
  selector: 'app-pos-settings-page',
  imports: [DatePipe, FormsModule, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule],
  template: `
    <div class="toolbar">
      <h1>POS settings <span class="inline-ar">إعدادات نقطة البيع</span></h1>
      <span class="spacer"></span>
      @if (saved(); as s) {
        @if (s.updatedAtUtc) {
          <span class="muted">Saved by {{ s.updatedBy }} · {{ s.updatedAtUtc | date: 'dd/MM HH:mm' }}</span>
        }
      }
    </div>

    @if (form(); as f) {
      <div class="cards">
        <section class="card">
          <h2>Tax &amp; service · الضريبة والخدمة</h2>
          <div class="fields">
            <mat-form-field subscriptSizing="dynamic"><mat-label>VAT % · ضريبة</mat-label><input matInput type="number" min="0" max="100" step="any" [(ngModel)]="f.taxPercent" /></mat-form-field>
            <mat-form-field subscriptSizing="dynamic"><mat-label>Service % (dine-in) · خدمة</mat-label><input matInput type="number" min="0" max="100" step="any" [(ngModel)]="f.servicePercent" /></mat-form-field>
            <mat-form-field subscriptSizing="dynamic"><mat-label>Tax number · الرقم الضريبي</mat-label><input matInput [(ngModel)]="f.taxNumber" maxlength="60" /></mat-form-field>
          </div>
          <p class="muted">Service is charged on the net of dine-in checks; VAT on the net and the service.</p>
        </section>

        <section class="card">
          <h2>The check · الشيك</h2>
          <mat-form-field class="wide" subscriptSizing="dynamic"><mat-label>Header (address, phone) · رأس الشيك</mat-label><textarea matInput rows="2" [(ngModel)]="f.receiptHeader" maxlength="400"></textarea></mat-form-field>
          <mat-form-field class="wide" subscriptSizing="dynamic"><mat-label>Footer (thanks, wifi) · ذيل الشيك</mat-label><textarea matInput rows="2" [(ngModel)]="f.receiptFooter" maxlength="400"></textarea></mat-form-field>
        </section>

        <section class="card">
          <h2>Loyalty points · نقاط الولاء</h2>
          <div class="fields">
            <mat-form-field subscriptSizing="dynamic"><mat-label>Points per 1 of money spent</mat-label><input matInput type="number" min="0" step="any" [(ngModel)]="f.pointsPerCurrencyUnit" /></mat-form-field>
            <mat-form-field subscriptSizing="dynamic"><mat-label>100 points are worth</mat-label><input matInput type="number" min="0" step="any" [(ngModel)]="f.redemptionValuePer100Points" /></mat-form-field>
          </div>
          <p class="muted">A check of 500 earns {{ example(f) }} points. Points are earned on paid checks with a customer on them.</p>
        </section>

        <section class="card">
          <h2>Discounts · الخصومات</h2>
          <mat-form-field subscriptSizing="dynamic"><mat-label>A cashier's limit, % · حد الكاشير</mat-label><input matInput type="number" min="0" max="100" step="any" [(ngModel)]="f.cashierDiscountLimitPercent" /></mat-form-field>
          <p class="muted">Past it, a manager's PIN.</p>
        </section>

        @for (list of lists; track list.key) {
          <section class="card">
            <h2>{{ list.en }} <span class="inline-ar">{{ list.ar }}</span></h2>
            <div class="chips">
              @for (v of f[list.key]; track $index) {
                <span class="chip">{{ v }} <button type="button" (click)="drop(list.key, $index)" [attr.aria-label]="'Remove ' + v"><mat-icon>close</mat-icon></button></span>
              }
            </div>
            <form class="add" (ngSubmit)="push(list.key, input)">
              <input #input [placeholder]="list.placeholder" [attr.aria-label]="'New ' + list.en" maxlength="80" />
              <button mat-stroked-button type="submit"><mat-icon>add</mat-icon> Add</button>
            </form>
          </section>
        }
      </div>

      <div class="save-bar">
        <button mat-stroked-button (click)="loadSample()"><mat-icon>restaurant</mat-icon> Load a sample restaurant · مطعم تجريبي</button>
        <span class="spacer"></span>
        <button mat-flat-button (click)="save()" [disabled]="busy()"><mat-icon>save</mat-icon> Save · حفظ</button>
      </div>
    }
  `,
  styleUrl: '../../shared/pages.scss',
  styles: `
    h1 {
      margin: 0;
      font: var(--mat-sys-headline-small);
      font-weight: 650;
    }
    h2 {
      margin: 0 0 10px;
      font: var(--mat-sys-title-medium);
    }
    .muted {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
      gap: 14px;
    }
    .card {
      padding: 16px;
      border-radius: 16px;
      border: 1px solid var(--app-line);
      background: var(--mat-sys-surface-container-lowest);
      box-shadow: var(--app-card-shadow);
    }
    .fields {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .wide {
      width: 100%;
      margin-bottom: 8px;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 8px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px 4px 2px 12px;
      border-radius: 999px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);

      button {
        display: inline-grid;
        place-items: center;
        width: 24px;
        height: 24px;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: inherit;
        cursor: pointer;
      }
      mat-icon {
        width: 16px;
        height: 16px;
        font-size: 16px;
      }
    }
    .add {
      display: flex;
      gap: 6px;

      input {
        flex: 1;
        height: 36px;
        padding: 0 10px;
        border: 1px solid var(--app-line-strong);
        border-radius: 10px;
        background: transparent;
        color: inherit;
        font: inherit;
      }
    }
    .save-bar {
      position: sticky;
      bottom: 0;
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 14px;
      padding: 12px 0;
      background: var(--mat-sys-surface-container-lowest);
      border-top: 1px solid var(--app-line);
    }
    @media (max-width: 599.98px) {
      .cards {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  `,
})
export class PosSettingsPage implements OnInit {
  private readonly api = inject(PosApi);
  private readonly store = inject(PosStore);
  private readonly notify = inject(NotifyService);

  protected readonly saved = signal<PosSettings | null>(null);
  protected readonly form = signal<Editable | null>(null);
  protected readonly busy = signal(false);
  protected readonly lists: { key: 'voidReasons' | 'quickNotes'; en: string; ar: string; placeholder: string }[] = [
    { key: 'voidReasons', en: 'Void reasons', ar: 'أسباب الإلغاء', placeholder: 'e.g. Quality of the item' },
    { key: 'quickNotes', en: 'Quick kitchen notes', ar: 'ملاحظات سريعة', placeholder: 'e.g. بدون بصل' },
  ];

  ngOnInit(): void {
    void this.load();
  }

  protected example(f: Editable): number {
    return Math.floor(500 * (Number(f.pointsPerCurrencyUnit) || 0));
  }

  protected push(key: 'voidReasons' | 'quickNotes', input: HTMLInputElement): void {
    const value = input.value.trim();
    const f = this.form();
    if (!value || !f || f[key].includes(value)) return;
    this.form.set({ ...f, [key]: [...f[key], value] });
    input.value = '';
  }

  protected drop(key: 'voidReasons' | 'quickNotes', index: number): void {
    const f = this.form();
    if (f) this.form.set({ ...f, [key]: f[key].filter((_, i) => i !== index) });
  }

  protected async save(): Promise<void> {
    const f = this.form();
    if (!f) return;
    this.busy.set(true);
    try {
      const settings = await firstValueFrom(
        this.api.saveSettings({
          ...f,
          taxPercent: Number(f.taxPercent),
          servicePercent: Number(f.servicePercent),
          pointsPerCurrencyUnit: Number(f.pointsPerCurrencyUnit),
          redemptionValuePer100Points: Number(f.redemptionValuePer100Points),
          cashierDiscountLimitPercent: Number(f.cashierDiscountLimitPercent),
          receiptHeader: f.receiptHeader?.trim() || null,
          receiptFooter: f.receiptFooter?.trim() || null,
          taxNumber: f.taxNumber?.trim() || null,
        }),
      );
      this.take(settings);
      void this.store.loadMenu();
      this.notify.info('Saved. New checks use these at once. · تم الحفظ');
    } catch (error) {
      this.notify.error(error, errorMessage(error, 'The settings could not be saved.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected async loadSample(): Promise<void> {
    if (!confirm('Load a sample restaurant (4 stations, a menu, 18 tables, a browser printer)? Only into a system with no menu yet.')) return;
    try {
      await firstValueFrom(this.api.loadSample());
      await Promise.all([this.store.loadMenu(), this.store.loadFloor()]);
      this.notify.info('The sample restaurant is loaded. · تم تحميل المطعم التجريبي');
    } catch (error) {
      this.notify.error(error, errorMessage(error, 'The sample could not be loaded.'));
    }
  }

  private async load(): Promise<void> {
    try {
      this.take(await firstValueFrom(this.api.settings()));
    } catch (error) {
      this.notify.error(error, 'The settings could not be loaded.');
    }
  }

  private take(settings: PosSettings): void {
    this.saved.set(settings);
    const { updatedBy: _, updatedAtUtc: __, ...editable } = settings;
    this.form.set({ ...editable, voidReasons: [...editable.voidReasons], quickNotes: [...editable.quickNotes] });
  }
}

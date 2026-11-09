import { DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../../core/http/error-message';
import { LiveService } from '../../../core/pos/live.service';
import { PaidOutKind, PosApi, Shift, ZReport, newId, orderTypeLabels } from '../../../core/pos/pos.api';
import { zReportHtml } from '../../../core/pos/print';
import { Company } from '../../../core/settings/company';
import { MoneyPipe } from '../../../core/ui/money.pipe';
import { NotifyService } from '../../../core/ui/notify.service';
import { saveBlob } from '../../../core/ui/save-blob';
import { PrintPreviewData, PrintPreviewDialog } from '../print-preview';

const paidOutLabels: Record<PaidOutKind, { en: string; ar: string }> = {
  Expense: { en: 'Expense', ar: 'مصروف' },
  StaffAdvance: { en: 'Staff advance', ar: 'سلفة' },
  Driver: { en: 'Driver', ar: 'سائق' },
};

// The shift (الوردية): opened with its float; paid-outs (an expense, a staff advance that goes to
// HR, a driver); the X report as it stands; closed with the cash counted, its Z report kept, printed
// and sent to Costing. Past shifts keep their Z reports and the day's sheet for Costing. And the
// staff's clock in and out by PIN.
@Component({
  selector: 'app-shift-page',
  imports: [DatePipe, FormsModule, MatButtonModule, MatButtonToggleModule, MatCheckboxModule, MatFormFieldModule, MatIconModule, MatInputModule,
    MatProgressBarModule, MoneyPipe],
  templateUrl: './shift-page.html',
  styleUrl: './shift-page.scss',
})
export class ShiftPage implements OnInit {
  private readonly api = inject(PosApi);
  private readonly notify = inject(NotifyService);
  private readonly dialog = inject(MatDialog);
  private readonly live = inject(LiveService);
  protected readonly company = inject(Company);
  protected readonly typeLabels = orderTypeLabels;
  protected readonly paidOutLabels = paidOutLabels;
  protected readonly paidOutKinds: PaidOutKind[] = ['Expense', 'StaffAdvance', 'Driver'];

  protected readonly shift = signal<Shift | null | undefined>(undefined);
  protected readonly report = signal<ZReport | null>(null);
  protected readonly history = signal<Shift[]>([]);
  protected readonly busy = signal(false);

  protected openingFloat: number | null = null;
  protected paidOut = { kind: 'Expense' as PaidOutKind, amount: null as number | null, reason: '', staffName: '' };
  protected counted: number | null = null;
  protected printZ = true;
  protected clockPin = '';
  protected readonly lastClock = signal<string | null>(null);

  protected readonly closedShifts = computed(() => this.history().filter((s) => s.status === 'Closed'));

  constructor() {
    this.live.shiftChanged.pipe(takeUntilDestroyed()).subscribe(() => void this.load());
    this.live.ordersChanged.pipe(takeUntilDestroyed()).subscribe(() => void this.loadReport());
  }

  ngOnInit(): void {
    void this.load();
  }

  protected varianceOf(report: ZReport): number | null {
    return this.counted == null ? null : Math.round((this.counted - report.expectedCash) * 100) / 100;
  }

  protected async open(): Promise<void> {
    await this.act(async () => {
      await firstValueFrom(this.api.openShift(newId(), Number(this.openingFloat) || 0));
      this.openingFloat = null;
      this.notify.info('The shift is open. · تم فتح الوردية');
    }, 'The shift could not be opened.');
  }

  protected async addPaidOut(): Promise<void> {
    const p = this.paidOut;
    if (!p.amount || !p.reason.trim()) {
      this.notify.error(null, 'Give the amount and what it was for.');
      return;
    }
    await this.act(async () => {
      await firstValueFrom(
        this.api.payOut({ paidOutId: newId(), kind: p.kind, amount: Number(p.amount), reason: p.reason.trim(), staffName: p.staffName.trim() || null }),
      );
      this.paidOut = { kind: p.kind, amount: null, reason: '', staffName: '' };
      this.notify.info(p.kind === 'StaffAdvance' ? 'Paid out; the advance goes to HR. · سلفة' : 'Paid out. · تم الصرف');
    }, 'It could not be paid out.');
  }

  protected async close(): Promise<void> {
    const shift = this.shift();
    if (!shift || this.counted == null) return;
    if (!confirm(`Close shift ${shift.number} with ${this.company.money(Number(this.counted))} counted? · إغلاق الوردية`)) return;
    await this.act(async () => {
      const z = await firstValueFrom(this.api.closeShift(shift.id, Number(this.counted), this.printZ));
      this.counted = null;
      this.notify.info(`Shift ${z.number} closed. Variance ${this.company.money(z.variance ?? 0)}. · تم إغلاق الوردية`);
      this.preview(z);
    }, 'The shift could not be closed.');
  }

  protected async clock(): Promise<void> {
    if (!/^\d{4}$/.test(this.clockPin)) {
      this.notify.error(null, 'Four digits.');
      return;
    }
    try {
      const result = await firstValueFrom(this.api.clock(this.clockPin));
      this.lastClock.set(`${result.name} clocked ${result.clockedIn ? 'in' : 'out'} at ${this.company.formatLocal(result.atUtc, false)}`);
    } catch (error) {
      this.notify.error(error, errorMessage(error, 'That PIN is not right.'));
    } finally {
      this.clockPin = '';
    }
  }

  protected preview(z: ZReport): void {
    this.dialog.open<PrintPreviewDialog, PrintPreviewData>(PrintPreviewDialog, {
      data: { title: `${z.isClosed ? 'Z' : 'X'} report · shift ${z.number}`, html: zReportHtml(z, this.company, (utc) => this.company.formatLocal(utc)) },
      maxWidth: '96vw',
    });
  }

  protected async previewShift(shift: Shift): Promise<void> {
    try {
      this.preview(await firstValueFrom(this.api.shiftReport(shift.id)));
    } catch (error) {
      this.notify.error(error, 'The report could not be loaded.');
    }
  }

  protected async costingSheet(date: string): Promise<void> {
    try {
      saveBlob(await firstValueFrom(this.api.costingSheet(date)), `pos-costing-${date}.xlsx`);
    } catch (error) {
      this.notify.error(error, errorMessage(error, 'The sheet could not be made.'));
    }
  }

  private async act(work: () => Promise<void>, failed: string): Promise<void> {
    this.busy.set(true);
    try {
      await work();
      await this.load();
    } catch (error) {
      this.notify.error(error, errorMessage(error, failed));
    } finally {
      this.busy.set(false);
    }
  }

  private async load(): Promise<void> {
    try {
      const [shift, history] = await Promise.all([firstValueFrom(this.api.currentShift()), firstValueFrom(this.api.shifts())]);
      this.shift.set(shift);
      this.history.set(history);
      await this.loadReport();
    } catch (error) {
      this.notify.error(error, 'The shift could not be loaded.');
    }
  }

  private async loadReport(): Promise<void> {
    const shift = this.shift();
    if (!shift) {
      this.report.set(null);
      return;
    }
    try {
      this.report.set(await firstValueFrom(this.api.shiftReport(shift.id)));
    } catch {
      // Kept as it was.
    }
  }
}

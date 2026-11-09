import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../../core/http/error-message';
import { PosApi, Printer, PrinterConnection, PrinterRole, newId } from '../../../core/pos/pos.api';
import { PrintService } from '../../../core/pos/print';
import { NotifyService } from '../../../core/ui/notify.service';

// The printers (الطابعات): a thermal printer on the network (ESC/POS on TCP 9100, the server prints
// to it straight), or this browser's own printer (the print station prints what the server asks of
// it, silently in kiosk mode or through the print dialog). Each kitchen station prints on the printer
// it is given (Menu → Kitchen stations); the cashier's printer prints the checks and receipts.
@Component({
  selector: 'app-printers-page',
  imports: [FormsModule, MatButtonModule, MatButtonToggleModule, MatCheckboxModule, MatIconModule, MatSlideToggleModule],
  template: `
    <div class="toolbar">
      <h1>Printers <span class="inline-ar">الطابعات</span></h1>
      <span class="spacer"></span>
      <button mat-flat-button (click)="add()"><mat-icon>add</mat-icon> New printer · طابعة جديدة</button>
    </div>

    <section class="station card">
      <mat-slide-toggle [checked]="printer.station()" (change)="printer.setStation($event.checked)">
        <strong>This browser is the print station · محطة الطباعة</strong>
      </mat-slide-toggle>
      <p class="muted">
        The print station prints what goes to a browser printer: the checks a captain asks for, and the kitchen tickets of a station whose printer is a
        browser one. Keep it on at the cashier's terminal only. For silent printing with no dialog, start Chrome with
        <code>--kiosk-printing</code> and set the 80 mm printer as its default.
      </p>
    </section>

    <div class="printers">
      @for (p of rows(); track p.id) {
        <section class="card printer" [class.off]="!p.isActive">
          <div class="row">
            <input class="name" [(ngModel)]="p.name" placeholder="Name, e.g. Grill printer" aria-label="Printer name" />
            <mat-checkbox [(ngModel)]="p.isActive">In use</mat-checkbox>
          </div>
          <div class="row">
            <mat-button-toggle-group [(ngModel)]="p.connection" aria-label="How it is reached">
              @for (c of connections; track c.key) {
                <mat-button-toggle [value]="c.key"><mat-icon>{{ c.icon }}</mat-icon> {{ c.en }}</mat-button-toggle>
              }
            </mat-button-toggle-group>
            <mat-button-toggle-group [(ngModel)]="p.role" aria-label="What it prints">
              <mat-button-toggle value="Cashier">Cashier · الكاشير</mat-button-toggle>
              <mat-button-toggle value="Kitchen">Kitchen · المطبخ</mat-button-toggle>
            </mat-button-toggle-group>
          </div>
          @if (p.connection === 'Network') {
            <div class="row">
              <label>IP address <input [(ngModel)]="p.host" placeholder="192.168.1.50" aria-label="IP address" /></label>
              <label>Port <input class="n" type="number" [(ngModel)]="p.port" aria-label="Port" /></label>
              <label>Characters a line <input class="n" type="number" [(ngModel)]="p.charactersPerLine" aria-label="Characters a line" /></label>
            </div>
            <p class="muted small">ESC/POS over TCP. Arabic names are left off on the network printer (its font has no Arabic); the kitchen screen and browser prints show them.</p>
          } @else {
            <p class="muted small">Printed by the print station's browser at 80 mm.</p>
          }
          @if (p.stations.length) {
            <p class="small">Stations: {{ p.stations.join(', ') }}</p>
          }
          <div class="row end">
            <button mat-button (click)="test(p)"><mat-icon>print</mat-icon> Test page</button>
            <button mat-button (click)="remove(p)"><mat-icon>delete</mat-icon> Delete</button>
            <button mat-flat-button (click)="save(p)"><mat-icon>save</mat-icon> Save</button>
          </div>
        </section>
      } @empty {
        <p class="muted">No printers yet. Without one, the checks print in this browser.</p>
      }
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
    .small {
      margin: 4px 0;
      font-size: 13px;
    }
    .card {
      padding: 16px;
      border-radius: 16px;
      border: 1px solid var(--app-line);
      background: var(--mat-sys-surface-container-lowest);
      box-shadow: var(--app-card-shadow);
    }
    .station {
      margin-bottom: 14px;
    }
    .printers {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
      gap: 14px;
    }
    .printer.off {
      opacity: 0.65;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;

      &.end {
        justify-content: flex-end;
        margin: 8px 0 0;
      }
    }
    input {
      height: 34px;
      padding: 0 8px;
      border: 1px solid var(--app-line-strong);
      border-radius: 8px;
      background: transparent;
      color: inherit;
      font: inherit;
    }
    input.name {
      flex: 1;
      font-weight: 600;
    }
    input.n {
      width: 70px;
    }
    label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
    }
    @media (max-width: 599.98px) {
      .printers {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  `,
})
export class PrintersPage implements OnInit {
  private readonly api = inject(PosApi);
  private readonly notify = inject(NotifyService);
  protected readonly printer = inject(PrintService);
  protected readonly connections: { key: PrinterConnection; en: string; icon: string }[] = [
    { key: 'Network', en: 'Network (ESC/POS)', icon: 'lan' },
    { key: 'Browser', en: 'Browser', icon: 'web' },
  ];
  protected readonly rows = signal<Printer[]>([]);

  ngOnInit(): void {
    void this.load();
  }

  protected add(): void {
    this.rows.update((rows) => [
      ...rows,
      { id: newId(), name: '', connection: 'Network', role: 'Kitchen' as PrinterRole, host: '', port: 9100, charactersPerLine: 48, isActive: true, stations: [] },
    ]);
  }

  protected async save(p: Printer): Promise<void> {
    try {
      await firstValueFrom(
        this.api.savePrinter(p.id, {
          name: p.name.trim(),
          connection: p.connection,
          role: p.role,
          host: p.connection === 'Network' ? p.host?.trim() || null : null,
          port: Number(p.port) || 9100,
          charactersPerLine: Number(p.charactersPerLine) || 48,
          isActive: p.isActive,
        }),
      );
      this.notify.info(`${p.name} saved.`);
      await this.load();
    } catch (error) {
      this.notify.error(error, errorMessage(error, 'The printer could not be saved.'));
    }
  }

  protected async test(p: Printer): Promise<void> {
    try {
      await firstValueFrom(this.api.print('Test', p.id, p.id));
      this.notify.info(p.connection === 'Network' ? `A test page went to ${p.host}:${p.port}.` : 'A test page went to the print station.');
    } catch (error) {
      this.notify.error(error, errorMessage(error, 'The test page could not be printed: save the printer first.'));
    }
  }

  protected async remove(p: Printer): Promise<void> {
    if (!confirm(`Delete ${p.name || 'this printer'}? Its stations print nowhere until given another.`)) return;
    try {
      await firstValueFrom(this.api.deletePrinter(p.id));
      await this.load();
    } catch (error) {
      // Never saved: only on this page.
      this.rows.update((rows) => rows.filter((r) => r.id !== p.id));
      if (!(error as { status?: number })?.status || (error as { status?: number }).status !== 404) this.notify.error(error, errorMessage(error, 'It could not be deleted.'));
    }
  }

  private async load(): Promise<void> {
    try {
      this.rows.set((await firstValueFrom(this.api.printers())).map((p) => ({ ...p })));
    } catch (error) {
      this.notify.error(error, 'The printers could not be loaded.');
    }
  }
}

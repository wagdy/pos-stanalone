import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../../core/http/error-message';
import { PosApi, Table, TableShape, Zone, newId } from '../../../core/pos/pos.api';
import { NotifyService } from '../../../core/ui/notify.service';
import { PosStore } from '../pos-store';

// The dining room (الصالة): its zones (Hall, Terrace…) and each zone's tables, with their seats,
// their shape and where they stand on the plan (a column of twelve and a row), as the floor plan and
// the captain's phone show them.
@Component({
  selector: 'app-tables-setup-page',
  imports: [FormsModule, MatButtonModule, MatCheckboxModule, MatIconModule],
  template: `
    <div class="toolbar">
      <h1>Tables <span class="inline-ar">الترابيزات</span></h1>
    </div>

    <section class="card">
      <h2>Zones · المناطق</h2>
      <div class="zones">
        @for (z of zoneRows(); track z.id) {
          <div class="zone-row" [class.on]="zone() === z.id">
            <button mat-icon-button (click)="picked.set(z.id)" [attr.aria-label]="'Show ' + z.name"><mat-icon>{{ zone() === z.id ? 'radio_button_checked' : 'radio_button_unchecked' }}</mat-icon></button>
            <input [(ngModel)]="z.name" aria-label="Zone name" />
            <input [(ngModel)]="z.nameAr" dir="rtl" aria-label="Arabic name" />
            <input class="n" type="number" [(ngModel)]="z.sortOrder" aria-label="Order" />
            <button mat-button (click)="saveZone(z)"><mat-icon>save</mat-icon> Save</button>
            <button mat-icon-button (click)="deleteZone(z)" aria-label="Delete the zone"><mat-icon>delete</mat-icon></button>
          </div>
        }
      </div>
      <button mat-stroked-button (click)="addZone()"><mat-icon>add</mat-icon> New zone · منطقة جديدة</button>
    </section>

    @if (zone()) {
      <div class="cols">
        <section class="card">
          <h2>Tables in {{ zoneName() }}</h2>
          <div class="table-wrap">
            <table class="grid">
              <thead><tr><th>Label</th><th class="num">Seats</th><th class="num">Column</th><th class="num">Row</th><th>Shape</th><th>In use</th><th></th></tr></thead>
              <tbody>
                @for (t of tableRows(); track t.id) {
                  <tr>
                    <td><input class="l" [(ngModel)]="t.label" aria-label="Label" /></td>
                    <td class="num"><input class="n" type="number" min="1" [(ngModel)]="t.seats" aria-label="Seats" /></td>
                    <td class="num"><input class="n" type="number" min="0" max="11" [(ngModel)]="t.x" aria-label="Column" /></td>
                    <td class="num"><input class="n" type="number" min="0" [(ngModel)]="t.y" aria-label="Row" /></td>
                    <td>
                      <select [(ngModel)]="t.shape" aria-label="Shape">
                        @for (s of shapes; track s) {
                          <option [ngValue]="s">{{ s }}</option>
                        }
                      </select>
                    </td>
                    <td><mat-checkbox [(ngModel)]="t.isActive" aria-label="In use" /></td>
                    <td>
                      <button mat-button (click)="saveTable(t)"><mat-icon>save</mat-icon></button>
                      <button mat-icon-button (click)="deleteTable(t)" aria-label="Delete the table"><mat-icon>delete</mat-icon></button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <button mat-stroked-button class="add" (click)="addTable()"><mat-icon>add</mat-icon> New table · ترابيزة جديدة</button>
        </section>
        <section class="card">
          <h2>Plan · المخطط</h2>
          <div class="plan">
            @for (t of tableRows(); track t.id) {
              <span class="t" [class.Round]="t.shape === 'Round'" [class.off]="!t.isActive"
                [style.grid-column]="(+t.x + 1) + ' / span ' + (t.shape === 'Long' ? 2 : 1)" [style.grid-row]="+t.y + 1">{{ t.label }}</span>
            }
          </div>
        </section>
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
    .card {
      margin-bottom: 14px;
      padding: 16px;
      border-radius: 16px;
      border: 1px solid var(--app-line);
      background: var(--mat-sys-surface-container-lowest);
    }
    input,
    select {
      height: 34px;
      padding: 0 8px;
      border: 1px solid var(--app-line-strong);
      border-radius: 8px;
      background: transparent;
      color: inherit;
      font: inherit;
    }
    input.n {
      width: 60px;
    }
    input.l {
      width: 80px;
    }
    .zones {
      display: grid;
      gap: 6px;
      margin-bottom: 10px;
    }
    .zone-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 4px;
      border-radius: 12px;

      &.on {
        background: var(--mat-sys-primary-container);
      }
    }
    .cols {
      display: grid;
      grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
      gap: 14px;
      align-items: start;
    }
    .add {
      margin-top: 10px;
    }
    .plan {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      grid-auto-rows: 44px;
      gap: 4px;
    }
    .t {
      display: grid;
      place-items: center;
      border: 2px solid var(--app-line-strong);
      border-radius: 8px;
      font-weight: 700;
      font-size: 12px;

      &.Round {
        border-radius: 999px;
      }
      &.off {
        opacity: 0.4;
        border-style: dashed;
      }
    }
    @media (max-width: 999.98px) {
      .cols {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  `,
})
export class TablesSetupPage implements OnInit {
  private readonly api = inject(PosApi);
  private readonly store = inject(PosStore);
  private readonly notify = inject(NotifyService);

  protected readonly shapes: TableShape[] = ['Square', 'Round', 'Long'];
  protected readonly zoneRows = signal<Zone[]>([]);
  protected readonly allTables = signal<Table[]>([]);
  protected readonly picked = signal<string | null>(null);
  protected readonly zone = computed(() => this.picked() ?? this.zoneRows()[0]?.id ?? null);
  protected readonly zoneName = computed(() => this.zoneRows().find((z) => z.id === this.zone())?.name ?? '');
  protected readonly tableRows = computed(() => this.allTables().filter((t) => t.zoneId === this.zone()));

  ngOnInit(): void {
    void this.reload();
  }

  protected addZone(): void {
    const zone: Zone = { id: newId(), name: '', nameAr: null, sortOrder: this.zoneRows().length + 1 };
    this.zoneRows.update((rows) => [...rows, zone]);
    this.picked.set(zone.id);
  }

  protected async saveZone(z: Zone): Promise<void> {
    await this.act(() => firstValueFrom(this.api.saveZone(z.id, { name: z.name, nameAr: z.nameAr || null, sortOrder: Number(z.sortOrder) })), `${z.name} saved.`);
  }

  protected async deleteZone(z: Zone): Promise<void> {
    if (confirm(`Delete ${z.name}? Only a zone without tables can go.`)) await this.act(() => firstValueFrom(this.api.deleteZone(z.id)), `${z.name} deleted.`);
  }

  protected addTable(): void {
    const zoneId = this.zone();
    if (!zoneId) return;
    const rows = this.tableRows();
    const n = rows.length;
    this.allTables.update((all) => [
      ...all,
      { id: newId(), zoneId, label: String(n + 1), seats: 4, x: (n * 2) % 12, y: Math.floor((n * 2) / 12), shape: 'Square', isActive: true, state: 'Available', checks: [] },
    ]);
  }

  protected async saveTable(t: Table): Promise<void> {
    await this.act(
      () =>
        firstValueFrom(
          this.api.saveTable(t.id, { zoneId: t.zoneId, label: String(t.label).trim(), seats: Number(t.seats), x: Number(t.x), y: Number(t.y), shape: t.shape, isActive: t.isActive }),
        ),
      `Table ${t.label} saved.`,
    );
  }

  protected async deleteTable(t: Table): Promise<void> {
    if (confirm(`Delete table ${t.label}?`)) await this.act(() => firstValueFrom(this.api.deleteTable(t.id)), `Table ${t.label} deleted.`);
  }

  private async act(work: () => Promise<unknown>, done: string): Promise<void> {
    try {
      await work();
      this.notify.info(done);
      await this.reload();
    } catch (error) {
      this.notify.error(error, errorMessage(error, 'It could not be saved.'));
    }
  }

  private async reload(): Promise<void> {
    try {
      const floor = await firstValueFrom(this.api.floor());
      this.zoneRows.set([...floor.zones].sort((a, b) => a.sortOrder - b.sortOrder).map((z) => ({ ...z })));
      this.allTables.set(floor.tables.map((t) => ({ ...t })));
      void this.store.loadFloor();
    } catch (error) {
      this.notify.error(error, 'The floor could not be loaded.');
    }
  }
}

import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../../core/http/error-message';
import { PosApi, Table, TableShape, Zone, newId } from '../../../core/pos/pos.api';
import { NotifyService } from '../../../core/ui/notify.service';
import { PosStore } from '../pos-store';

// The plan's columns: a table stands in one of twelve (a long one in two).
const PlanColumns = 12;

// The dining room (الصالة): its zones (Hall, Terrace…) and each zone's tables, with their seats,
// their shape and where they stand on the plan (a column of twelve and a row), as the floor plan and
// the captain's phone show them. A table is put in its place on the plan itself: dragged to a cell,
// or picked and a cell tapped; it is saved there at once. A place another table stands in is refused.
@Component({
  selector: 'app-tables-setup-page',
  imports: [FormsModule, MatButtonModule, MatCheckboxModule, MatIconModule, MatTooltipModule],
  template: `
    <div class="toolbar">
      <h1>Tables <span class="inline-ar">الترابيزات</span></h1>
    </div>

    <section class="card">
      <div class="card-head">
        <h2>Zones <span class="inline-ar">المناطق</span></h2>
        <button mat-stroked-button (click)="addZone()"><mat-icon>add</mat-icon> New zone · منطقة جديدة</button>
      </div>
      <div class="zones">
        @for (z of zoneRows(); track z.id) {
          <div class="zone-row" [class.on]="zone() === z.id">
            <button mat-icon-button class="pick" (click)="pickZone(z.id)" [attr.aria-label]="'Show ' + (z.name || 'the new zone')" [attr.aria-pressed]="zone() === z.id">
              <mat-icon>{{ zone() === z.id ? 'radio_button_checked' : 'radio_button_unchecked' }}</mat-icon>
            </button>
            <label class="field">
              <span class="field-label">Name · الاسم</span>
              <input [(ngModel)]="z.name" placeholder="Hall" />
            </label>
            <label class="field">
              <span class="field-label">Arabic name · الاسم بالعربي</span>
              <input [(ngModel)]="z.nameAr" dir="rtl" placeholder="الصالة" />
            </label>
            <label class="field small">
              <span class="field-label">Order · الترتيب</span>
              <input type="number" [(ngModel)]="z.sortOrder" />
            </label>
            <span class="row-acts">
              <button mat-stroked-button (click)="saveZone(z)"><mat-icon>save</mat-icon> Save · حفظ</button>
              <button mat-icon-button (click)="deleteZone(z)" aria-label="Delete the zone" matTooltip="Delete · حذف"><mat-icon>delete</mat-icon></button>
            </span>
          </div>
        } @empty {
          <p class="muted">No zones yet: add the hall first. · لا توجد مناطق.</p>
        }
      </div>
    </section>

    @if (zone()) {
      <section class="card">
        <div class="card-head">
          <h2>Plan <span class="inline-ar">المخطط</span> <span class="zone-name">{{ zoneName() }}</span></h2>
          <p class="hint">Drag a table to its place, or pick it and tap a cell: it is saved there. · اسحب الترابيزة لمكانها، أو اخترها ثم اضغط الخانة.</p>
        </div>
        <div class="plan" role="grid" aria-label="The zone's plan" [style.grid-template-rows]="'repeat(' + planRows() + ', var(--cell-h))'">
          @for (cell of cells(); track cell.key) {
            <button type="button" class="cell" [class.drop]="dropAt() === cell.key" [style.grid-column]="cell.x + 1" [style.grid-row]="cell.y + 1"
              [attr.data-pos]="cell.x + ',' + cell.y" (click)="place(cell.x, cell.y)" (dragover)="over($event, cell.key)"
              (dragleave)="dropAt.set(null)" (drop)="drop($event, cell.x, cell.y)"
              [attr.aria-label]="'Column ' + cell.x + ', row ' + cell.y"></button>
          }
          @for (t of tableRows(); track t.id) {
            <button type="button" class="t" [class.Round]="t.shape === 'Round'" [class.off]="!t.isActive" [class.on]="chosen() === t.id"
              [class.lifted]="dragging() === t.id" draggable="true" (dragstart)="drag($event, t)" (dragend)="dragging.set(null); dropAt.set(null)"
              (click)="choose(t)" [style.grid-column]="(+t.x + 1) + ' / span ' + span(t)" [style.grid-row]="+t.y + 1"
              [attr.aria-pressed]="chosen() === t.id" [attr.aria-label]="'Table ' + t.label + ': column ' + t.x + ', row ' + t.y">
              <strong>{{ t.label || '?' }}</strong>
              <small>{{ t.seats }} <mat-icon inline>chair</mat-icon></small>
            </button>
          }
        </div>
        <p class="placing" aria-live="polite">
          @if (chosenTable(); as t) {
            <mat-icon inline>touch_app</mat-icon> Table {{ t.label }} picked (column {{ t.x }}, row {{ t.y }}): tap a free cell to move it. · اضغط خانة فارغة لنقلها.
            <button mat-button (click)="chosen.set(null)">Done · تم</button>
          } @else {
            <span class="muted">Pick a table on the plan or in the list below. · اختر ترابيزة.</span>
          }
        </p>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Tables in {{ zoneName() }} <span class="inline-ar">ترابيزات المنطقة</span></h2>
          <button mat-stroked-button (click)="addTable()"><mat-icon>add</mat-icon> New table · ترابيزة جديدة</button>
        </div>
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>Label · الرقم</th><th class="num">Seats · الكراسي</th><th class="num">Column · العمود</th><th class="num">Row · الصف</th>
                <th>Shape · الشكل</th><th>In use · مستخدمة</th><th></th>
              </tr>
            </thead>
            <tbody>
              @for (t of tableRows(); track t.id) {
                <tr [class.on]="chosen() === t.id" (click)="chosen.set(t.id)">
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
                  <td class="acts">
                    <button mat-icon-button (click)="saveTable(t)" aria-label="Save the table" matTooltip="Save · حفظ"><mat-icon>save</mat-icon></button>
                    <button mat-icon-button (click)="deleteTable(t)" aria-label="Delete the table" matTooltip="Delete · حذف"><mat-icon>delete</mat-icon></button>
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="7" class="muted">No tables in this zone yet. · لا توجد ترابيزات.</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>
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
      margin: 0;
      font: var(--mat-sys-title-medium);
      font-weight: 650;
    }
    .muted {
      color: var(--mat-sys-on-surface-variant);
    }
    .card {
      margin-bottom: 14px;
      padding: 16px;
      border-radius: 16px;
      border: 1px solid var(--app-line);
      background: var(--mat-sys-surface-container-lowest);
      box-shadow: var(--app-card-shadow);
    }
    .card-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px 16px;
      margin-bottom: 12px;
    }
    .hint {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }
    .zone-name {
      margin-inline-start: 6px;
      padding: 2px 10px;
      border-radius: 999px;
      background: var(--app-indigo-50, #eef2ff);
      color: var(--app-indigo-700, #4338ca);
      font-size: 13px;
    }
    input,
    select {
      height: 36px;
      padding: 0 10px;
      box-sizing: border-box;
      border: 1px solid var(--app-line-strong);
      border-radius: 9px;
      background: var(--mat-sys-surface-container-lowest);
      color: inherit;
      font: inherit;

      &:focus {
        outline: 2px solid var(--app-indigo-500, #6366f1);
        outline-offset: -1px;
      }
    }
    input.n {
      width: 72px;
    }
    input.l {
      width: 96px;
    }

    // A zone on one line: each field with its name above it.
    .zones {
      display: grid;
      gap: 8px;
    }
    .zone-row {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 10px;
      padding: 8px 10px;
      border: 1px solid var(--app-line);
      border-radius: 12px;

      &.on {
        border-color: var(--app-indigo-200, #c7d2fe);
        background: var(--app-indigo-50, #eef2ff);
      }
      .pick {
        align-self: center;
      }
    }
    .field {
      display: grid;
      flex: 1 1 180px;
      gap: 4px;
      min-width: 0;

      &.small {
        flex: 0 0 96px;
      }
      input {
        width: 100%;
      }
    }
    .field-label {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-medium);
      white-space: nowrap;
    }
    .row-acts {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    // The plan: twelve columns of cells, each a place a table can stand; the tables over them.
    .plan {
      --cell-h: 76px;
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 6px;
      padding: 10px;
      border-radius: 14px;
      background-color: var(--mat-sys-surface-container-low);
      background-image: radial-gradient(circle, color-mix(in srgb, var(--mat-sys-on-surface) 12%, transparent) 1px, transparent 1.4px);
      background-size: 18px 18px;
    }
    .cell {
      position: relative;
      min-width: 0;
      padding: 0;
      border: 1px dashed color-mix(in srgb, var(--mat-sys-outline-variant) 80%, transparent);
      border-radius: 10px;
      background: transparent;
      cursor: pointer;
      transition:
        background-color 100ms ease,
        border-color 100ms ease;

      &::after {
        content: attr(data-pos);
        position: absolute;
        inset: auto 6px 4px auto;
        color: var(--mat-sys-on-surface-variant);
        font-size: 10px;
        opacity: 0;
      }
      &:hover,
      &.drop {
        border-style: solid;
        border-color: var(--app-indigo-500, #6366f1);
        background: color-mix(in srgb, var(--app-indigo-500, #6366f1) 10%, transparent);

        &::after {
          opacity: 1;
        }
      }
      &:focus-visible {
        outline: 2px solid var(--app-indigo-500, #6366f1);
      }
    }
    .t {
      z-index: 1;
      display: grid;
      place-items: center;
      align-content: center;
      gap: 0;
      min-width: 0;
      padding: 4px;
      border: 2px solid var(--app-slate-300, #cbd5e1);
      border-radius: 12px;
      background: var(--mat-sys-surface-container-lowest);
      color: var(--mat-sys-on-surface);
      font: inherit;
      cursor: grab;
      box-shadow: 0 1px 2px rgb(15 23 42 / 8%), 0 6px 14px -10px rgb(15 23 42 / 40%);
      transition:
        transform 100ms ease,
        box-shadow 120ms ease;

      strong {
        font-size: 18px;
        line-height: 1.1;
      }
      small {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        color: var(--mat-sys-on-surface-variant);
        font-size: 11px;
      }
      &.Round {
        justify-self: center;
        aspect-ratio: 1;
        height: 100%;
        border-radius: 50%;
      }
      &.on {
        border-color: var(--app-indigo-600, #4f46e5);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-indigo-500, #6366f1) 30%, transparent);
      }
      &.off {
        opacity: 0.45;
        border-style: dashed;
      }
      &.lifted {
        opacity: 0.5;
      }
      &:active {
        cursor: grabbing;
        transform: scale(0.97);
      }
      &:focus-visible {
        outline: 2px solid var(--app-indigo-500, #6366f1);
        outline-offset: 2px;
      }
    }
    .placing {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      min-height: 36px;
      margin: 10px 0 0;
      font: var(--mat-sys-body-medium);
    }
    tr.on > td {
      background: var(--app-indigo-50, #eef2ff) !important;
    }
    td.acts {
      white-space: nowrap;
    }
    @media (max-width: 699.98px) {
      .plan {
        --cell-h: 52px;
        gap: 4px;
        padding: 6px;
      }
      .t strong {
        font-size: 14px;
      }
      .t small {
        display: none;
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

  // The table picked to be moved on the plan, the one being dragged, and the cell under it.
  protected readonly chosen = signal<string | null>(null);
  protected readonly dragging = signal<string | null>(null);
  protected readonly dropAt = signal<string | null>(null);
  protected readonly chosenTable = computed(() => this.tableRows().find((t) => t.id === this.chosen()) ?? null);

  ngOnInit(): void {
    void this.reload();
  }

  // Rows shown on the plan: those the tables stand in, and two more to move them to (six at least).
  protected planRows(): number {
    return Math.max(6, ...this.tableRows().map((t) => Number(t.y) + 2));
  }

  protected cells(): { key: string; x: number; y: number }[] {
    const rows = this.planRows();
    return Array.from({ length: rows * PlanColumns }, (_, i) => {
      const x = i % PlanColumns;
      const y = Math.floor(i / PlanColumns);
      return { key: `${x}:${y}`, x, y };
    });
  }

  protected span(t: Table): number {
    return t.shape === 'Long' ? 2 : 1;
  }

  protected pickZone(id: string): void {
    this.picked.set(id);
    this.chosen.set(null);
  }

  protected choose(t: Table): void {
    this.chosen.set(this.chosen() === t.id ? null : t.id);
  }

  protected drag(event: DragEvent, t: Table): void {
    this.dragging.set(t.id);
    this.chosen.set(t.id);
    event.dataTransfer?.setData('text/plain', t.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  protected over(event: DragEvent, key: string): void {
    if (!this.dragging()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dropAt.set(key);
  }

  protected async drop(event: DragEvent, x: number, y: number): Promise<void> {
    event.preventDefault();
    const id = this.dragging() ?? event.dataTransfer?.getData('text/plain');
    this.dragging.set(null);
    this.dropAt.set(null);
    const table = this.tableRows().find((t) => t.id === id);
    if (table) await this.move(table, x, y);
  }

  // A cell tapped: the table picked goes there.
  protected async place(x: number, y: number): Promise<void> {
    const table = this.chosenTable();
    if (!table) {
      this.notify.info('Pick a table first, then tap where it goes. · اختر ترابيزة أولاً.');
      return;
    }
    await this.move(table, x, y);
  }

  // To column x, row y (a long table kept inside the twelve columns), unless another stands there.
  private async move(table: Table, x: number, y: number): Promise<void> {
    const width = this.span(table);
    const column = Math.min(x, PlanColumns - width);
    const taken = this.tableRows().find(
      (o) => o.id !== table.id && Number(o.y) === y && Number(o.x) < column + width && column < Number(o.x) + this.span(o),
    );
    if (taken) {
      this.notify.error(null, `Table ${taken.label} stands there: pick a free place. · المكان مشغول.`);
      return;
    }
    if (Number(table.x) === column && Number(table.y) === y) return;
    table.x = column;
    table.y = y;
    this.allTables.update((all) => [...all]);
    await this.act(() => firstValueFrom(this.api.saveTable(table.id, this.body(table))), `Table ${table.label} moved to column ${column}, row ${y}. · تم النقل.`);
    this.chosen.set(table.id);
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

  // A new table at the first free place on the plan, picked so it can be moved where it goes.
  protected addTable(): void {
    const zoneId = this.zone();
    if (!zoneId) return;
    const rows = this.tableRows();
    const taken = new Set(rows.flatMap((t) => Array.from({ length: this.span(t) }, (_, i) => `${Number(t.x) + i}:${Number(t.y)}`)));
    let spot = 0;
    while (taken.has(`${spot % PlanColumns}:${Math.floor(spot / PlanColumns)}`)) spot++;
    const id = newId();
    this.allTables.update((all) => [
      ...all,
      {
        id, zoneId, label: String(rows.length + 1), seats: 4, x: spot % PlanColumns, y: Math.floor(spot / PlanColumns), shape: 'Square', isActive: true,
        state: 'Available', checks: [],
      },
    ]);
    this.chosen.set(id);
  }

  protected async saveTable(t: Table): Promise<void> {
    await this.act(() => firstValueFrom(this.api.saveTable(t.id, this.body(t))), `Table ${t.label} saved.`);
  }

  private body(t: Table) {
    return { zoneId: t.zoneId, label: String(t.label).trim(), seats: Number(t.seats), x: Number(t.x), y: Number(t.y), shape: t.shape, isActive: t.isActive };
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

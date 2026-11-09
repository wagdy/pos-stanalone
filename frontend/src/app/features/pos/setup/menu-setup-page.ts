import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../../core/http/error-message';
import { Category, MenuItem, Option, PosApi, Printer, Station, newId } from '../../../core/pos/pos.api';
import { MoneyPipe } from '../../../core/ui/money.pipe';
import { NotifyService } from '../../../core/ui/notify.service';
import { PosStore } from '../pos-store';

type Tab = 'items' | 'categories' | 'stations';

// The menu (المنيو): its items (code, names, price, sizes, modifiers, the kitchen station that makes
// them), its categories (colour and order on the terminal), and the kitchen stations (Grill, Pizza,
// Bar, Cold), each printing its part of a ticket on its own printer. Every terminal hears a change.
@Component({
  selector: 'app-menu-setup-page',
  imports: [FormsModule, MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSelectModule, MoneyPipe],
  template: `
    <div class="toolbar">
      <h1>Menu <span class="inline-ar">المنيو</span></h1>
      <span class="spacer"></span>
      <div class="tabs" role="tablist">
        <button type="button" role="tab" class="chip" [class.on]="tab() === 'items'" (click)="tab.set('items')">Items · الأصناف <span>{{ items().length }}</span></button>
        <button type="button" role="tab" class="chip" [class.on]="tab() === 'categories'" (click)="tab.set('categories')">Categories · الأقسام</button>
        <button type="button" role="tab" class="chip" [class.on]="tab() === 'stations'" (click)="tab.set('stations')">Kitchen stations · المحطات</button>
      </div>
    </div>

    @switch (tab()) {
      @case ('items') {
        <div class="toolbar">
          <input type="search" placeholder="Find an item" [ngModel]="search()" (ngModelChange)="search.set($event)" aria-label="Find an item" />
          <span class="spacer"></span>
          <button mat-flat-button (click)="editItem(null)" [disabled]="!categories().length"><mat-icon>add</mat-icon> New item · صنف جديد</button>
        </div>
        <div class="table-wrap">
          <table class="grid">
            <thead><tr><th>Code</th><th>Item</th><th>Category</th><th>Station</th><th class="num">Price</th><th>Options</th><th></th></tr></thead>
            <tbody>
              @for (i of shownItems(); track i.id) {
                <tr class="clickable" [class.off]="!i.isActive" (click)="editItem(i)">
                  <td class="code">{{ i.code }}</td>
                  <td><strong>{{ i.name }}</strong> <span class="ar">{{ i.nameAr }}</span></td>
                  <td><span class="sw" [style.background]="categoryOf(i)?.color"></span>{{ categoryOf(i)?.name }}</td>
                  <td>{{ stationOf(i)?.name ?? '—' }}</td>
                  <td class="num">{{ i.price | money }}</td>
                  <td>{{ i.sizes.length ? i.sizes.length + ' sizes' : '' }}{{ i.sizes.length && i.modifiers.length ? ' · ' : '' }}{{ i.modifiers.length ? i.modifiers.length + ' modifiers' : '' }}</td>
                  <td>@if (!i.isActive) {<span class="tag faint">Off</span>}</td>
                </tr>
              } @empty {
                <tr><td colspan="7" class="muted">No items. Setup → POS settings loads a sample restaurant to start from.</td></tr>
              }
            </tbody>
          </table>
        </div>
      }
      @case ('categories') {
        <div class="table-wrap">
          <table class="grid">
            <thead><tr><th>Name</th><th>Arabic</th><th>Colour</th><th class="num">Order</th><th>On the menu</th><th></th></tr></thead>
            <tbody>
              @for (c of catRows(); track c.id) {
                <tr>
                  <td><input [(ngModel)]="c.name" aria-label="Category name" /></td>
                  <td><input [(ngModel)]="c.nameAr" dir="rtl" aria-label="Arabic name" /></td>
                  <td><input type="color" [(ngModel)]="c.color" aria-label="Colour" /></td>
                  <td class="num"><input class="n" type="number" [(ngModel)]="c.sortOrder" aria-label="Order" /></td>
                  <td><mat-checkbox [(ngModel)]="c.isActive" aria-label="On the menu" /></td>
                  <td><button mat-button (click)="saveCategory(c)"><mat-icon>save</mat-icon> Save</button></td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <button mat-stroked-button class="add" (click)="addCategory()"><mat-icon>add</mat-icon> New category · قسم جديد</button>
      }
      @case ('stations') {
        <p class="note">Each item is made at a station; Send to Kitchen prints each station's part on that station's printer (network or this browser) and shows it on the kitchen screen. <span class="note-ar">كل محطة تطبع جزءها على طابعتها</span></p>
        <div class="table-wrap">
          <table class="grid">
            <thead><tr><th>Station</th><th>Arabic</th><th class="num">Order</th><th>Printer</th><th></th></tr></thead>
            <tbody>
              @for (s of stationRows(); track s.id) {
                <tr>
                  <td><input [(ngModel)]="s.name" aria-label="Station name" /></td>
                  <td><input [(ngModel)]="s.nameAr" dir="rtl" aria-label="Arabic name" /></td>
                  <td class="num"><input class="n" type="number" [(ngModel)]="s.sortOrder" aria-label="Order" /></td>
                  <td>
                    <select [(ngModel)]="s.printerId" aria-label="Printer">
                      <option [ngValue]="null">No printer: kitchen screen only</option>
                      @for (p of printers(); track p.id) {
                        <option [ngValue]="p.id">{{ p.name }} ({{ p.connection === 'Network' ? p.host + ':' + p.port : 'browser' }})</option>
                      }
                    </select>
                  </td>
                  <td>
                    <button mat-button (click)="saveStation(s)"><mat-icon>save</mat-icon> Save</button>
                    <button mat-icon-button (click)="deleteStation(s)" aria-label="Delete the station"><mat-icon>delete</mat-icon></button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <button mat-stroked-button class="add" (click)="addStation()"><mat-icon>add</mat-icon> New station · محطة جديدة</button>
      }
    }
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
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .chip {
      height: 36px;
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
    input:not([type='color']):not([type='checkbox']),
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
      width: 64px;
    }
    .ar {
      display: inline;
    }
    .sw {
      display: inline-block;
      width: 10px;
      height: 10px;
      margin-right: 6px;
      border-radius: 3px;
    }
    tr.off {
      opacity: 0.55;
    }
    .add {
      margin-top: 10px;
    }
  `,
})
export class MenuSetupPage implements OnInit {
  private readonly api = inject(PosApi);
  private readonly store = inject(PosStore);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotifyService);

  protected readonly tab = signal<Tab>('items');
  protected readonly search = signal('');
  protected readonly printers = signal<Printer[]>([]);
  protected readonly catRows = signal<Category[]>([]);
  protected readonly stationRows = signal<Station[]>([]);

  protected readonly items = computed(() => [...(this.store.menu()?.items ?? [])].sort((a, b) => a.code - b.code));
  protected readonly categories = computed(() => [...(this.store.menu()?.categories ?? [])].sort((a, b) => a.sortOrder - b.sortOrder));
  protected readonly stations = computed(() => this.store.menu()?.stations ?? []);
  protected readonly shownItems = computed(() => {
    const text = this.search().trim().toLowerCase();
    return this.items().filter((i) => !text || i.name.toLowerCase().includes(text) || (i.nameAr ?? '').includes(text) || String(i.code).startsWith(text));
  });

  ngOnInit(): void {
    this.store.start();
    void this.reload();
  }

  protected categoryOf(item: MenuItem): Category | undefined {
    return this.categories().find((c) => c.id === item.categoryId);
  }

  protected stationOf(item: MenuItem): Station | undefined {
    return this.stations().find((s) => s.id === item.stationId);
  }

  protected async editItem(item: MenuItem | null): Promise<void> {
    const saved = await firstValueFrom(
      this.dialog
        .open<ItemEditDialog, ItemEditData, boolean>(ItemEditDialog, {
          data: { item, categories: this.categories(), stations: this.stations(), nextCode: Math.max(1000, ...this.items().map((i) => i.code)) + 1 },
          width: '720px',
          maxWidth: '96vw',
        })
        .afterClosed(),
    );
    if (saved) await this.reload();
  }

  protected addCategory(): void {
    this.catRows.update((rows) => [...rows, { id: newId(), name: '', nameAr: null, sortOrder: rows.length + 1, color: '#4f46e5', isActive: true }]);
  }

  protected async saveCategory(c: Category): Promise<void> {
    await this.act(() => firstValueFrom(this.api.saveCategory(c.id, { name: c.name, nameAr: c.nameAr || null, sortOrder: Number(c.sortOrder), color: c.color, isActive: c.isActive })), `${c.name} saved.`);
  }

  protected addStation(): void {
    this.stationRows.update((rows) => [...rows, { id: newId(), name: '', nameAr: null, sortOrder: rows.length + 1, printerId: null, printerName: null, printerConnection: null }]);
  }

  protected async saveStation(s: Station): Promise<void> {
    await this.act(() => firstValueFrom(this.api.saveStation(s.id, { name: s.name, nameAr: s.nameAr || null, sortOrder: Number(s.sortOrder), printerId: s.printerId })), `${s.name} saved.`);
  }

  protected async deleteStation(s: Station): Promise<void> {
    if (!confirm(`Delete the ${s.name} station? Its items go to no station.`)) return;
    await this.act(() => firstValueFrom(this.api.deleteStation(s.id)), `${s.name} deleted.`);
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
    await this.store.loadMenu();
    this.catRows.set(this.categories().map((c) => ({ ...c })));
    this.stationRows.set([...this.stations()].sort((a, b) => a.sortOrder - b.sortOrder).map((s) => ({ ...s })));
    try {
      this.printers.set(await firstValueFrom(this.api.printers()));
    } catch {
      // Kept.
    }
  }
}

// ---- An item: its code, names, price, category and station; its sizes and modifiers ----

export interface ItemEditData {
  item: MenuItem | null;
  categories: Category[];
  stations: Station[];
  nextCode: number;
}

@Component({
  selector: 'app-item-edit',
  imports: [FormsModule, MatButtonModule, MatCheckboxModule, MatDialogModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSelectModule],
  template: `
    <h2 mat-dialog-title>{{ data.item ? 'Edit ' + data.item.name : 'New item' }} <span class="inline-ar">صنف</span></h2>
    <mat-dialog-content>
      <div class="fields">
        <mat-form-field subscriptSizing="dynamic" class="code">
          <mat-label>Code</mat-label>
          <input matInput type="number" [(ngModel)]="item.code" required />
        </mat-form-field>
        <mat-form-field subscriptSizing="dynamic" class="grow">
          <mat-label>Name</mat-label>
          <input matInput [(ngModel)]="item.name" required maxlength="120" />
        </mat-form-field>
        <mat-form-field subscriptSizing="dynamic" class="grow">
          <mat-label>الاسم بالعربي</mat-label>
          <input matInput [(ngModel)]="item.nameAr" dir="rtl" maxlength="120" />
        </mat-form-field>
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>Price · السعر</mat-label>
          <input matInput type="number" min="0" step="any" [(ngModel)]="item.price" />
        </mat-form-field>
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>Category · القسم</mat-label>
          <mat-select [(ngModel)]="item.categoryId">
            @for (c of data.categories; track c.id) {
              <mat-option [value]="c.id">{{ c.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>Station · المحطة</mat-label>
          <mat-select [(ngModel)]="item.stationId">
            <mat-option [value]="null">None</mat-option>
            @for (s of data.stations; track s.id) {
              <mat-option [value]="s.id">{{ s.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-checkbox [(ngModel)]="item.isActive">On the menu</mat-checkbox>
      </div>

      @for (list of lists; track list.key) {
        <h3>{{ list.en }} <span class="inline-ar">{{ list.ar }}</span></h3>
        <table class="opts">
          <tbody>
            @for (o of item[list.key]; track o.id; let i = $index) {
              <tr>
                <td><input [(ngModel)]="o.name" placeholder="Name" [attr.aria-label]="list.en + ' name'" /></td>
                <td><input [(ngModel)]="o.nameAr" dir="rtl" placeholder="عربي" aria-label="Arabic" /></td>
                <td><input type="number" step="any" [(ngModel)]="o.price" [attr.aria-label]="list.key === 'sizes' ? 'Price' : 'Extra price'" /></td>
                <td><button mat-icon-button (click)="remove(list.key, i)" aria-label="Remove"><mat-icon>close</mat-icon></button></td>
              </tr>
            }
          </tbody>
        </table>
        <button mat-button (click)="add(list.key)"><mat-icon>add</mat-icon> {{ list.add }}</button>
      }
      @if (error()) {
        <p class="error">{{ error() }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button (click)="save()" [disabled]="busy()">Save · حفظ</button>
    </mat-dialog-actions>
  `,
  styles: `
    .inline-ar {
      direction: rtl;
      unicode-bidi: isolate;
      opacity: 0.75;
      margin-left: 6px;
    }
    .fields {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      padding-top: 6px;
    }
    .code {
      width: 110px;
    }
    .grow {
      flex: 1;
      min-width: 180px;
    }
    h3 {
      margin: 14px 0 4px;
      font: var(--mat-sys-title-small);
    }
    .opts input {
      width: 100%;
      height: 34px;
      padding: 0 8px;
      box-sizing: border-box;
      border: 1px solid var(--app-line-strong);
      border-radius: 8px;
      background: transparent;
      color: inherit;
      font: inherit;
    }
    .opts {
      width: 100%;
    }
    .error {
      color: var(--mat-sys-error);
    }
  `,
})
export class ItemEditDialog {
  protected readonly data = inject<ItemEditData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<ItemEditDialog, boolean>>(MatDialogRef);
  private readonly api = inject(PosApi);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly lists: { key: 'sizes' | 'modifiers'; en: string; ar: string; add: string }[] = [
    { key: 'sizes', en: 'Sizes (each its own price)', ar: 'الأحجام', add: 'Add a size' },
    { key: 'modifiers', en: 'Modifiers (extra price, 0 for free)', ar: 'الإضافات', add: 'Add a modifier' },
  ];

  protected readonly id = this.data.item?.id ?? newId();
  protected item: Omit<MenuItem, 'id'> = this.data.item
    ? { ...this.data.item, sizes: this.data.item.sizes.map((s) => ({ ...s })), modifiers: this.data.item.modifiers.map((m) => ({ ...m })) }
    : { code: this.data.nextCode, name: '', nameAr: null, categoryId: this.data.categories[0]?.id ?? '', stationId: null, price: 0, isActive: true, sizes: [], modifiers: [] };

  protected add(key: 'sizes' | 'modifiers'): void {
    const option: Option = { id: newId(), name: '', nameAr: null, price: 0 };
    this.item = { ...this.item, [key]: [...this.item[key], option] };
  }

  protected remove(key: 'sizes' | 'modifiers', index: number): void {
    this.item = { ...this.item, [key]: this.item[key].filter((_, i) => i !== index) };
  }

  protected async save(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const clean = (list: Option[]) => list.filter((o) => o.name.trim()).map((o) => ({ ...o, name: o.name.trim(), nameAr: o.nameAr?.trim() || null, price: Number(o.price) || 0 }));
      await firstValueFrom(
        this.api.saveItem(this.id, { ...this.item, code: Number(this.item.code), price: Number(this.item.price) || 0, nameAr: this.item.nameAr?.trim() || null, sizes: clean(this.item.sizes), modifiers: clean(this.item.modifiers) }),
      );
      this.ref.close(true);
    } catch (error) {
      this.error.set(errorMessage(error, 'The item could not be saved.'));
    } finally {
      this.busy.set(false);
    }
  }
}

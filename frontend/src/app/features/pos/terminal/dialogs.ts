import { Component, ElementRef, OnDestroy, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../../core/http/error-message';
import {
  Customer,
  Floor,
  MenuItem,
  NewPayment,
  Order,
  OrderLine,
  PaymentMethod,
  PosApi,
  StockOutcome,
  Table,
  newId,
  paymentLabels,
} from '../../../core/pos/pos.api';
import { MoneyPipe } from '../../../core/ui/money.pipe';

const round = (n: number) => Math.round(n * 100) / 100;

// ---- An item's options: its size, its modifiers, a note for the kitchen, how many ----

export interface ItemOptionsData {
  item: MenuItem;
  quickNotes: string[];
}

export interface ItemChoice {
  sizeId: string | null;
  modifierIds: string[];
  quantity: number;
  notes: string | null;
}

@Component({
  selector: 'app-item-options',
  imports: [FormsModule, MatButtonModule, MatButtonToggleModule, MatCheckboxModule, MatDialogModule, MatFormFieldModule, MatIconModule, MatInputModule, MoneyPipe],
  template: `
    <h2 mat-dialog-title>{{ data.item.name }} <span class="inline-ar">{{ data.item.nameAr }}</span></h2>
    <mat-dialog-content>
      @if (data.item.sizes.length) {
        <p class="label">Size · الحجم</p>
        <div class="choices" role="radiogroup" aria-label="Size">
          @for (s of data.item.sizes; track s.id) {
            <button type="button" class="choice" [class.on]="sizeId === s.id" (click)="sizeId = s.id" role="radio" [attr.aria-checked]="sizeId === s.id">
              <strong>{{ s.name }}</strong> <span class="ar">{{ s.nameAr }}</span><span class="price">{{ s.price | money }}</span>
            </button>
          }
        </div>
      }
      @if (data.item.modifiers.length) {
        <p class="label">Modifiers · الإضافات</p>
        <div class="choices">
          @for (m of data.item.modifiers; track m.id) {
            <button type="button" class="choice" [class.on]="modifiers.has(m.id)" (click)="toggle(m.id)" [attr.aria-pressed]="modifiers.has(m.id)">
              <strong>{{ m.name }}</strong> <span class="ar">{{ m.nameAr }}</span>
              <span class="price">{{ m.price ? '+' : '' }}{{ m.price ? (m.price | money) : 'Free' }}</span>
            </button>
          }
        </div>
      }
      <p class="label">Kitchen note · ملاحظة للمطبخ</p>
      <div class="chips">
        @for (n of data.quickNotes; track n) {
          <button type="button" class="chip" [class.on]="notes.includes(n)" (click)="addNote(n)">{{ n }}</button>
        }
      </div>
      <mat-form-field class="wide" subscriptSizing="dynamic">
        <mat-label>Note · ملاحظة</mat-label>
        <input matInput [(ngModel)]="notes" maxlength="200" aria-label="Kitchen note" />
      </mat-form-field>
      <div class="qty">
        <button mat-icon-button (click)="quantity = quantity > 1 ? quantity - 1 : 1" aria-label="One less"><mat-icon>remove</mat-icon></button>
        <strong aria-live="polite">{{ quantity }}</strong>
        <button mat-icon-button (click)="quantity = quantity + 1" aria-label="One more"><mat-icon>add</mat-icon></button>
        <span class="spacer"></span>
        <strong class="line-total">{{ total() | money }}</strong>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel · إلغاء</button>
      <button mat-flat-button (click)="done()" [disabled]="data.item.sizes.length > 0 && !sizeId"><mat-icon>add_shopping_cart</mat-icon> Add · إضافة</button>
    </mat-dialog-actions>
  `,
  styleUrl: './dialogs.scss',
})
export class ItemOptionsDialog {
  protected readonly data = inject<ItemOptionsData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<ItemOptionsDialog, ItemChoice>>(MatDialogRef);

  protected sizeId: string | null = this.data.item.sizes.length === 1 ? this.data.item.sizes[0].id : null;
  protected modifiers = new Set<string>();
  protected notes = '';
  protected quantity = 1;

  protected total(): number {
    const size = this.data.item.sizes.find((s) => s.id === this.sizeId);
    const extras = this.data.item.modifiers.filter((m) => this.modifiers.has(m.id)).reduce((n, m) => n + m.price, 0);
    return round(((size?.price ?? this.data.item.price) + extras) * this.quantity);
  }

  protected toggle(id: string): void {
    const next = new Set(this.modifiers);
    if (!next.delete(id)) next.add(id);
    this.modifiers = next;
  }

  protected addNote(note: string): void {
    this.notes = this.notes.includes(note) ? this.notes.replace(note, '').replace(/^,\s*|,\s*$/g, '').trim() : this.notes ? `${this.notes}, ${note}` : note;
  }

  protected done(): void {
    this.ref.close({ sizeId: this.sizeId, modifierIds: [...this.modifiers], quantity: this.quantity, notes: this.notes.trim() || null });
  }
}

// ---- A void: before the kitchen freely; after it, a manager's PIN, a reason and what became of it ----

export interface VoidData {
  line: OrderLine;
  reasons: string[];
  isManager: boolean;
}

export interface VoidChoice {
  quantity: number;
  reason: string | null;
  outcome: StockOutcome;
  managerPin: string | null;
}

@Component({
  selector: 'app-void-dialog',
  imports: [FormsModule, MatButtonModule, MatButtonToggleModule, MatDialogModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSelectModule, MoneyPipe],
  template: `
    <h2 mat-dialog-title [class.after]="after">
      <mat-icon>{{ after ? 'gpp_maybe' : 'remove_shopping_cart' }}</mat-icon>
      {{ after ? 'Void after kitchen' : 'Void before kitchen' }}
      <span class="inline-ar">{{ after ? 'إلغاء بعد الإرسال للمطبخ' : 'إلغاء قبل الإرسال' }}</span>
    </h2>
    <mat-dialog-content>
      <p class="what"><strong>{{ data.line.name }}</strong>{{ data.line.sizeName ? ' (' + data.line.sizeName + ')' : '' }} · {{ data.line.unitPrice | money }}
        @if (after) {
          <span class="tag bad">KOT {{ data.line.kitchenTicketNumber }} · {{ data.line.status === 'Prepared' ? 'prepared' : 'in the kitchen' }}</span>
        }
      </p>
      @if (data.line.quantity > 1) {
        <div class="qty">
          <span>How many · الكمية</span>
          <button mat-icon-button (click)="quantity = quantity > 1 ? quantity - 1 : 1" aria-label="One less"><mat-icon>remove</mat-icon></button>
          <strong>{{ quantity }}</strong>
          <button mat-icon-button (click)="quantity = quantity < data.line.quantity ? quantity + 1 : quantity" aria-label="One more"><mat-icon>add</mat-icon></button>
          <span class="muted">of {{ data.line.quantity }}</span>
        </div>
      }
      @if (after) {
        <p class="label">Reason · سبب الإلغاء</p>
        <div class="chips">
          @for (r of data.reasons; track r) {
            <button type="button" class="chip" [class.on]="reason === r" (click)="reason = r">{{ r }}</button>
          }
        </div>
        <mat-form-field class="wide" subscriptSizing="dynamic">
          <mat-label>Or say why · أو اكتب السبب</mat-label>
          <input matInput [(ngModel)]="reason" maxlength="200" aria-label="Void reason" />
        </mat-form-field>
        <p class="label">In the kitchen · حالة الصنف</p>
        <mat-button-toggle-group [(ngModel)]="outcome" aria-label="Already prepared or not" class="outcome">
          <mat-button-toggle value="Waste"><mat-icon>delete</mat-icon> Already prepared → waste<br /><span class="ar">تم تحضيره - يُسجل هالك</span></mat-button-toggle>
          <mat-button-toggle value="ReturnToStock"><mat-icon>inventory_2</mat-icon> Not prepared yet → back to stock<br /><span class="ar">لم يُحضر - يعود للمخزن</span></mat-button-toggle>
        </mat-button-toggle-group>
        @if (!data.isManager) {
          <mat-form-field class="pin" subscriptSizing="dynamic">
            <mat-label>Manager PIN · رقم المدير السري</mat-label>
            <input matInput type="password" inputmode="numeric" maxlength="4" autocomplete="off" [(ngModel)]="pin" aria-label="Manager PIN" />
            <mat-icon matSuffix>lock</mat-icon>
          </mat-form-field>
        }
        <p class="note-red"><mat-icon>print</mat-icon> A red VOID ticket goes to the kitchen so it stops making it. · يُرسل بون إلغاء للمطبخ.</p>
      } @else {
        <p class="muted">Not sent to the kitchen yet: it comes off the check, kept as a void before the kitchen for the audit. · لم يُرسل للمطبخ بعد.</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel · إلغاء</button>
      <button mat-flat-button class="danger-fill" (click)="done()" [disabled]="!ready()"><mat-icon>block</mat-icon> Void {{ quantity }} · إلغاء</button>
    </mat-dialog-actions>
  `,
  styleUrl: './dialogs.scss',
})
export class VoidDialog {
  protected readonly data = inject<VoidData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<VoidDialog, VoidChoice>>(MatDialogRef);

  protected readonly after = this.data.line.status !== 'Draft';
  protected quantity = this.data.line.quantity;
  protected reason = '';
  protected outcome: StockOutcome = this.data.line.status === 'Prepared' ? 'Waste' : 'ReturnToStock';
  protected pin = '';

  protected ready(): boolean {
    return !this.after || (this.reason.trim().length > 0 && (this.data.isManager || /^\d{4}$/.test(this.pin)));
  }

  protected done(): void {
    this.ref.close({
      quantity: this.quantity,
      reason: this.after ? this.reason.trim() : null,
      outcome: this.after ? this.outcome : 'None',
      managerPin: this.after && !this.data.isManager ? this.pin : null,
    });
  }
}

// ---- Paying: cash with its change, a card, a wallet, a staff meal; in parts, or a share each ----

export interface PayData {
  order: Order;
  // How it is to be paid when the dialog opens (Pay cash, Pay card); cash otherwise.
  method?: PaymentMethod;
}

export interface PayChoice {
  payments: NewPayment[];
  printReceipt: boolean;
}

@Component({
  selector: 'app-pay-dialog',
  imports: [FormsModule, MatButtonModule, MatCheckboxModule, MatDialogModule, MatFormFieldModule, MatIconModule, MatInputModule, MoneyPipe],
  template: `
    <h2 mat-dialog-title><mat-icon>point_of_sale</mat-icon> Pay check #{{ data.order.number }} <span class="inline-ar">الدفع</span></h2>
    <mat-dialog-content>
      <div class="due">
        <span>Due · المستحق</span><strong>{{ remaining() | money }}</strong>
        @if (data.order.splitWays; as ways) {
          <small>{{ ways }} guests · {{ share() | money }} each · لكل فرد</small>
        }
      </div>
      <div class="methods" role="radiogroup" aria-label="How it is paid">
        @for (m of methods; track m) {
          <button type="button" class="method" [class.on]="method === m" (click)="choose(m)" role="radio" [attr.aria-checked]="method === m">
            <mat-icon>{{ labels[m].icon }}</mat-icon> {{ labels[m].en }}<span class="ar">{{ labels[m].ar }}</span>
          </button>
        }
      </div>
      <div class="fields">
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>Amount · المبلغ</mat-label>
          <input matInput type="number" min="0" step="any" [(ngModel)]="amount" aria-label="Amount" />
        </mat-form-field>
        @if (method === 'Cash') {
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>Handed over · المدفوع</mat-label>
            <input matInput type="number" min="0" step="any" [(ngModel)]="tendered" aria-label="Cash handed over" />
          </mat-form-field>
        }
        @if (method === 'Card') {
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>Slip no. (optional) · رقم الإيصال</mat-label>
            <input matInput [(ngModel)]="reference" maxlength="40" aria-label="Card slip number" />
          </mat-form-field>
        }
        @if (method === 'StaffMeal') {
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>Employee · الموظف</mat-label>
            <input matInput [(ngModel)]="reference" maxlength="120" aria-label="Employee" />
          </mat-form-field>
        }
      </div>
      @if (method === 'Cash') {
        <div class="quick">
          <button mat-stroked-button (click)="tendered = amount">Exact · المبلغ</button>
          @for (note of [50, 100, 200, 500, 1000]; track note) {
            <button mat-stroked-button (click)="tendered = note">{{ note }}</button>
          }
        </div>
        @if ((tendered ?? 0) > (amount ?? 0)) {
          <p class="change">Change · الباقي <strong>{{ (tendered ?? 0) - (amount ?? 0) | money }}</strong></p>
        }
      }
      @if (data.order.splitWays) {
        <button mat-button (click)="amount = share()"><mat-icon>group</mat-icon> One guest's share · حصة فرد</button>
      }
      @if (taken().length) {
        <ul class="taken">
          @for (p of taken(); track p.paymentId) {
            <li><mat-icon>{{ labels[p.method].icon }}</mat-icon> {{ labels[p.method].en }} {{ p.amount | money }}
              <button mat-icon-button (click)="drop(p.paymentId)" aria-label="Take this payment off"><mat-icon>close</mat-icon></button></li>
          }
        </ul>
      }
      <mat-checkbox [(ngModel)]="printReceipt">Print the receipt · طباعة فاتورة الدفع</mat-checkbox>
      @if (problem(); as p) {
        <p class="error" role="alert">{{ p }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel · إلغاء</button>
      @if (remaining() - (amount ?? 0) > 0.004) {
        <button mat-stroked-button (click)="addPart()" [disabled]="!!problem()"><mat-icon>add</mat-icon> Add part · دفعة جزئية</button>
      }
      <button mat-flat-button (click)="done()" [disabled]="!!problem() && !taken().length"><mat-icon>check</mat-icon> Pay · دفع</button>
    </mat-dialog-actions>
  `,
  styleUrl: './dialogs.scss',
})
export class PayDialog {
  protected readonly data = inject<PayData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<PayDialog, PayChoice>>(MatDialogRef);
  protected readonly labels = paymentLabels;
  protected readonly methods: PaymentMethod[] = ['Cash', 'Card', 'Wallet', 'StaffMeal'];

  protected readonly taken = signal<NewPayment[]>([]);
  protected readonly remaining = computed(() => round(this.data.order.totals.due - this.taken().reduce((n, p) => n + p.amount, 0)));
  protected readonly share = computed(() => Math.ceil((this.data.order.totals.total / (this.data.order.splitWays ?? 1)) * 100) / 100);

  protected method: PaymentMethod = this.data.method ?? 'Cash';
  protected amount: number | null = this.data.order.totals.due;
  protected tendered: number | null = null;
  protected reference = '';
  protected printReceipt = true;

  protected problem(): string | null {
    const amount = Number(this.amount) || 0;
    if (amount <= 0) return 'Enter the amount. · أدخل المبلغ.';
    if (amount - this.remaining() > 0.004) return `No more than ${this.remaining().toFixed(2)} is due. · المبلغ أكبر من المستحق.`;
    if (this.method === 'Cash' && this.tendered != null && this.tendered < amount) return 'The cash handed over is less than the amount. · المدفوع أقل.';
    if (this.method === 'StaffMeal' && !this.reference.trim()) return 'Whose meal is it? · اسم الموظف.';
    return null;
  }

  protected choose(method: PaymentMethod): void {
    this.method = method;
    this.reference = '';
    this.tendered = null;
  }

  protected addPart(): void {
    if (this.problem()) return;
    this.taken.update((list) => [...list, this.current()]);
    this.amount = this.remaining();
    this.tendered = null;
    this.reference = '';
  }

  protected drop(id: string): void {
    this.taken.update((list) => list.filter((p) => p.paymentId !== id));
    this.amount = this.remaining();
  }

  protected done(): void {
    const payments = this.problem() ? this.taken() : [...this.taken(), this.current()];
    this.ref.close({ payments, printReceipt: this.printReceipt });
  }

  private current(): NewPayment {
    return {
      paymentId: newId(),
      method: this.method,
      amount: round(Number(this.amount) || 0),
      tendered: this.method === 'Cash' ? (this.tendered ?? null) : null,
      reference: this.reference.trim() || null,
    };
  }
}

// ---- Splitting a check: items onto a new check, or the total shared evenly ----

export interface SplitData {
  order: Order;
}

export type SplitChoice = { moves: { lineId: string; quantity: number }[] } | { ways: number };

@Component({
  selector: 'app-split-dialog',
  imports: [FormsModule, MatButtonModule, MatButtonToggleModule, MatDialogModule, MatFormFieldModule, MatIconModule, MatInputModule, MoneyPipe],
  template: `
    <h2 mat-dialog-title><mat-icon>call_split</mat-icon> Split check #{{ data.order.number }} <span class="inline-ar">فصل الشيك</span></h2>
    <mat-dialog-content>
      <mat-button-toggle-group [(ngModel)]="mode" aria-label="How to split" class="modes">
        <mat-button-toggle value="items"><mat-icon>list</mat-icon> By items · بالأصناف</mat-button-toggle>
        <mat-button-toggle value="even"><mat-icon>groups</mat-icon> Evenly · بالتساوي</mat-button-toggle>
      </mat-button-toggle-group>
      @if (mode === 'items') {
        <p class="muted">What moves to the new check ({{ nextLabel }}) · الأصناف المنقولة للشيك الجديد</p>
        <ul class="split-lines">
          @for (l of lines; track l.id) {
            <li>
              <span class="name">{{ l.name }}{{ l.sizeName ? ' (' + l.sizeName + ')' : '' }} <small class="muted">× {{ l.quantity }}</small></span>
              <button mat-icon-button (click)="move(l.id, -1)" [disabled]="!moves[l.id]" [attr.aria-label]="'One less of ' + l.name"><mat-icon>remove</mat-icon></button>
              <strong>{{ moves[l.id] || 0 }}</strong>
              <button mat-icon-button (click)="move(l.id, 1, l.quantity)" [disabled]="moves[l.id] === l.quantity" [attr.aria-label]="'One more of ' + l.name"><mat-icon>add</mat-icon></button>
            </li>
          }
        </ul>
        <p class="sum">Moving · المنقول <strong>{{ moving() | money }}</strong></p>
      } @else {
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>Guests sharing · عدد الأفراد</mat-label>
          <input matInput type="number" min="2" max="20" [(ngModel)]="ways" aria-label="Guests sharing" />
        </mat-form-field>
        <p class="sum">Each pays · لكل فرد <strong>{{ (data.order.totals.total / (ways || 1)) | money }}</strong></p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel · إلغاء</button>
      <button mat-flat-button (click)="done()" [disabled]="mode === 'items' ? !moving() : !(ways >= 2 && ways <= 20)"><mat-icon>call_split</mat-icon> Split · فصل</button>
    </mat-dialog-actions>
  `,
  styleUrl: './dialogs.scss',
})
export class SplitDialog {
  protected readonly data = inject<SplitData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<SplitDialog, SplitChoice>>(MatDialogRef);
  protected readonly lines = this.data.order.lines.filter((l) => l.quantity > 0);
  protected readonly nextLabel = this.data.order.checkLabel ? String.fromCharCode(this.data.order.checkLabel.charCodeAt(0) + 1) : 'B';
  protected mode: 'items' | 'even' = 'items';
  protected moves: Record<string, number> = {};
  protected ways = 2;

  protected move(id: string, by: number, max = 999): void {
    this.moves = { ...this.moves, [id]: Math.min(max, Math.max(0, (this.moves[id] ?? 0) + by)) };
  }

  protected moving(): number {
    return round(this.lines.reduce((n, l) => n + (this.moves[l.id] ?? 0) * l.unitPrice, 0));
  }

  protected done(): void {
    this.ref.close(
      this.mode === 'items'
        ? { moves: Object.entries(this.moves).filter(([, q]) => q > 0).map(([lineId, quantity]) => ({ lineId, quantity })) }
        : { ways: this.ways },
    );
  }
}

// ---- A table chosen: to open a check on, to move a table to, or to merge into ----

export interface TablePickData {
  floor: Floor;
  mode: 'open' | 'transfer' | 'merge';
  fromTableId?: string | null;
}

export interface TablePick {
  table: Table;
  guests: number;
}

@Component({
  selector: 'app-table-pick',
  imports: [FormsModule, MatButtonModule, MatDialogModule, MatFormFieldModule, MatIconModule, MatInputModule, MoneyPipe],
  template: `
    <h2 mat-dialog-title>
      <mat-icon>{{ data.mode === 'open' ? 'table_restaurant' : data.mode === 'transfer' ? 'move_up' : 'merge' }}</mat-icon>
      {{ title.en }} <span class="inline-ar">{{ title.ar }}</span>
    </h2>
    <mat-dialog-content>
      @for (zone of data.floor.zones; track zone.id) {
        <p class="label">{{ zone.name }} <span class="inline-ar">{{ zone.nameAr }}</span></p>
        <div class="tables">
          @for (t of tablesOf(zone.id); track t.id) {
            <button type="button" class="table" [class]="t.state" [class.on]="chosen()?.id === t.id" [disabled]="!allowed(t)" (click)="chosen.set(t)"
              [attr.aria-label]="'Table ' + t.label + ', ' + t.state">
              <strong>{{ t.label }}</strong>
              <small>{{ t.state === 'Available' ? t.seats + ' seats' : (t.checks[0]?.total ?? 0 | money) }}</small>
            </button>
          }
        </div>
      }
      @if (data.mode === 'open') {
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>Guests · عدد الأفراد</mat-label>
          <input matInput type="number" min="1" max="99" [(ngModel)]="guests" aria-label="Guests" />
        </mat-form-field>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel · إلغاء</button>
      <button mat-flat-button [disabled]="!chosen()" (click)="done()"><mat-icon>check</mat-icon> {{ data.mode === 'open' ? 'Open · فتح' : data.mode === 'transfer' ? 'Move · نقل' : 'Merge · دمج' }}</button>
    </mat-dialog-actions>
  `,
  styleUrl: './dialogs.scss',
})
export class TablePickDialog {
  protected readonly data = inject<TablePickData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<TablePickDialog, TablePick>>(MatDialogRef);
  protected readonly chosen = signal<Table | null>(null);
  protected guests = 2;
  protected readonly title = {
    open: { en: 'Open a table', ar: 'فتح ترابيزة' },
    transfer: { en: 'Move to table', ar: 'نقل ترابيزة' },
    merge: { en: 'Merge into table', ar: 'دمج ترابيزات' },
  }[this.data.mode];

  protected tablesOf(zoneId: string): Table[] {
    return this.data.floor.tables.filter((t) => t.zoneId === zoneId && t.isActive);
  }

  protected allowed(t: Table): boolean {
    if (t.id === this.data.fromTableId) return false;
    return this.data.mode === 'merge' ? t.state !== 'Available' : this.data.mode === 'transfer' ? t.state === 'Available' : true;
  }

  protected done(): void {
    this.ref.close({ table: this.chosen()!, guests: Math.max(1, Number(this.guests) || 1) });
  }
}

// ---- The bill's discount: an amount or a share; past the cashier's limit, a manager's PIN ----

export interface DiscountData {
  order: Order;
  limitPercent: number;
  isManager: boolean;
}

export interface DiscountChoice {
  amount: number | null;
  percent: number | null;
  reason: string | null;
  managerPin: string | null;
}

@Component({
  selector: 'app-discount-dialog',
  imports: [FormsModule, MatButtonModule, MatButtonToggleModule, MatDialogModule, MatFormFieldModule, MatIconModule, MatInputModule, MoneyPipe],
  template: `
    <h2 mat-dialog-title><mat-icon>sell</mat-icon> Discount · خصم</h2>
    <mat-dialog-content>
      <mat-button-toggle-group [(ngModel)]="by" aria-label="Discount by" class="modes">
        <mat-button-toggle value="percent">% · نسبة</mat-button-toggle>
        <mat-button-toggle value="amount">Amount · مبلغ</mat-button-toggle>
      </mat-button-toggle-group>
      <div class="fields">
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>{{ by === 'percent' ? 'Percent · النسبة' : 'Amount · المبلغ' }}</mat-label>
          <input matInput type="number" min="0" step="any" [(ngModel)]="value" aria-label="Discount" />
        </mat-form-field>
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>Reason · السبب</mat-label>
          <input matInput [(ngModel)]="reason" maxlength="200" aria-label="Reason" />
        </mat-form-field>
      </div>
      <p class="sum">Takes off · يخصم <strong>{{ off() | money }}</strong></p>
      @if (needsManager()) {
        <mat-form-field class="pin" subscriptSizing="dynamic">
          <mat-label>Manager PIN (over {{ data.limitPercent }}%) · رقم المدير</mat-label>
          <input matInput type="password" inputmode="numeric" maxlength="4" autocomplete="off" [(ngModel)]="pin" aria-label="Manager PIN" />
        </mat-form-field>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="clear()">No discount · بدون خصم</button>
      <button mat-button mat-dialog-close>Cancel · إلغاء</button>
      <button mat-flat-button (click)="done()" [disabled]="!value || !reason.trim() || (needsManager() && !(pin.length === 4))">Apply · تطبيق</button>
    </mat-dialog-actions>
  `,
  styleUrl: './dialogs.scss',
})
export class DiscountDialog {
  protected readonly data = inject<DiscountData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<DiscountDialog, DiscountChoice>>(MatDialogRef);
  protected by: 'percent' | 'amount' = 'percent';
  protected value: number | null = null;
  protected reason = this.data.order.discountReason ?? '';
  protected pin = '';
  private readonly basis = this.data.order.totals.gross - this.data.order.totals.lineDiscounts;

  protected off(): number {
    const v = Number(this.value) || 0;
    return round(this.by === 'percent' ? (this.basis * v) / 100 : v);
  }

  protected needsManager(): boolean {
    return !this.data.isManager && this.basis > 0 && (this.off() * 100) / this.basis > this.data.limitPercent;
  }

  protected clear(): void {
    this.ref.close({ amount: 0, percent: null, reason: null, managerPin: null });
  }

  protected done(): void {
    this.ref.close({
      amount: this.by === 'amount' ? Number(this.value) : null,
      percent: this.by === 'percent' ? Number(this.value) : null,
      reason: this.reason.trim(),
      managerPin: this.needsManager() ? this.pin : null,
    });
  }
}

// ---- The customer & loyalty bar's search: by phone, name or card (QR), or a new one ----

@Component({
  selector: 'app-customer-dialog',
  imports: [FormsModule, MatButtonModule, MatDialogModule, MatFormFieldModule, MatIconModule, MatInputModule, MatProgressBarModule],
  template: `
    <h2 mat-dialog-title><mat-icon>loyalty</mat-icon> Customer &amp; loyalty <span class="inline-ar">تسجيل عميل / نقاط الولاء</span></h2>
    <mat-dialog-content>
      <div class="fields">
        <mat-form-field subscriptSizing="dynamic" class="grow">
          <mat-label>Phone, name or card code · الهاتف أو الاسم أو الكارت</mat-label>
          <input #search matInput [(ngModel)]="text" (keyup.enter)="find()" (ngModelChange)="typed()" aria-label="Find a customer" autocomplete="off" />
          <mat-icon matSuffix>search</mat-icon>
        </mat-form-field>
        @if (canScan) {
          <button mat-stroked-button (click)="scan()" [disabled]="scanning()"><mat-icon>qr_code_scanner</mat-icon> Scan card · مسح الكارت</button>
        }
      </div>
      @if (scanning()) {
        <video #video class="scanner" autoplay playsinline muted></video>
      }
      @if (busy()) {
        <mat-progress-bar mode="indeterminate" />
      }
      <ul class="customers">
        @for (c of found(); track c.id) {
          <li>
            <button type="button" (click)="pick(c)">
              <strong>{{ c.name }}</strong> <span class="muted">{{ c.phone }}</span>
              <span class="points"><mat-icon>stars</mat-icon> {{ c.points }} pts{{ c.tier ? ' · ' + c.tier : '' }}</span>
              @if (c.linked) {
                <span class="tag ok">Loyalty card · كارت ولاء</span>
              }
            </button>
          </li>
        } @empty {
          @if (searched()) {
            <li class="muted">No customer found · لا يوجد عميل</li>
          }
        }
      </ul>
      <p class="label">New customer · عميل جديد</p>
      <div class="fields">
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>Name · الاسم</mat-label>
          <input matInput [(ngModel)]="name" maxlength="120" aria-label="New customer name" />
        </mat-form-field>
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>Phone · الهاتف</mat-label>
          <input matInput [(ngModel)]="phone" inputmode="tel" maxlength="20" aria-label="New customer phone" />
        </mat-form-field>
        <button mat-flat-button (click)="register()" [disabled]="!name.trim() || phone.replace(digitsOnly, '').length < 7 || busy()"><mat-icon>person_add</mat-icon> Register · تسجيل</button>
      </div>
      @if (problem(); as p) {
        <p class="error" role="alert">{{ p }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Close · إغلاق</button>
    </mat-dialog-actions>
  `,
  styleUrl: './dialogs.scss',
})
export class CustomerDialog implements OnDestroy {
  private readonly api = inject(PosApi);
  private readonly ref = inject<MatDialogRef<CustomerDialog, Customer>>(MatDialogRef);
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  protected readonly digitsOnly = /\D/g;
  protected readonly found = signal<Customer[]>([]);
  protected readonly busy = signal(false);
  protected readonly searched = signal(false);
  protected readonly scanning = signal(false);
  protected readonly problem = signal<string | null>(null);
  // A camera and the browser's own QR reader: a loyalty card's code scanned.
  protected readonly canScan = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices;
  protected text = '';
  protected name = '';
  protected phone = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stream: MediaStream | null = null;

  protected typed(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.find(), 350);
  }

  protected async find(): Promise<void> {
    const text = this.text.trim();
    if (text.length < 2) {
      this.found.set([]);
      return;
    }
    this.busy.set(true);
    this.problem.set(null);
    try {
      // A card's code: no spaces, letters and digits mixed or long digits.
      if (/^[\w-]{16,}$/.test(text)) {
        this.found.set([await firstValueFrom(this.api.customerByCard(text))]);
      } else {
        this.found.set(await firstValueFrom(this.api.searchCustomers(text)));
        if (/^\d{10,}$/.test(text) && !this.phone) this.phone = text;
      }
      this.searched.set(true);
    } catch (error) {
      this.problem.set(errorMessage(error, 'The customer could not be found.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected pick(customer: Customer): void {
    this.ref.close(customer);
  }

  protected async register(): Promise<void> {
    this.busy.set(true);
    this.problem.set(null);
    try {
      this.ref.close(await firstValueFrom(this.api.registerCustomer(newId(), this.name.trim(), this.phone.trim())));
    } catch (error) {
      this.problem.set(errorMessage(error, 'The customer could not be registered.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected async scan(): Promise<void> {
    this.scanning.set(true);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      await new Promise((r) => setTimeout(r, 50));
      const video = this.video()?.nativeElement;
      if (!video) return;
      video.srcObject = this.stream;
      const detector = new (window as unknown as { BarcodeDetector: new (o: object) => { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> } }).BarcodeDetector({ formats: ['qr_code'] });
      for (let i = 0; i < 300 && this.scanning(); i++) {
        const codes = await detector.detect(video).catch(() => []);
        if (codes.length) {
          this.text = codes[0].rawValue;
          this.stopScan();
          const customer = await firstValueFrom(this.api.customerByCard(this.text)).catch((e) => {
            this.problem.set(errorMessage(e, 'This card is not known here.'));
            return null;
          });
          if (customer) this.ref.close(customer);
          return;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch {
      this.problem.set('The camera could not be opened. · تعذر فتح الكاميرا.');
    } finally {
      this.stopScan();
    }
  }

  ngOnDestroy(): void {
    this.stopScan();
  }

  private stopScan(): void {
    this.scanning.set(false);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

// ---- A table opened: how many sit at it ----

export interface GuestsData {
  tableLabel: string;
  seats: number;
}

@Component({
  selector: 'app-guests-dialog',
  imports: [MatButtonModule, MatDialogModule, MatIconModule],
  template: `
    <h2 mat-dialog-title><mat-icon>groups</mat-icon> Table {{ data.tableLabel }} <span class="inline-ar">عدد الأفراد</span></h2>
    <mat-dialog-content>
      <p class="label">How many guests? · كم فرد؟</p>
      <div class="choices guests">
        @for (n of counts; track n) {
          <button type="button" class="choice" [class.on]="n === guests()" (click)="pick(n)"><strong>{{ n }}</strong></button>
        }
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button (click)="pick(guests())"><mat-icon>check</mat-icon> Open table · فتح</button>
    </mat-dialog-actions>
  `,
  styleUrl: './dialogs.scss',
})
export class GuestsDialog {
  protected readonly data = inject<GuestsData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<GuestsDialog, number>>(MatDialogRef);
  protected readonly counts = Array.from({ length: Math.max(8, Math.min(16, this.data.seats + 4)) }, (_, i) => i + 1);
  protected readonly guests = signal(Math.min(2, this.data.seats || 2));

  protected pick(n: number): void {
    this.ref.close(n);
  }
}

import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

// The till's API, as its screens use it: the menu and floor, the checks and their kitchen tickets,
// customers, the shift, printers, settings and the linked systems. Ids of what is made are made
// here, so a request sent again (the network lost the answer) changes nothing the second time.

export type OrderType = 'DineIn' | 'Takeaway' | 'Delivery';
export type OrderStatus = 'Open' | 'BillPrinted' | 'Paid' | 'Cancelled' | 'Merged';
export type LineStatus = 'Draft' | 'Sent' | 'Prepared' | 'Voided';
export type VoidKind = 'BeforeKitchen' | 'AfterKitchen';
export type StockOutcome = 'None' | 'Waste' | 'ReturnToStock';
export type PaymentMethod = 'Cash' | 'Card' | 'Wallet' | 'StaffMeal';
export type TicketKind = 'New' | 'AddOn' | 'Void' | 'Transfer';
export type TableState = 'Available' | 'Occupied' | 'BillRequested';
export type TableShape = 'Square' | 'Round' | 'Long';
export type PrinterConnection = 'Browser' | 'Network';
export type PrinterRole = 'Cashier' | 'Kitchen';
export type PrintDocumentKind = 'Bill' | 'Receipt' | 'KitchenTicket' | 'ZReport' | 'Test';
export type PaidOutKind = 'Expense' | 'StaffAdvance' | 'Driver';
export type LinkedSystem = 'Costing' | 'Loyalty' | 'Hr';
export type SyncStatus = 'Pending' | 'Sent' | 'Failed';

export const orderTypeLabels: Record<OrderType, { en: string; ar: string; icon: string }> = {
  DineIn: { en: 'Dine-in', ar: 'صالة', icon: 'table_restaurant' },
  Takeaway: { en: 'Takeaway', ar: 'تيك أواي', icon: 'takeout_dining' },
  Delivery: { en: 'Delivery', ar: 'توصيل', icon: 'delivery_dining' },
};

export const lineStatusLabels: Record<LineStatus, { en: string; ar: string }> = {
  Draft: { en: 'Not sent', ar: 'لم يُرسل' },
  Sent: { en: 'Sent to kitchen', ar: 'أُرسل للمطبخ' },
  Prepared: { en: 'Prepared', ar: 'جاهز' },
  Voided: { en: 'Voided', ar: 'ملغي' },
};

export const paymentLabels: Record<PaymentMethod, { en: string; ar: string; icon: string }> = {
  Cash: { en: 'Cash', ar: 'كاش', icon: 'payments' },
  Card: { en: 'Visa / card', ar: 'فيزا', icon: 'credit_card' },
  Wallet: { en: 'Wallet', ar: 'محفظة', icon: 'account_balance_wallet' },
  StaffMeal: { en: 'Staff meal', ar: 'وجبة عاملين', icon: 'badge' },
};

export const ticketKindLabels: Record<TicketKind, { en: string; ar: string }> = {
  New: { en: 'New', ar: 'جديد' },
  AddOn: { en: 'Add-on', ar: 'إضافي' },
  Void: { en: 'Void', ar: 'إلغاء' },
  Transfer: { en: 'Moved', ar: 'نقل' },
};

export interface Option {
  id: string;
  name: string;
  nameAr: string | null;
  price: number;
}

export interface Station {
  id: string;
  name: string;
  nameAr: string | null;
  sortOrder: number;
  printerId: string | null;
  printerName: string | null;
  printerConnection: PrinterConnection | null;
}

export interface Category {
  id: string;
  name: string;
  nameAr: string | null;
  sortOrder: number;
  color: string | null;
  isActive: boolean;
}

export interface MenuItem {
  id: string;
  code: number;
  name: string;
  nameAr: string | null;
  categoryId: string;
  stationId: string | null;
  price: number;
  isActive: boolean;
  sizes: Option[];
  modifiers: Option[];
}

export interface Menu {
  categories: Category[];
  items: MenuItem[];
  stations: Station[];
  quickNotes: string[];
  voidReasons: string[];
  taxPercent: number;
  servicePercent: number;
  redemptionValuePer100Points: number;
  cashierDiscountLimitPercent: number;
  // No network printer for the cashier: the terminal's browser prints the checks and receipts.
  cashierPrintsInBrowser: boolean;
  // Points earned per unit of money paid, for a receipt printed while the server cannot be reached.
  pointsPerCurrencyUnit: number;
}

export interface TableCheck {
  orderId: string;
  number: number;
  checkLabel: string | null;
  status: OrderStatus;
  total: number;
  guests: number;
  openedBy: string;
  openedAtUtc: string;
  hasDrafts: boolean;
}

export interface Table {
  id: string;
  zoneId: string;
  label: string;
  seats: number;
  x: number;
  y: number;
  shape: TableShape;
  isActive: boolean;
  state: TableState;
  checks: TableCheck[];
}

export interface Zone {
  id: string;
  name: string;
  nameAr: string | null;
  sortOrder: number;
}

export interface Floor {
  zones: Zone[];
  tables: Table[];
}

export interface OrderLine {
  id: string;
  menuItemId: string;
  code: number;
  name: string;
  nameAr: string | null;
  sizeName: string | null;
  sizeNameAr: string | null;
  modifiers: string;
  modifiersAr: string | null;
  notes: string | null;
  unitPrice: number;
  quantity: number;
  discount: number;
  total: number;
  status: LineStatus;
  stationId: string | null;
  stationName: string | null;
  kitchenTicketNumber: number | null;
  sentAtUtc: string | null;
  preparedAtUtc: string | null;
  addedBy: string;
  addedAtUtc: string;
}

export interface VoidEntry {
  id: string;
  lineId: string;
  code: number;
  itemName: string;
  quantity: number;
  amount: number;
  kind: VoidKind;
  reason: string | null;
  outcome: StockOutcome;
  authorizedBy: string | null;
  voidedBy: string;
  atUtc: string;
  kitchenTicketNumber: number | null;
}

export interface Payment {
  id: string;
  method: PaymentMethod;
  amount: number;
  tendered: number | null;
  change: number;
  reference: string | null;
  by: string;
  atUtc: string;
}

export interface Totals {
  gross: number;
  lineDiscounts: number;
  billDiscount: number;
  redemption: number;
  net: number;
  service: number;
  tax: number;
  total: number;
  paid: number;
  due: number;
}

export interface OrderCustomer {
  id: string | null;
  name: string | null;
  phone: string | null;
  loyaltyUserId: string | null;
  points: number | null;
  tier: string | null;
}

export interface TicketSummary {
  id: string;
  number: number;
  kind: TicketKind;
  createdAtUtc: string;
  createdBy: string;
  isDone: boolean;
}

export interface Order {
  id: string;
  number: number;
  businessDate: string;
  type: OrderType;
  status: OrderStatus;
  tableId: string | null;
  tableLabel: string | null;
  checkLabel: string | null;
  guests: number;
  splitFromId: string | null;
  mergedIntoId: string | null;
  splitWays: number | null;
  openedBy: string;
  openedAtUtc: string;
  notes: string | null;
  customer: OrderCustomer | null;
  deliveryAddress: string | null;
  driverName: string | null;
  servicePercent: number;
  taxPercent: number;
  discountAmount: number;
  discountReason: string | null;
  pointsRedeemed: number;
  pointsEarned: number;
  billPrints: number;
  billPrintedAtUtc: string | null;
  paidAtUtc: string | null;
  settledBy: string | null;
  shiftId: string | null;
  totals: Totals;
  lines: OrderLine[];
  voids: VoidEntry[];
  payments: Payment[];
  tickets: TicketSummary[];
}

export interface OrderSummary {
  id: string;
  number: number;
  type: OrderType;
  status: OrderStatus;
  tableLabel: string | null;
  checkLabel: string | null;
  guests: number;
  openedBy: string;
  openedAtUtc: string;
  customerName: string | null;
  total: number;
  due: number;
  items: number;
  hasDrafts: boolean;
  paidAtUtc: string | null;
}

export interface TicketLine {
  id: string;
  orderLineId: string;
  stationId: string | null;
  stationName: string | null;
  code: number;
  name: string;
  nameAr: string | null;
  sizeName: string | null;
  modifiers: string;
  notes: string | null;
  quantity: number;
  doneAtUtc: string | null;
}

export interface Ticket {
  id: string;
  number: number;
  kind: TicketKind;
  orderId: string;
  orderNumber: number;
  orderType: OrderType;
  tableLabel: string | null;
  checkLabel: string | null;
  guests: number;
  createdBy: string;
  createdAtUtc: string;
  note: string | null;
  isDone: boolean;
  lines: TicketLine[];
}

export interface KitchenBoard {
  active: Ticket[];
  recentlyDone: Ticket[];
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  loyaltyUserId: string | null;
  points: number;
  tier: string | null;
  pointsUpdatedAtUtc: string | null;
  linked: boolean;
}

export interface PaidOut {
  id: string;
  kind: PaidOutKind;
  amount: number;
  reason: string;
  staffName: string | null;
  by: string;
  atUtc: string;
}

export interface Shift {
  id: string;
  number: number;
  businessDate: string;
  status: 'Open' | 'Closed';
  openingFloat: number;
  openedBy: string;
  openedAtUtc: string;
  closedBy: string | null;
  closedAtUtc: string | null;
  countedCash: number | null;
  paidOuts: PaidOut[];
}

export interface ZReport {
  shiftId: string;
  number: number;
  businessDate: string;
  openedBy: string;
  openedAtUtc: string;
  closedBy: string | null;
  closedAtUtc: string | null;
  isClosed: boolean;
  openingFloat: number;
  checks: number;
  guests: number;
  grossSales: number;
  discounts: number;
  redemptions: number;
  netSales: number;
  service: number;
  tax: number;
  totalSales: number;
  cashSales: number;
  cardSales: number;
  walletSales: number;
  staffMeals: number;
  byType: { type: OrderType; checks: number; total: number }[];
  paidOuts: number;
  paidOutLines: PaidOut[];
  voidBeforeCount: number;
  voidBeforeAmount: number;
  voidAfterCount: number;
  voidAfterAmount: number;
  voidAfterReasons: { reason: string; count: number; amount: number }[];
  voidAfterItems: { code: number; name: string; quantity: number; amount: number; outcome: StockOutcome; reason: string | null }[];
  drivers: { driver: string; orders: number; cash: number; total: number }[];
  expectedCash: number;
  countedCash: number | null;
  variance: number | null;
  openChecks: number;
  soldItems: { code: number; name: string; quantity: number; amount: number }[];
}

export interface Printer {
  id: string;
  name: string;
  connection: PrinterConnection;
  role: PrinterRole;
  host: string | null;
  port: number;
  charactersPerLine: number;
  isActive: boolean;
  stations: string[];
}

export interface PosSettings {
  taxPercent: number;
  servicePercent: number;
  receiptHeader: string | null;
  receiptFooter: string | null;
  taxNumber: string | null;
  pointsPerCurrencyUnit: number;
  redemptionValuePer100Points: number;
  cashierDiscountLimitPercent: number;
  voidReasons: string[];
  quickNotes: string[];
  updatedBy: string | null;
  updatedAtUtc: string | null;
}

export interface Link {
  system: LinkedSystem;
  enabled: boolean;
  baseUrl: string | null;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  branchCode: string | null;
  lastTestedAtUtc: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  pending: number;
  failed: number;
  updatedBy: string | null;
  updatedAtUtc: string | null;
}

export interface SyncItem {
  id: string;
  system: LinkedSystem;
  kind: string;
  summary: string;
  status: SyncStatus;
  attempts: number;
  lastError: string | null;
  createdAtUtc: string;
  nextAttemptAtUtc: string;
  sentAtUtc: string | null;
}

export interface SyncState {
  pending: number;
  failed: number;
  anyLinked: boolean;
  lastSendFailed: boolean;
  lastSentAtUtc: string | null;
}

// What the terminals are asked to print when the printer has no network address.
export interface BrowserPrintJob {
  id: string;
  kind: PrintDocumentKind;
  subjectId: string;
  printerId: string | null;
  printerName: string | null;
  stationId: string | null;
}

export interface NewLine {
  lineId: string;
  menuItemId: string;
  sizeId: string | null;
  modifierIds: string[];
  quantity: number;
  notes: string | null;
}

export interface NewPayment {
  paymentId: string;
  method: PaymentMethod;
  amount: number;
  tendered: number | null;
  reference: string | null;
}

@Injectable({ providedIn: 'root' })
export class PosApi {
  private readonly http = inject(HttpClient);

  menu(): Observable<Menu> {
    return this.http.get<Menu>('/api/menu');
  }

  floor(): Observable<Floor> {
    return this.http.get<Floor>('/api/floor');
  }

  openOrders(): Observable<OrderSummary[]> {
    return this.http.get<OrderSummary[]>('/api/orders/open');
  }

  // Every open check whole: the terminal's copy for when the server cannot be reached.
  openOrdersFull(): Observable<Order[]> {
    return this.http.get<Order[]>('/api/orders/open/full');
  }

  dayOrders(date: string): Observable<OrderSummary[]> {
    return this.http.get<OrderSummary[]>('/api/orders', { params: { date } });
  }

  order(id: string): Observable<Order> {
    return this.http.get<Order>(`/api/orders/${id}`);
  }

  open(body: { orderId: string; type: OrderType; tableId: string | null; guests: number; customerName?: string | null; customerPhone?: string | null }): Observable<Order> {
    return this.http.post<Order>('/api/orders', body);
  }

  addItems(orderId: string, items: NewLine[], sendToKitchen = false): Observable<Order> {
    return this.http.post<Order>(`/api/orders/${orderId}/items`, { items, sendToKitchen });
  }

  changeLine(orderId: string, lineId: string, quantity: number, notes: string | null): Observable<Order> {
    return this.http.put<Order>(`/api/orders/${orderId}/lines/${lineId}`, { quantity, notes });
  }

  send(orderId: string): Observable<Order> {
    return this.http.post<Order>(`/api/orders/${orderId}/send`, {});
  }

  void(orderId: string, body: { items: { voidId: string; lineId: string; quantity: number }[]; reason: string | null; outcome: StockOutcome; managerPin: string | null }): Observable<Order> {
    return this.http.post<Order>(`/api/orders/${orderId}/voids`, body);
  }

  printBill(orderId: string, print = true): Observable<Order> {
    return this.http.post<Order>(`/api/orders/${orderId}/bill`, { print });
  }

  update(orderId: string, body: { guests: number | null; notes: string | null; deliveryAddress: string | null; driverName: string | null; customerName: string | null; customerPhone: string | null }): Observable<Order> {
    return this.http.put<Order>(`/api/orders/${orderId}`, body);
  }

  cancel(orderId: string, reason: string | null): Observable<Order> {
    return this.http.post<Order>(`/api/orders/${orderId}/cancel`, { reason });
  }

  transfer(fromTableId: string, toTableId: string): Observable<Order[]> {
    return this.http.post<Order[]>(`/api/tables/${fromTableId}/transfer`, { toTableId });
  }

  merge(targetOrderId: string, sourceOrderId: string): Observable<Order> {
    return this.http.post<Order>(`/api/orders/${targetOrderId}/merge`, { sourceOrderId });
  }

  split(orderId: string, newOrderId: string, moves: { lineId: string; quantity: number }[]): Observable<{ source: Order; created: Order }> {
    return this.http.post<{ source: Order; created: Order }>(`/api/orders/${orderId}/split`, { newOrderId, moves });
  }

  splitEvenly(orderId: string, ways: number): Observable<Order> {
    return this.http.post<Order>(`/api/orders/${orderId}/split-evenly`, { ways });
  }

  discount(orderId: string, body: { amount: number | null; percent: number | null; reason: string | null; managerPin: string | null }): Observable<Order> {
    return this.http.post<Order>(`/api/orders/${orderId}/discount`, body);
  }

  attachCustomer(orderId: string, customerId: string | null): Observable<Order> {
    return this.http.put<Order>(`/api/orders/${orderId}/customer`, { customerId });
  }

  redeem(orderId: string, points: number): Observable<Order> {
    return this.http.post<Order>(`/api/orders/${orderId}/redeem`, { points });
  }

  pay(orderId: string, payments: NewPayment[], printReceipt: boolean): Observable<Order> {
    return this.http.post<Order>(`/api/orders/${orderId}/pay`, { payments, printReceipt });
  }

  kitchen(stationId: string | null): Observable<KitchenBoard> {
    return this.http.get<KitchenBoard>('/api/kitchen', { params: stationId ? { stationId } : {} });
  }

  ticket(id: string): Observable<Ticket> {
    return this.http.get<Ticket>(`/api/kitchen/tickets/${id}`);
  }

  bump(ticketId: string, stationId: string | null, allStations: boolean): Observable<Ticket> {
    return this.http.post<Ticket>(`/api/kitchen/tickets/${ticketId}/bump`, { stationId, allStations });
  }

  recall(ticketId: string, stationId: string | null): Observable<Ticket> {
    return this.http.post<Ticket>(`/api/kitchen/tickets/${ticketId}/recall`, { stationId });
  }

  searchCustomers(search: string): Observable<Customer[]> {
    return this.http.get<Customer[]>('/api/customers', { params: { search } });
  }

  customerByCard(code: string): Observable<Customer> {
    return this.http.get<Customer>(`/api/customers/card/${encodeURIComponent(code)}`);
  }

  registerCustomer(id: string, name: string, phone: string): Observable<Customer> {
    return this.http.post<Customer>('/api/customers', { id, name, phone });
  }

  currentShift(): Observable<Shift | null> {
    return this.http.get<Shift | null>('/api/shifts/current');
  }

  shifts(): Observable<Shift[]> {
    return this.http.get<Shift[]>('/api/shifts');
  }

  shiftReport(shiftId: string): Observable<ZReport> {
    return this.http.get<ZReport>(`/api/shifts/${shiftId}/report`);
  }

  openShift(shiftId: string, openingFloat: number): Observable<Shift> {
    return this.http.post<Shift>('/api/shifts', { shiftId, openingFloat });
  }

  payOut(body: { paidOutId: string; kind: PaidOutKind; amount: number; reason: string; staffName: string | null }): Observable<Shift> {
    return this.http.post<Shift>('/api/shifts/paid-outs', body);
  }

  closeShift(shiftId: string, countedCash: number, print: boolean): Observable<ZReport> {
    return this.http.post<ZReport>(`/api/shifts/${shiftId}/close`, { countedCash, print });
  }

  clock(pin: string | null): Observable<{ name: string; clockedIn: boolean; atUtc: string }> {
    return this.http.post<{ name: string; clockedIn: boolean; atUtc: string }>('/api/clock', { pin });
  }

  print(kind: PrintDocumentKind, subjectId: string, printerId: string | null = null): Observable<void> {
    return this.http.post<void>('/api/print', { kind, subjectId, printerId });
  }

  printers(): Observable<Printer[]> {
    return this.http.get<Printer[]>('/api/setup/printers');
  }

  savePrinter(id: string, body: Omit<Printer, 'id' | 'stations'>): Observable<void> {
    return this.http.put<void>(`/api/setup/printers/${id}`, body);
  }

  deletePrinter(id: string): Observable<void> {
    return this.http.delete<void>(`/api/setup/printers/${id}`);
  }

  saveStation(id: string, body: { name: string; nameAr: string | null; sortOrder: number; printerId: string | null }): Observable<Station> {
    return this.http.put<Station>(`/api/menu/stations/${id}`, body);
  }

  deleteStation(id: string): Observable<void> {
    return this.http.delete<void>(`/api/menu/stations/${id}`);
  }

  saveCategory(id: string, body: Omit<Category, 'id'>): Observable<Category> {
    return this.http.put<Category>(`/api/menu/categories/${id}`, body);
  }

  saveItem(id: string, body: Omit<MenuItem, 'id'>): Observable<MenuItem> {
    return this.http.put<MenuItem>(`/api/menu/items/${id}`, body);
  }

  saveZone(id: string, body: Omit<Zone, 'id'>): Observable<Zone> {
    return this.http.put<Zone>(`/api/floor/zones/${id}`, body);
  }

  deleteZone(id: string): Observable<void> {
    return this.http.delete<void>(`/api/floor/zones/${id}`);
  }

  saveTable(id: string, body: { zoneId: string; label: string; seats: number; x: number; y: number; shape: TableShape; isActive: boolean }): Observable<void> {
    return this.http.put<void>(`/api/floor/tables/${id}`, body);
  }

  deleteTable(id: string): Observable<void> {
    return this.http.delete<void>(`/api/floor/tables/${id}`);
  }

  settings(): Observable<PosSettings> {
    return this.http.get<PosSettings>('/api/setup/pos-settings');
  }

  saveSettings(body: Omit<PosSettings, 'updatedBy' | 'updatedAtUtc'>): Observable<PosSettings> {
    return this.http.put<PosSettings>('/api/setup/pos-settings', body);
  }

  loadSample(): Observable<void> {
    return this.http.post<void>('/api/setup/sample', {});
  }

  links(): Observable<Link[]> {
    return this.http.get<Link[]>('/api/integrations/links');
  }

  saveLink(system: LinkedSystem, body: { enabled: boolean; baseUrl: string | null; apiKey: string | null; branchCode: string | null }): Observable<Link> {
    return this.http.put<Link>(`/api/integrations/links/${system}`, body);
  }

  testLink(system: LinkedSystem): Observable<Link> {
    return this.http.post<Link>(`/api/integrations/links/${system}/test`, {});
  }

  syncState(): Observable<SyncState> {
    return this.http.get<SyncState>('/api/integrations/sync');
  }

  syncQueue(): Observable<SyncItem[]> {
    return this.http.get<SyncItem[]>('/api/integrations/sync/queue');
  }

  syncNow(retryFailed: boolean, itemId: string | null = null): Observable<SyncState> {
    return this.http.post<SyncState>('/api/integrations/sync/now', { retryFailed, itemId });
  }

  costingSheet(date: string): Observable<Blob> {
    return this.http.get('/api/integrations/costing/sheet', { params: { date }, responseType: 'blob' });
  }

  syncHrStaff(): Observable<{ received: number; added: number; updated: number; skipped: number }> {
    return this.http.post<{ received: number; added: number; updated: number; skipped: number }>('/api/integrations/hr/staff', {});
  }
}

export function newId(): string {
  return crypto.randomUUID();
}

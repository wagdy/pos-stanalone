import { Floor, Menu, MenuItem, Order, OrderLine, Table, Ticket, TicketLine, ZReport } from '../app/core/pos/pos.api';

// The till's data as the API returns it: a small menu (a grill and a bar), a hall of tables, a
// check, a kitchen ticket and a Z report, each changed where a spec needs it.

export function anItem(overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    id: 'item-burger', code: 6101, name: 'Beef burger', nameAr: 'برجر لحم', categoryId: 'cat-grill', stationId: 'st-grill', price: 180, isActive: true,
    sizes: [], modifiers: [], ...overrides,
  };
}

export function aMenu(overrides: Partial<Menu> = {}): Menu {
  return {
    categories: [
      { id: 'cat-grill', name: 'Grill', nameAr: 'مشويات', sortOrder: 1, color: '#dc2626', isActive: true },
      { id: 'cat-drinks', name: 'Drinks', nameAr: 'مشروبات', sortOrder: 2, color: '#2563eb', isActive: true },
    ],
    items: [
      anItem(),
      anItem({ id: 'item-cola', code: 8001, name: 'Cola', nameAr: 'كولا', categoryId: 'cat-drinks', stationId: 'st-bar', price: 35 }),
      anItem({
        id: 'item-juice', code: 8002, name: 'Orange juice', nameAr: 'عصير برتقال', categoryId: 'cat-drinks', stationId: 'st-bar', price: 45,
        sizes: [{ id: 'sz-s', name: 'Small', nameAr: 'صغير', price: 45 }, { id: 'sz-l', name: 'Large', nameAr: 'كبير', price: 60 }],
      }),
    ],
    stations: [
      { id: 'st-grill', name: 'Grill', nameAr: 'الشواية', sortOrder: 1, printerId: null, printerName: null, printerConnection: null },
      { id: 'st-bar', name: 'Bar', nameAr: 'البار', sortOrder: 2, printerId: null, printerName: null, printerConnection: null },
    ],
    quickNotes: ['بدون بصل', 'تسوية زيادة'],
    voidReasons: ['Customer changed mind', 'Captain error'],
    taxPercent: 14,
    servicePercent: 12,
    redemptionValuePer100Points: 10,
    cashierDiscountLimitPercent: 10,
    cashierPrintsInBrowser: true,
    ...overrides,
  };
}

export function aTable(overrides: Partial<Table> = {}): Table {
  return { id: 'table-1', zoneId: 'zone-hall', label: '1', seats: 4, x: 0, y: 0, shape: 'Square', isActive: true, state: 'Available', checks: [], ...overrides };
}

export function aFloor(tables: Table[] = [aTable()]): Floor {
  return {
    zones: [
      { id: 'zone-hall', name: 'Hall', nameAr: 'الصالة', sortOrder: 1 },
      { id: 'zone-terrace', name: 'Terrace', nameAr: 'التراس', sortOrder: 2 },
    ],
    tables,
  };
}

export function aLine(overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    id: 'line-1', menuItemId: 'item-burger', code: 6101, name: 'Beef burger', nameAr: 'برجر لحم', sizeName: null, sizeNameAr: null, modifiers: '', modifiersAr: null,
    notes: null, unitPrice: 180, quantity: 2, discount: 0, total: 360, status: 'Draft', stationId: 'st-grill', stationName: 'Grill', kitchenTicketNumber: null,
    sentAtUtc: null, preparedAtUtc: null, addedBy: 'Mona', addedAtUtc: '2026-11-09T12:00:00Z', ...overrides,
  };
}

export function anOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1', number: 12, businessDate: '2026-11-09', type: 'DineIn', status: 'Open', tableId: 'table-1', tableLabel: '1', checkLabel: null, guests: 2,
    splitFromId: null, mergedIntoId: null, splitWays: null, openedBy: 'Karim', openedAtUtc: '2026-11-09T12:00:00Z', notes: null, customer: null,
    deliveryAddress: null, driverName: null, servicePercent: 12, taxPercent: 14, discountAmount: 0, discountReason: null, pointsRedeemed: 0, pointsEarned: 0,
    billPrints: 0, billPrintedAtUtc: null, paidAtUtc: null, settledBy: null, shiftId: null,
    totals: { gross: 360, lineDiscounts: 0, billDiscount: 0, redemption: 0, net: 360, service: 43.2, tax: 56.45, total: 459.65, paid: 0, due: 459.65 },
    lines: [aLine()], voids: [], payments: [], tickets: [], ...overrides,
  };
}

export function aTicketLine(overrides: Partial<TicketLine> = {}): TicketLine {
  return {
    id: 'tl-1', orderLineId: 'line-1', stationId: 'st-grill', stationName: 'Grill', code: 6101, name: 'Beef burger', nameAr: 'برجر لحم', sizeName: null,
    modifiers: '', notes: null, quantity: 2, doneAtUtc: null, ...overrides,
  };
}

export function aTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'ticket-1', number: 7, kind: 'New', orderId: 'order-1', orderNumber: 12, orderType: 'DineIn', tableLabel: '1', checkLabel: null, guests: 2,
    createdBy: 'Karim', createdAtUtc: new Date().toISOString(), note: null, isDone: false, lines: [aTicketLine()], ...overrides,
  };
}

export function aZReport(overrides: Partial<ZReport> = {}): ZReport {
  return {
    shiftId: 'shift-1', number: 3, businessDate: '2026-11-09', openedBy: 'Mona', openedAtUtc: '2026-11-09T08:00:00Z', closedBy: 'Mona',
    closedAtUtc: '2026-11-09T23:00:00Z', isClosed: true, openingFloat: 500, checks: 2, guests: 5, grossSales: 900, discounts: 50, redemptions: 10, netSales: 840,
    service: 40, tax: 123.2, totalSales: 1003.2, cashSales: 703.2, cardSales: 300, walletSales: 0, staffMeals: 0,
    byType: [{ type: 'DineIn', checks: 2, total: 1003.2 }], paidOuts: 100, paidOutLines: [], voidBeforeCount: 1, voidBeforeAmount: 35, voidAfterCount: 1,
    voidAfterAmount: 180, voidAfterReasons: [{ reason: 'Quality', count: 1, amount: 180 }], voidAfterItems: [], drivers: [], expectedCash: 1103.2,
    countedCash: 1100, variance: -3.2, openChecks: 0, soldItems: [], ...overrides,
  };
}

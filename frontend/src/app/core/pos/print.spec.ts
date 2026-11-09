import { TestBed } from '@angular/core/testing';
import { aCompany } from '../../../testing/fixtures';
import { aLine, aTicket, aTicketLine, aZReport, anOrder } from '../../../testing/pos-fixtures';
import { Company } from '../settings/company';
import { PosSettings } from './pos.api';
import { checkHtml, ticketHtml, zReportHtml } from './print';

const local = (utc: string) => `local ${utc.slice(11, 16)}`;
// The words as printed: each run of text apart, as the paper lays them out.
const text = (html: string) => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? '');
  return parts.join(' ').replace(/\s+/g, ' ').trim();
};

const settings = { receiptHeader: '12 Nile St\n0100 000 0000', receiptFooter: 'Thank you · شكراً', taxNumber: '123-456' } as PosSettings;

describe('the 80 mm documents', () => {
  let company: Company;

  beforeEach(() => {
    company = TestBed.inject(Company);
    company.settings.set(aCompany({ name: 'Otantik' }));
  });

  it('prints the guest’s check in both languages, its service and VAT, and a QR code at its foot', () => {
    const html = checkHtml(
      anOrder({ customer: { id: 'c', name: 'Sara', phone: '0100', loyaltyUserId: null, points: 120, tier: 'Gold' }, settledBy: 'Mona' }),
      false,
      company,
      settings,
      local,
    );
    const words = text(html);

    expect(html).toContain('size: 80mm auto');
    expect(words).toContain('CHECK · شيك الحساب');
    expect(words).toContain('12 Nile St');
    expect(words).toContain('Tax no. · الرقم الضريبي 123-456');
    expect(words).toContain('Dine-in · صالة — Table 1 · 2 guests');
    expect(words).toContain('Captain · الكابتن: Karim Cashier · الكاشير: Mona');
    expect(words).toContain('Customer · العميل: Sara 0100 · 120 pts');
    expect(words).toContain('Beef burger برجر لحم 2 L.E 180.00 L.E 360.00');
    expect(words).toContain('Service 12% خدمة L.E 43.20');
    expect(words).toContain('VAT 14% ضريبة القيمة المضافة L.E 56.45');
    expect(words).toContain('TOTAL · الإجمالي L.E 459.65');
    expect(words).toContain('Thank you · شكراً');
    expect(html).toContain('<svg');
  });

  it('prints the paid receipt with what was paid, the change and the points earned', () => {
    const order = anOrder({
      status: 'Paid',
      pointsEarned: 45,
      payments: [{ id: 'p', method: 'Cash', amount: 459.65, tendered: 500, change: 40.35, reference: null, by: 'Mona', atUtc: '2026-11-09T13:00:00Z' }],
    });
    const words = text(checkHtml(order, true, company, null, local));

    expect(words).toContain('RECEIPT · فاتورة الدفع');
    expect(words).toContain('Cash كاش L.E 459.65');
    expect(words).toContain('Change الباقي L.E 40.35');
    expect(words).toContain('+45 loyalty points');
  });

  it('escapes what people typed', () => {
    const html = checkHtml(anOrder({ lines: [aLine({ name: '<b>Burger</b>' })] }), false, company, null, local);
    expect(html).toContain('&lt;b&gt;Burger&lt;/b&gt;');
    expect(html).not.toContain('<b>Burger</b>');
  });

  it('prints a kitchen ticket by station, its notes loud, and an add-on or a void as a banner', () => {
    const ticket = aTicket({
      kind: 'AddOn',
      lines: [
        aTicketLine({ notes: 'بدون بصل', modifiers: 'Extra cheese' }),
        aTicketLine({ id: 'tl-2', stationId: 'st-bar', stationName: 'Bar', name: 'Cola', nameAr: 'كولا', quantity: 1 }),
      ],
    });
    const words = text(ticketHtml(ticket, null, local));

    expect(words).toContain('ADD-ON · إضافي');
    expect(words).toContain('KOT 7');
    expect(words).toContain('TABLE 1');
    expect(words).toContain('Grill 2 × Beef burger برجر لحم + Extra cheese ** بدون بصل ** Bar 1 × Cola كولا');

    const bar = text(ticketHtml(ticket, 'st-bar', local));
    expect(bar).not.toContain('Beef burger');

    expect(text(ticketHtml(aTicket({ kind: 'Void' }), null, local))).toContain('✕ VOID · إلغاء ✕');
  });

  it('prints the Z report: tax apart from net sales, voids before and after with their reasons, and the cash variance', () => {
    const words = text(zReportHtml(aZReport(), company, local));

    expect(words).toContain('Z REPORT · تقرير Z');
    expect(words).toContain('Net sales (before tax) صافي المبيعات L.E 840.00');
    expect(words).toContain('Tax collected الضريبة المحصلة L.E 123.20');
    expect(words).toContain('Cash كاش L.E 703.20');
    expect(words).toContain('Visa / card فيزا L.E 300.00');
    expect(words).toContain('Void before kitchen (1) إلغاء قبل المطبخ L.E 35.00');
    expect(words).toContain('Void after kitchen (1) إلغاء بعد المطبخ L.E 180.00');
    expect(words).toContain('Quality (1) L.E 180.00');
    expect(words).toContain('Expected cash النقدية المتوقعة L.E 1,103.20');
    expect(words).toContain('Variance الفرق L.E -3.20');
  });
});

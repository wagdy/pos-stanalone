import { Injectable, inject, signal } from '@angular/core';
import qrcode from 'qrcode-generator';
import { firstValueFrom } from 'rxjs';
import { Company } from '../settings/company';
import { LiveService } from './live.service';
import { OfflineStore } from './offline';
import { BrowserPrintJob, Order, PosApi, PosSettings, PrintDocumentKind, Ticket, ZReport, orderTypeLabels, paymentLabels } from './pos.api';

// The till's documents at 80 mm, as the browser prints them: the guest's check before paying and
// the paid receipt (bilingual, the logo at the top, a QR code at the foot), a kitchen ticket in big
// type with its ADD-ON or VOID banner, and a shift's Z report. A network thermal printer gets the
// same documents from the server as ESC/POS; these are for the browser's own printer, and for
// previews on screen.

const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const Styles = `
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; }
  body { width: 80mm; margin: 0; padding: 4mm 4mm 8mm; font: 12px/1.35 'Inter', 'Segoe UI', Tahoma, Arial, sans-serif; color: #000; }
  .c { text-align: center; }
  .r { text-align: right; }
  .ar { direction: rtl; unicode-bidi: isolate; }
  .logo { max-width: 40mm; max-height: 20mm; display: block; margin: 0 auto 2mm; }
  h1 { font-size: 17px; margin: 0; }
  h2 { font-size: 15px; margin: 2mm 0 1mm; letter-spacing: 0.06em; }
  .muted { color: #333; font-size: 11px; }
  hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
  table { width: 100%; border-collapse: collapse; }
  th { font-size: 10.5px; text-align: left; border-bottom: 1px solid #000; padding: 1mm 0; }
  td { vertical-align: top; padding: 0.8mm 0; }
  td.n, th.n { text-align: right; white-space: nowrap; padding-left: 2mm; }
  .item-ar { font-size: 11px; }
  .mods { font-size: 10.5px; padding-left: 3mm; }
  .pair { display: flex; justify-content: space-between; gap: 3mm; }
  .total { font-size: 18px; font-weight: 800; border-top: 2px solid #000; border-bottom: 2px solid #000; padding: 1.5mm 0; margin: 1.5mm 0; }
  .qr { display: flex; justify-content: center; margin-top: 2mm; }
  .qr svg { width: 26mm; height: 26mm; }
  .banner { background: #000; color: #fff; font-size: 20px; font-weight: 900; text-align: center; padding: 2mm; margin-bottom: 2mm; letter-spacing: 0.08em; }
  .kot-title { font-size: 22px; font-weight: 900; }
  .kot-table { font-size: 26px; font-weight: 900; }
  .kot-line { font-size: 19px; font-weight: 800; margin-top: 2mm; }
  .kot-line .ar { display: block; font-size: 16px; font-weight: 700; }
  .kot-mods { font-size: 14px; padding-left: 5mm; }
  .kot-note { font-size: 15px; font-weight: 800; padding-left: 5mm; text-transform: uppercase; }
  .station { font-size: 13px; font-weight: 800; border-bottom: 2px solid #000; margin-top: 3mm; text-transform: uppercase; }
  .void .kot-line { text-decoration: line-through; }
`;

function money(value: number, company: Company): string {
  return company.money(value);
}

function qr(text: string): string {
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();
  return code.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${Styles}</style></head><body>${body}</body></html>`;
}

export function checkHtml(order: Order, paid: boolean, company: Company, settings: PosSettings | null, local: (utc: string) => string): string {
  const t = order.totals;
  const type = orderTypeLabels[order.type];
  const logo = company.logoUrl();
  const lines = order.lines
    .filter((l) => l.quantity > 0)
    .map(
      (l) => `<tr><td>${esc(l.name)}${l.sizeName ? ` (${esc(l.sizeName)})` : ''}
        ${l.nameAr ? `<div class="item-ar ar">${esc(l.nameAr)}${l.sizeNameAr ? ` (${esc(l.sizeNameAr)})` : ''}</div>` : ''}
        ${l.modifiers ? `<div class="mods">+ ${esc(l.modifiers)}</div>` : ''}</td>
        <td class="n">${l.quantity}</td><td class="n">${money(l.unitPrice, company)}</td><td class="n">${money(l.total, company)}</td></tr>`,
    )
    .join('');
  const pair = (en: string, ar: string, value: string) => `<div class="pair"><span>${en} <span class="ar muted">${ar}</span></span><span>${value}</span></div>`;
  const share = !paid && order.splitWays ? pair(`Each of ${order.splitWays}`, 'لكل فرد', money(Math.ceil((t.total / order.splitWays) * 100) / 100, company)) : '';
  return page(
    `${paid ? 'Receipt' : 'Check'} #${order.number || order.id.slice(0, 8)}`,
    `${logo ? `<img class="logo" src="${esc(location.origin + logo)}" alt="">` : ''}
    <div class="c"><h1>${esc(company.name())}</h1>
      ${(settings?.receiptHeader ?? '').split('\n').filter(Boolean).map((l) => `<div class="muted">${esc(l)}</div>`).join('')}
      ${settings?.taxNumber ? `<div class="muted">Tax no. · الرقم الضريبي ${esc(settings.taxNumber)}</div>` : ''}
      <h2>${paid ? 'RECEIPT · فاتورة الدفع' : 'CHECK · شيك الحساب'}</h2></div>
    <div class="pair"><strong>${order.number ? `#${order.number}` : `Offline ${esc(order.id.slice(0, 8).toUpperCase())}`}${order.checkLabel ? ` · Check ${esc(order.checkLabel)}` : ''}</strong><span>${esc(local(order.paidAtUtc ?? new Date().toISOString()))}</span></div>
    <div>${type.en} · <span class="ar">${type.ar}</span>${order.tableLabel ? ` — Table ${esc(order.tableLabel)} · ${order.guests} guests` : ''}</div>
    <div class="muted">Captain · الكابتن: ${esc(order.openedBy)}${order.settledBy ? ` &nbsp; Cashier · الكاشير: ${esc(order.settledBy)}` : ''}</div>
    ${order.customer?.name ? `<div class="muted">Customer · العميل: ${esc(order.customer.name)} ${esc(order.customer.phone ?? '')}${order.customer.points != null ? ` · ${order.customer.points} pts` : ''}</div>` : ''}
    ${order.deliveryAddress ? `<div class="muted">Address · العنوان: ${esc(order.deliveryAddress)}</div>` : ''}
    <hr><table><thead><tr><th>Item · الصنف</th><th class="n">Qty</th><th class="n">Price</th><th class="n">Total</th></tr></thead><tbody>${lines}</tbody></table><hr>
    ${pair('Subtotal', 'الإجمالي', money(t.gross, company))}
    ${t.lineDiscounts + t.billDiscount > 0 ? pair('Discount', 'الخصم', '−' + money(t.lineDiscounts + t.billDiscount, company)) : ''}
    ${t.redemption > 0 ? pair(`Points redeemed (${order.pointsRedeemed})`, 'نقاط مستبدلة', '−' + money(t.redemption, company)) : ''}
    ${t.service > 0 ? pair(`Service ${order.servicePercent}%`, 'خدمة', money(t.service, company)) : ''}
    ${pair(`VAT ${order.taxPercent}%`, 'ضريبة القيمة المضافة', money(t.tax, company))}
    <div class="pair total"><span>TOTAL · الإجمالي</span><span>${money(t.total, company)}</span></div>
    ${share}
    ${order.payments
      .map(
        (p) =>
          pair(paymentLabels[p.method].en, paymentLabels[p.method].ar, money(p.amount, company)) +
          (p.tendered != null ? pair('&nbsp;&nbsp;Tendered', 'المدفوع', money(p.tendered, company)) + pair('&nbsp;&nbsp;Change', 'الباقي', money(p.change, company)) : ''),
      )
      .join('')}
    ${order.pointsEarned > 0 ? `<div class="c" style="margin-top:2mm"><strong>+${order.pointsEarned} loyalty points · نقطة ولاء</strong></div>` : ''}
    <hr><div class="c">${(settings?.receiptFooter ?? '').split('\n').filter(Boolean).map((l) => `<div>${esc(l)}</div>`).join('')}</div>
    <div class="qr">${qr(`${company.name()} #${order.number} ${order.businessDate} ${t.total.toFixed(2)}`)}</div>`,
  );
}

export function ticketHtml(ticket: Ticket, stationId: string | null, local: (utc: string) => string): string {
  const lines = ticket.lines.filter((l) => !stationId || l.stationId === stationId);
  const byStation = new Map<string, typeof lines>();
  for (const line of lines) {
    const key = line.stationName ?? 'Kitchen';
    byStation.set(key, [...(byStation.get(key) ?? []), line]);
  }
  const banner = { New: '', AddOn: 'ADD-ON · إضافي', Void: '✕ VOID · إلغاء ✕', Transfer: 'TABLE MOVED · نقل' }[ticket.kind];
  const where = ticket.orderType === 'DineIn' ? `TABLE ${esc(ticket.tableLabel)}${ticket.checkLabel ? ` (${esc(ticket.checkLabel)})` : ''}` : orderTypeLabels[ticket.orderType].en.toUpperCase();
  return page(
    `KOT ${ticket.number}`,
    `<div class="${ticket.kind === 'Void' ? 'void' : ''}">
    ${banner ? `<div class="banner">${banner}</div>` : ''}
    <div class="pair"><span class="kot-title">KOT ${ticket.number}</span><span class="kot-title">${esc(local(ticket.createdAtUtc).slice(-5))}</span></div>
    <div class="kot-table">${where}</div>
    <div class="muted">Order #${ticket.orderNumber} · ${ticket.guests} guests · ${esc(ticket.createdBy)}</div>
    ${ticket.note ? `<div class="kot-note">${esc(ticket.note)}</div>` : ''}
    ${[...byStation.entries()]
      .map(
        ([station, items]) =>
          `<div class="station">${esc(station)}</div>` +
          items
            .map(
              (l) => `<div class="kot-line">${ticket.kind === 'Void' ? '−' : ''}${l.quantity} × ${esc(l.name)}${l.sizeName ? ` (${esc(l.sizeName)})` : ''}
                ${l.nameAr ? `<span class="ar">${esc(l.nameAr)}</span>` : ''}</div>
                ${l.modifiers ? `<div class="kot-mods">+ ${esc(l.modifiers)}</div>` : ''}
                ${l.notes ? `<div class="kot-note">** ${esc(l.notes)} **</div>` : ''}`,
            )
            .join(''),
      )
      .join('')}</div>`,
  );
}

// A printer's test page: its name, the time, and a line of each width, to see it prints and cuts.
export function testHtml(printerName: string | null, company: Company, at: string): string {
  return page(
    'Test page',
    `<div class="c"><h1>${esc(company.name())}</h1><h2>TEST PAGE · صفحة اختبار</h2></div><hr>
    <div class="pair"><span>Printer</span><span>${esc(printerName ?? 'This browser')}</span></div>
    <div class="pair"><span>Time</span><span>${esc(at)}</span></div><hr>
    <div class="kot-line">1× Large text <span class="ar">نص كبير</span></div>
    <div class="kot-note">Notes print loud</div><hr>
    <div class="c muted">If you can read this, the printer works.</div>`,
  );
}

export function zReportHtml(z: ZReport, company: Company, local: (utc: string) => string): string {
  const m = (v: number) => money(v, company);
  const pair = (en: string, ar: string, value: string, bold = false) =>
    `<div class="pair"${bold ? ' style="font-weight:800"' : ''}><span>${en} <span class="ar muted">${ar}</span></span><span>${value}</span></div>`;
  return page(
    `${z.isClosed ? 'Z' : 'X'} report ${z.number}`,
    `<div class="c"><h1>${esc(company.name())}</h1><h2>${z.isClosed ? 'Z REPORT · تقرير Z' : 'X REPORT · تقرير X'}</h2></div>
    ${pair(`Shift ${z.number}`, 'الوردية', esc(z.businessDate))}
    ${pair('Opened', 'فتح', `${esc(local(z.openedAtUtc))} ${esc(z.openedBy)}`)}
    ${z.closedAtUtc ? pair('Closed', 'إغلاق', `${esc(local(z.closedAtUtc))} ${esc(z.closedBy)}`) : ''}<hr>
    ${pair('Checks / guests', 'الشيكات / الأفراد', `${z.checks} / ${z.guests}`)}
    ${pair('Gross sales', 'إجمالي المبيعات', m(z.grossSales))}
    ${pair('Discounts', 'الخصومات', '−' + m(z.discounts))}
    ${pair('Points redeemed', 'نقاط مستبدلة', '−' + m(z.redemptions))}
    ${pair('Net sales (before tax)', 'صافي المبيعات', m(z.netSales), true)}
    ${pair('of which service', 'منها خدمة', m(z.service))}
    ${pair('Tax collected', 'الضريبة المحصلة', m(z.tax))}
    ${pair('Total', 'الإجمالي', m(z.totalSales), true)}<hr>
    ${pair('Cash', 'كاش', m(z.cashSales))}${pair('Visa / card', 'فيزا', m(z.cardSales))}${pair('Wallet', 'محفظة', m(z.walletSales))}${pair('Staff meals', 'وجبات العاملين', m(z.staffMeals))}
    ${z.byType.map((t) => pair(`&nbsp;&nbsp;${orderTypeLabels[t.type].en} (${t.checks})`, orderTypeLabels[t.type].ar, m(t.total))).join('')}<hr>
    ${pair(`Void before kitchen (${z.voidBeforeCount})`, 'إلغاء قبل المطبخ', m(z.voidBeforeAmount))}
    ${pair(`Void after kitchen (${z.voidAfterCount})`, 'إلغاء بعد المطبخ', m(z.voidAfterAmount))}
    ${z.voidAfterReasons.map((r) => pair(`&nbsp;&nbsp;${esc(r.reason)} (${r.count})`, '', m(r.amount))).join('')}
    ${z.drivers.map((d) => pair(`Driver ${esc(d.driver)} (${d.orders})`, 'سائق', m(d.cash))).join('')}<hr>
    ${pair('Opening float', 'العهدة', m(z.openingFloat))}${pair('+ Cash sales', 'مبيعات كاش', m(z.cashSales))}${pair('− Paid out', 'مصروفات', m(z.paidOuts))}
    ${pair('Expected cash', 'النقدية المتوقعة', m(z.expectedCash), true)}
    ${z.countedCash != null ? pair('Counted cash', 'النقدية الفعلية', m(z.countedCash)) + pair('Variance', 'الفرق', m(z.variance ?? 0), true) : ''}`,
  );
}

// Prints at this terminal: a document fetched by what it is of, in a hidden frame the browser prints
// at 80 mm. A print station (this browser, set on Printers) also prints what the server asks of the
// terminals: bills a captain asked for, and kitchen tickets of a station printing in the browser.
@Injectable({ providedIn: 'root' })
export class PrintService {
  private readonly api = inject(PosApi);
  private readonly company = inject(Company);
  private readonly live = inject(LiveService);
  private readonly offline = inject(OfflineStore);
  private settings: PosSettings | null = null;

  readonly station = signal(readStation());
  private listening = false;

  setStation(on: boolean): void {
    this.station.set(on);
    try {
      localStorage.setItem('pos.printStation', on ? '1' : '0');
    } catch {
      // Not kept: this tab only.
    }
  }

  listen(): void {
    if (this.listening) {
      return;
    }
    this.listening = true;
    this.live.printRequested.subscribe((job) => {
      if (this.station()) {
        void this.printJob(job);
      }
    });
    // The check's header and footer fetched now, and again when the settings change, so a check
    // printed while the server cannot be reached still has them.
    void this.posSettings();
    this.live.menuChanged.subscribe(() => {
      this.settings = null;
      void this.posSettings();
    });
  }

  // What this terminal asked the server to print: the server prints it on a network printer, or
  // asks the print station; a terminal that is no print station prints it here.
  async printedHere(kind: PrintDocumentKind, subjectId: string, cashierPrintsInBrowser: boolean): Promise<void> {
    if (cashierPrintsInBrowser && !this.station()) {
      await this.printJob({ id: crypto.randomUUID(), kind, subjectId, printerId: null, printerName: null, stationId: null });
    }
  }

  async printJob(job: BrowserPrintJob): Promise<void> {
    const html =
      job.kind === 'Test'
        ? testHtml(job.printerName, this.company, this.company.formatLocal(new Date().toISOString()))
        : await this.html(job.kind, job.subjectId, job.stationId);
    if (html) {
      this.print(html);
    }
  }

  async html(kind: PrintDocumentKind, subjectId: string, stationId: string | null = null): Promise<string | null> {
    const local = (utc: string) => this.company.formatLocal(utc);
    switch (kind) {
      case 'Bill':
      case 'Receipt':
        return checkHtml(await firstValueFrom(this.api.order(subjectId)), kind === 'Receipt', this.company, await this.posSettings(), local);
      case 'KitchenTicket':
        return ticketHtml(await firstValueFrom(this.api.ticket(subjectId)), stationId, local);
      case 'ZReport':
        return zReportHtml(await firstValueFrom(this.api.shiftReport(subjectId)), this.company, local);
      default:
        return null;
    }
  }

  // A check as this terminal has it, printed here: while the server cannot be reached, the guest's
  // check or paid receipt from the terminal's own copy.
  async printOrder(order: Order, paid: boolean): Promise<void> {
    this.print(checkHtml(order, paid, this.company, await this.posSettings(), (utc: string) => this.company.formatLocal(utc)));
  }

  // The check's header and footer, kept for when the server cannot be asked.
  private async posSettings(): Promise<PosSettings | null> {
    if (!this.settings) {
      try {
        this.settings = (await this.offline.cached('pos-settings', () => this.api.settings())).value;
      } catch {
        return null;
      }
    }
    return this.settings;
  }

  // Into a frame of its own, printed, then taken away.
  print(html: string): void {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(html);
    doc.close();
    const go = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } finally {
        setTimeout(() => frame.remove(), 1000);
      }
    };
    const logo = doc.querySelector('img');
    if (logo && !logo.complete) {
      logo.addEventListener('load', go, { once: true });
      logo.addEventListener('error', go, { once: true });
    } else {
      setTimeout(go, 50);
    }
  }
}

function readStation(): boolean {
  try {
    return localStorage.getItem('pos.printStation') !== '0';
  } catch {
    return true;
  }
}

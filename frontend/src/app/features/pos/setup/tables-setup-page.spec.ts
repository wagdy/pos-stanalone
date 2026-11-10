import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { PosApi } from '../../../core/pos/pos.api';
import { NotifyService } from '../../../core/ui/notify.service';
import { aFloor, aTable } from '../../../../testing/pos-fixtures';
import { PosStore } from '../pos-store';
import { TablesSetupPage } from './tables-setup-page';

const text = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();

describe('setting out the tables', () => {
  const saveTable = vi.fn();
  const notify = { info: vi.fn(), error: vi.fn() };

  async function render() {
    // Table 1 at column 0; table 2, a long one, at columns 2 and 3; both in row 0.
    const floor = aFloor([aTable(), aTable({ id: 'table-2', label: '2', x: 2, y: 0, shape: 'Long' })]);
    TestBed.configureTestingModule({
      providers: [
        { provide: PosApi, useValue: { floor: () => of(floor), saveTable } },
        { provide: PosStore, useValue: { loadFloor: vi.fn() } },
        { provide: NotifyService, useValue: notify },
      ],
    });
    const fixture = TestBed.createComponent(TablesSetupPage);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const settle = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const table = (label: string) => [...el.querySelectorAll<HTMLButtonElement>('.t')].find((t) => t.getAttribute('aria-label')!.startsWith(`Table ${label}:`))!;
    const cell = (x: number, y: number) => el.querySelector<HTMLButtonElement>(`.cell[aria-label="Column ${x}, row ${y}"]`)!;
    return { el, settle, table, cell };
  }

  beforeEach(() => {
    saveTable.mockReset().mockReturnValue(of({}));
    notify.info.mockReset();
    notify.error.mockReset();
  });

  it('names every field of a zone', async () => {
    const { el } = await render();
    expect([...el.querySelectorAll('.zone-row')[0].querySelectorAll('.field-label')].map(text)).toEqual([
      'Name · الاسم',
      'Arabic name · الاسم بالعربي',
      'Order · الترتيب',
    ]);
  });

  it('puts a table where it is tapped on the plan, and saves it there', async () => {
    const { settle, table, cell } = await render();

    table('1').click();
    await settle();
    cell(5, 2).click();
    await settle();

    expect(saveTable).toHaveBeenCalledWith('table-1', expect.objectContaining({ x: 5, y: 2, label: '1', zoneId: 'zone-hall' }));
    expect(notify.info).toHaveBeenCalledWith('Table 1 moved to column 5, row 2. · تم النقل.');
  });

  it('puts a table where it is dropped, a long one kept inside the twelve columns', async () => {
    const { settle, table, cell } = await render();
    const drag = (type: string, target: HTMLElement) => target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));

    drag('dragstart', table('2'));
    await settle();
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    cell(11, 3).dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    drag('drop', cell(11, 3));
    await settle();

    expect(saveTable).toHaveBeenCalledWith('table-2', expect.objectContaining({ x: 10, y: 3, shape: 'Long' }));
  });

  it('refuses a place another table stands in', async () => {
    const { settle, table, cell } = await render();

    table('1').click();
    await settle();
    // Column 3 is the long table 2's second.
    cell(3, 0).click();
    await settle();

    expect(saveTable).not.toHaveBeenCalled();
    expect(notify.error).toHaveBeenCalledWith(null, 'Table 2 stands there: pick a free place. · المكان مشغول.');
  });

  it('asks for a table to be picked before a cell is tapped', async () => {
    const { settle, cell } = await render();
    cell(4, 4).click();
    await settle();
    expect(saveTable).not.toHaveBeenCalled();
    expect(notify.info).toHaveBeenCalledWith('Pick a table first, then tap where it goes. · اختر ترابيزة أولاً.');
  });
});

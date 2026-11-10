import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { NotifyService } from '../../../core/ui/notify.service';
import { cashierMe } from '../../../../testing/fixtures';
import { aFloor, aTable, anOrder } from '../../../../testing/pos-fixtures';
import { OrderCommands, PosStore } from '../pos-store';
import { FloorPage } from './floor-page';

const text = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();

describe('the floor plan', () => {
  const commands = { open: vi.fn() };
  const markOpenedOffline = vi.fn();
  const open = vi.fn();
  const check = (orderId: string, checkLabel: string | null, total: number) => ({
    orderId, number: 20, checkLabel, status: 'Open' as const, total, guests: 2, openedBy: 'Karim', openedAtUtc: new Date().toISOString(), hasDrafts: false,
  });
  const floor = aFloor([
    aTable(),
    aTable({ id: 'table-2', label: '2', x: 3, y: 1, state: 'Occupied', checks: [check('order-2', 'A', 100), check('order-3', 'B', 50)] }),
    aTable({ id: 'table-3', label: '3', x: 6, state: 'BillRequested', shape: 'Long', checks: [check('order-4', null, 300)] }),
    aTable({ id: 'table-t1', zoneId: 'zone-terrace', label: 'T1' }),
  ]);

  async function render() {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: PosStore, useValue: { floor: signal(floor), menu: signal(null), start: vi.fn(), markOpenedOffline } },
        { provide: AuthService, useValue: { me: () => cashierMe } },
        { provide: OrderCommands, useValue: commands },
        { provide: MatDialog, useValue: { open } },
        { provide: NotifyService, useValue: { info: vi.fn(), error: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(FloorPage);
    await fixture.whenStable();
    fixture.detectChanges();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const settle = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
    };
    return { el: fixture.nativeElement as HTMLElement, fixture, navigate, settle };
  }

  beforeEach(() => {
    commands.open.mockReset();
    markOpenedOffline.mockReset();
    open.mockReset();
  });

  it('lays the plan out in cells as wide as they are tall, a long table two of them, the empty columns and rows thin aisles', async () => {
    const { fixture } = await render();
    const layout = (fixture.componentInstance as unknown as { layout: () => { columns: string; rows: string; width: number } }).layout();
    // Tables at columns 0, 3 and 6 (a long one, to 7), rows 0 and 1.
    expect(layout.columns.split(' ')).toEqual([
      'var(--cell)', 'var(--gap-cell)', 'var(--gap-cell)', 'var(--cell)', 'var(--gap-cell)', 'var(--gap-cell)', 'var(--cell)', 'var(--cell)',
    ]);
    expect(layout.rows.split(' ')).toEqual(['var(--cell)', 'var(--cell)']);
    // Four cells of 148, four aisles of 16, seven gaps of 12.
    expect(layout.width).toBe(4 * 148 + 4 * 16 + 7 * 12);
  });

  it('shows a zone’s tables where they stand, by state, with what each check comes to', async () => {
    const { el, settle } = await render();
    const tables = [...el.querySelectorAll<HTMLElement>('.table')];

    expect(tables.map((t) => t.querySelector('.label')!.textContent)).toEqual(['1', '2', '3']);
    expect(tables.map((t) => t.classList.contains('Available') || t.classList.contains('Occupied') || t.classList.contains('BillRequested') ? t.className.split(' ').find((c) => /Available|Occupied|BillRequested/.test(c)) : '')).toEqual([
      'Available',
      'Occupied',
      'BillRequested',
    ]);
    expect(tables[1].style.gridColumn).toBe('4 / span 1');
    expect(tables[2].style.gridColumn).toBe('7 / span 2');
    expect(text(tables[1].querySelector('.total')!)).toBe('L.E 150.00');
    expect([...tables[1].querySelectorAll('.check-chip')].map(text)).toEqual(['A', 'B']);
    expect([...el.querySelectorAll('.legend strong')].map(text)).toEqual(['2', '1', '1']);

    el.querySelectorAll<HTMLButtonElement>('.zone')[1].click();
    await settle();
    expect([...el.querySelectorAll('.table .label')].map((t) => t.textContent)).toEqual(['T1']);
  });

  it('opens a taken table’s check on the terminal, or the split check tapped', async () => {
    const { el, navigate } = await render();

    el.querySelectorAll<HTMLButtonElement>('.table')[1].click();
    expect(navigate).toHaveBeenLastCalledWith(['/pos/terminal'], { queryParams: { order: 'order-2' } });

    el.querySelectorAll<HTMLElement>('.check-chip')[1].click();
    expect(navigate).toHaveBeenLastCalledWith(['/pos/terminal'], { queryParams: { order: 'order-3' } });
  });

  it('opens a free table with how many sit at it', async () => {
    open.mockReturnValue({ afterClosed: () => of(4) });
    commands.open.mockResolvedValue(anOrder({ id: 'order-new' }));
    const { el, navigate, settle } = await render();

    el.querySelector<HTMLButtonElement>('.table')!.click();
    await settle();

    expect(commands.open.mock.lastCall!.slice(0, 3)).toEqual(['DineIn', 'table-1', 4]);
    const id = commands.open.mock.lastCall![4];
    expect(navigate).toHaveBeenCalledWith(['/pos/terminal'], { queryParams: { order: id } });
    expect(markOpenedOffline).not.toHaveBeenCalled();
  });

  it('opens a table while the server cannot be reached: taken here at once, and on to the terminal', async () => {
    open.mockReturnValue({ afterClosed: () => of(2) });
    commands.open.mockResolvedValue(null);
    const { el, navigate, settle } = await render();

    el.querySelector<HTMLButtonElement>('.table')!.click();
    await settle();

    const id = commands.open.mock.lastCall![4];
    expect(markOpenedOffline).toHaveBeenCalledWith(expect.objectContaining({ id, tableId: 'table-1', tableLabel: '1', guests: 2, number: 0 }));
    expect(navigate).toHaveBeenCalledWith(['/pos/terminal'], { queryParams: { order: id } });
  });
});

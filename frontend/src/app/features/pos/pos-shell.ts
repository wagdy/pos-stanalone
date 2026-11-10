import { Component, computed, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { Permission, Permissions } from '../../core/auth/permissions';
import { SideGroup, SideLayout, SideSection } from '../shared/side-layout';
import { PosStore } from './pos-store';

const Service: SideGroup = { key: 'service', en: 'Service', ar: 'الخدمة' };
const Shift: SideGroup = { key: 'shift', en: 'Shift', ar: 'الوردية' };
const Setup: SideGroup = { key: 'setup', en: 'Setup', ar: 'الإعداد' };

const All: (SideSection & { permission: Permission })[] = [
  { path: 'terminal', en: 'Terminal', ar: 'نقطة البيع', icon: 'point_of_sale', group: Service, permission: Permissions.OrdersTake },
  { path: 'floor', en: 'Floor plan', ar: 'الصالة', icon: 'table_restaurant', group: Service, permission: Permissions.OrdersTake },
  { path: 'orders', en: 'Checks & receipts', ar: 'الشيكات', icon: 'receipt_long', group: Service, permission: Permissions.OrdersSettle },
  { path: '/pos/kds', en: 'Kitchen screen', ar: 'شاشة المطبخ', icon: 'soup_kitchen', group: Service, permission: Permissions.KitchenWork },
  { path: '/pos/captain', en: 'Captain', ar: 'الكابتن', icon: 'tablet_android', group: Service, permission: Permissions.OrdersTake },
  { path: 'shift', en: 'Shift & Z report', ar: 'الوردية', icon: 'lock_clock', group: Shift, permission: Permissions.ShiftsManage },
  { path: 'menu', en: 'Menu', ar: 'المنيو', icon: 'restaurant_menu', group: Setup, permission: Permissions.SetupManage },
  { path: 'tables', en: 'Tables', ar: 'الترابيزات', icon: 'grid_view', group: Setup, permission: Permissions.SetupManage },
  { path: 'printers', en: 'Printers', ar: 'الطابعات', icon: 'print', group: Setup, permission: Permissions.SetupManage },
  { path: 'settings', en: 'POS settings', ar: 'إعدادات البيع', icon: 'tune', group: Setup, permission: Permissions.SetupManage },
  { path: 'integrations', en: 'Integrations', ar: 'الربط', icon: 'hub', group: Setup, permission: Permissions.SetupManage },
];

// The till's sections beside the page: the service (terminal, floor, checks, kitchen, captain), the
// shift, and the setup a manager keeps. Each shows to those whose role works it. The sidebar is
// folded or open as the user leaves it, the same on every page.
@Component({
  selector: 'app-pos-shell',
  imports: [RouterOutlet, SideLayout],
  template: `
    <app-side-layout titleEn="Point of sale" titleAr="نقطة البيع" [sections]="sections()">
      <router-outlet />
    </app-side-layout>
  `,
})
export class PosShell {
  private readonly auth = inject(AuthService);
  private readonly store = inject(PosStore);

  protected readonly sections = computed<SideSection[]>(() => {
    const open = this.store.open().length;
    return All.filter((s) => this.auth.can(s.permission)).map(({ permission: _, ...s }) =>
      s.path === 'terminal' && open ? { ...s, count: open, countLabel: `${open} checks open` } : s,
    );
  });

  constructor() {
    this.store.start();
  }
}

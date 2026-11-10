import { Routes } from '@angular/router';
import { homeGuard, permissionGuard, signedInGuard, signedOutGuard } from './core/auth/guards';
import { Permissions } from './core/auth/permissions';

// The till's screens. The captain's phone (/pos/captain) and the kitchen screen (/pos/kds) are
// full screen, each with its own PIN pad; the rest sit in the shell, the till's sections beside them.
export const routes: Routes = [
  {
    path: 'sign-in',
    canActivate: [signedOutGuard],
    loadComponent: () => import('./features/sign-in/sign-in-page').then((m) => m.SignInPage),
  },
  {
    path: 'pos/captain',
    title: 'Captain',
    loadComponent: () => import('./features/pos/captain/captain-page').then((m) => m.CaptainPage),
  },
  {
    path: 'pos/kds',
    title: 'Kitchen',
    loadComponent: () => import('./features/pos/kds/kds-page').then((m) => m.KdsPage),
  },
  {
    path: '',
    canActivate: [signedInGuard],
    loadComponent: () => import('./features/shell/shell').then((m) => m.Shell),
    children: [
      { path: '', pathMatch: 'full', canActivate: [homeGuard], children: [] },
      {
        path: 'pos',
        loadComponent: () => import('./features/pos/pos-shell').then((m) => m.PosShell),
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'terminal' },
          {
            path: 'terminal',
            title: 'Terminal',
            canActivate: [permissionGuard(Permissions.OrdersTake)],
            loadComponent: () => import('./features/pos/terminal/terminal-page').then((m) => m.TerminalPage),
          },
          {
            path: 'floor',
            title: 'Floor',
            canActivate: [permissionGuard(Permissions.OrdersTake)],
            loadComponent: () => import('./features/pos/floor/floor-page').then((m) => m.FloorPage),
          },
          // The checks' page, by the name it is called in the till too.
          { path: 'checks', redirectTo: 'orders' },
          {
            path: 'orders',
            title: 'Checks',
            canActivate: [permissionGuard(Permissions.OrdersSettle)],
            loadComponent: () => import('./features/pos/orders/orders-page').then((m) => m.OrdersPage),
          },
          {
            path: 'shift',
            title: 'Shift',
            canActivate: [permissionGuard(Permissions.ShiftsManage)],
            loadComponent: () => import('./features/pos/shift/shift-page').then((m) => m.ShiftPage),
          },
          {
            path: 'menu',
            title: 'Menu',
            canActivate: [permissionGuard(Permissions.SetupManage)],
            loadComponent: () => import('./features/pos/setup/menu-setup-page').then((m) => m.MenuSetupPage),
          },
          {
            path: 'tables',
            title: 'Tables',
            canActivate: [permissionGuard(Permissions.SetupManage)],
            loadComponent: () => import('./features/pos/setup/tables-setup-page').then((m) => m.TablesSetupPage),
          },
          {
            path: 'printers',
            title: 'Printers',
            canActivate: [permissionGuard(Permissions.SetupManage)],
            loadComponent: () => import('./features/pos/setup/printers-page').then((m) => m.PrintersPage),
          },
          {
            path: 'settings',
            title: 'POS settings',
            canActivate: [permissionGuard(Permissions.SetupManage)],
            loadComponent: () => import('./features/pos/setup/pos-settings-page').then((m) => m.PosSettingsPage),
          },
          {
            path: 'integrations',
            title: 'Integrations',
            canActivate: [permissionGuard(Permissions.SetupManage)],
            loadComponent: () => import('./features/pos/setup/integrations-page').then((m) => m.IntegrationsPage),
          },
        ],
      },
      {
        path: 'users',
        title: 'Staff',
        canActivate: [permissionGuard(Permissions.UsersManage)],
        loadComponent: () => import('./features/users/users-page').then((m) => m.UsersPage),
      },
      {
        path: 'settings',
        title: 'Company settings',
        canActivate: [permissionGuard(Permissions.SettingsManage)],
        loadComponent: () => import('./features/settings/settings-page').then((m) => m.SettingsPage),
      },
      {
        path: 'account',
        title: 'Account',
        loadComponent: () => import('./features/account/account-page').then((m) => m.AccountPage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];

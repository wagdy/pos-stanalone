// The API's Permissions (Pos.Domain.Access), by the same strings. A role's set arrives from
// GET /api/auth/me, worked out by the same RolePermissions table the API enforces, so a button
// shows exactly when the API would allow what it does.
export const Permissions = {
  // Orders taken and sent to the kitchen.
  OrdersTake: 'orders.take',
  // Checks settled, split, discounted; customers' points redeemed.
  OrdersSettle: 'orders.settle',
  // A manager's yes: a void after the kitchen, a discount past the limit, without a PIN.
  OrdersAuthorize: 'orders.authorize',
  // The kitchen screen.
  KitchenWork: 'kitchen.work',
  // The shift, its paid-outs and its Z report.
  ShiftsManage: 'shifts.manage',
  // The menu, the floor, the printers, the POS settings and the integrations.
  SetupManage: 'setup.manage',
  ReportsView: 'reports.view',
  // The staff: added, changed, their passwords and PINs reset.
  UsersManage: 'users.manage',
  // Company Settings: the name and logo, the currency, the country, the time zone.
  SettingsManage: 'settings.manage',
} as const;

export type Permission = (typeof Permissions)[keyof typeof Permissions];

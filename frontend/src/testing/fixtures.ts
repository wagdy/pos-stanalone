import { Me } from '../app/core/api/models';
import { CompanySettings } from '../app/core/settings/company';

// What GET /api/auth/me returns for each role: the API's RolePermissions table.
export const managerMe: Me = {
  id: 'user-manager',
  fullName: 'Omar',
  email: 'omar@example.com',
  role: 'Manager',
  hasPin: true,
  permissions: [
    'orders.take',
    'orders.settle',
    'orders.authorize',
    'kitchen.work',
    'shifts.manage',
    'setup.manage',
    'reports.view',
    'users.manage',
    'settings.manage',
  ],
};

export const cashierMe: Me = {
  id: 'user-cashier',
  fullName: 'Mona',
  email: null,
  role: 'Cashier',
  hasPin: true,
  permissions: ['orders.take', 'orders.settle', 'kitchen.work', 'shifts.manage'],
};

export const captainMe: Me = {
  id: 'user-captain',
  fullName: 'Karim',
  email: null,
  role: 'Captain',
  hasPin: true,
  permissions: ['orders.take'],
};

export const kitchenMe: Me = {
  id: 'user-kitchen',
  fullName: 'Samir',
  email: null,
  role: 'Kitchen',
  hasPin: true,
  permissions: ['kitchen.work'],
};

// What GET /api/settings returns: a company in Egypt, its money written "L.E 1,400.00".
export function aCompany(overrides: Partial<CompanySettings> = {}): CompanySettings {
  return {
    name: 'Acme', currencySymbol: 'L.E', currencyPosition: 'Before', country: 'Egypt', timeZoneId: 'Africa/Cairo', workdayStartsAtHour: 4,
    hasLogo: false, logoVersion: 0, ...overrides,
  };
}

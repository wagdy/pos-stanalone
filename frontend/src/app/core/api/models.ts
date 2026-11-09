// Who works the restaurant: a manager does everything; a cashier takes orders, settles them and
// keeps the shift; a captain (a waiter) takes table orders on a phone or tablet; the kitchen works
// the kitchen screen.
export type UserRole = 'Manager' | 'Cashier' | 'Captain' | 'Kitchen';

export const roleLabels: Record<UserRole, { en: string; ar: string }> = {
  Manager: { en: 'Manager', ar: 'مدير' },
  Cashier: { en: 'Cashier', ar: 'كاشير' },
  Captain: { en: 'Captain', ar: 'كابتن' },
  Kitchen: { en: 'Kitchen', ar: 'المطبخ' },
};

// GET /api/auth/me: who is signed in and what they may do.
export interface Me {
  id: string;
  fullName: string;
  email: string | null;
  role: UserRole;
  hasPin: boolean;
  permissions: string[];
}

// POST /api/auth/sign-in or /pin, and a password changed: the token, good until expiresAtUtc.
export interface SignInResponse {
  token: string;
  expiresAtUtc: string;
  user: Me;
}

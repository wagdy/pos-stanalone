import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { UserRole } from '../api/models';

export { roleLabels } from '../api/models';

// Who signs in to the till (GET /api/users), a manager's to keep: a manager with an email and a
// password (and a PIN for the terminals), everyone else with a four-digit PIN. isLocked: too many
// wrong tries, for a few minutes; a new password or PIN lifts it.
export interface User {
  id: string;
  email: string | null;
  fullName: string;
  role: UserRole;
  isActive: boolean;
  hasPin: boolean;
  hasPassword: boolean;
  employeeId: string | null;
  createdAtUtc: string;
  lastSignInAtUtc: string | null;
  isLocked: boolean;
}

export interface NewUser {
  email: string | null;
  fullName: string;
  role: UserRole;
  password: string | null;
  pin: string | null;
}

export interface UserChange {
  email: string | null;
  fullName: string;
  role: UserRole;
  isActive: boolean;
}

// A password is this long at least, as the API asks.
export const MinPasswordLength = 8;

@Injectable({ providedIn: 'root' })
export class UsersApi {
  private readonly http = inject(HttpClient);

  all(): Observable<User[]> {
    return this.http.get<User[]>('/api/users');
  }

  create(user: NewUser): Observable<User> {
    return this.http.post<User>('/api/users', user);
  }

  update(id: string, change: UserChange): Observable<User> {
    return this.http.put<User>(`/api/users/${encodeURIComponent(id)}`, change);
  }

  // Signs them out wherever they are signed in, and lifts a lockout.
  resetPassword(id: string, password: string): Observable<void> {
    return this.http.put<void>(`/api/users/${encodeURIComponent(id)}/password`, { password });
  }

  // Four digits no one else has; signs them out at the terminals.
  resetPin(id: string, pin: string): Observable<void> {
    return this.http.put<void>(`/api/users/${encodeURIComponent(id)}/pin`, { pin });
  }
}

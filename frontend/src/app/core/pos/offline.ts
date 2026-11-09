import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';

// The terminal's own copy (IndexedDB): the menu and the floor as last seen, so the screens open
// even while the server cannot be reached; and the outbox of what the till did meanwhile (items
// added, sent, paid), each a request with the ids it was made with, sent again in order once the
// server answers. The server takes each once, by those ids.

export interface QueuedCommand {
  id: string;
  method: 'POST' | 'PUT';
  url: string;
  body: unknown;
  // What it was, as the sync drawer lists it: "Check #12: 2 items".
  label: string;
  // The check it is about, for its screen to show what waits.
  orderId: string | null;
  createdAt: string;
  attempts: number;
  lastError: string | null;
  // Refused by the server (not unreachable): kept to be looked at, never sent by itself again.
  failed: boolean;
}

const DbName = 'pos-terminal';
const Cache = 'cache';
const Outbox = 'outbox';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DbName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(Cache);
        request.result.createObjectStore(Outbox, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function run<T>(db: IDBDatabase | null, store: string, mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    if (!db) {
      resolve(null);
      return;
    }
    try {
      const request = work(db.transaction(store, mode).objectStore(store));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

@Injectable({ providedIn: 'root' })
export class OfflineStore {
  private readonly http = inject(HttpClient);
  private readonly db = openDb();
  // No IndexedDB (a private window, storage switched off): kept in memory for as long as the tab is
  // open, so what was done offline still waits to be sent.
  private readonly memoryCache = new Map<string, unknown>();
  private readonly memoryOutbox = new Map<string, QueuedCommand>();
  private flushing = false;

  // What waits to be sent, oldest first.
  readonly queue = signal<QueuedCommand[]>([]);
  readonly pending = computed(() => this.queue().filter((c) => !c.failed).length);
  readonly failed = computed(() => this.queue().filter((c) => c.failed).length);

  constructor() {
    void this.reload();
  }

  async read<T>(key: string): Promise<T | null> {
    const db = await this.db;
    if (!db) return (this.memoryCache.get(key) as T | undefined) ?? null;
    return (await run<T>(db, Cache, 'readonly', (s) => s.get(key) as IDBRequest<T>)) ?? null;
  }

  async write(key: string, value: unknown): Promise<void> {
    const db = await this.db;
    if (!db) this.memoryCache.set(key, value);
    else await run(db, Cache, 'readwrite', (s) => s.put(value, key));
  }

  // Fetched, and kept: when the server cannot be reached, what was kept last.
  async cached<T>(key: string, fetch: () => Observable<T>): Promise<{ value: T; stale: boolean }> {
    try {
      const value = await firstValueFrom(fetch());
      void this.write(key, value);
      return { value, stale: false };
    } catch (error) {
      const kept = await this.read<T>(key);
      if (kept !== null && isUnreachable(error)) {
        return { value: kept, stale: true };
      }
      throw error;
    }
  }

  // Sent now; when the server cannot be reached, queued to be sent once it can. The answer, or
  // null when it was queued.
  async send<T>(command: Omit<QueuedCommand, 'id' | 'createdAt' | 'attempts' | 'lastError' | 'failed'> & { id?: string }): Promise<T | null> {
    // What was queued before goes first: the server takes them in order.
    if (this.pending() > 0) {
      await this.flush();
    }
    if (this.pending() === 0) {
      try {
        return await firstValueFrom(this.request<T>(command.method, command.url, command.body));
      } catch (error) {
        if (!isUnreachable(error)) {
          throw error;
        }
      }
    }
    const queued: QueuedCommand = {
      ...command,
      id: command.id ?? crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      attempts: 0,
      lastError: null,
      failed: false,
    };
    await this.put(queued);
    await this.reload();
    return null;
  }

  // Everything waiting, in order, until the server cannot be reached again. One the server
  // refuses is set aside as failed, and the rest go on.
  async flush(): Promise<number> {
    if (this.flushing) {
      return 0;
    }
    this.flushing = true;
    let sent = 0;
    try {
      for (const command of this.queue().filter((c) => !c.failed)) {
        try {
          await firstValueFrom(this.request(command.method, command.url, command.body));
          await this.remove(command.id);
          sent++;
        } catch (error) {
          const unreachable = isUnreachable(error);
          const kept = { ...command, attempts: command.attempts + 1, lastError: describe(error), failed: !unreachable };
          await this.put(kept);
          if (unreachable) {
            break;
          }
        }
      }
    } finally {
      this.flushing = false;
      await this.reload();
    }
    return sent;
  }

  async retry(id: string): Promise<void> {
    const command = this.queue().find((c) => c.id === id);
    if (command) {
      await this.put({ ...command, failed: false });
      await this.reload();
      await this.flush();
    }
  }

  async discard(id: string): Promise<void> {
    await this.remove(id);
    await this.reload();
  }

  forOrder(orderId: string): QueuedCommand[] {
    return this.queue().filter((c) => c.orderId === orderId);
  }

  private request<T>(method: 'POST' | 'PUT', url: string, body: unknown): Observable<T> {
    return method === 'PUT' ? this.http.put<T>(url, body) : this.http.post<T>(url, body);
  }

  private async put(command: QueuedCommand): Promise<void> {
    const db = await this.db;
    if (!db) this.memoryOutbox.set(command.id, command);
    else await run(db, Outbox, 'readwrite', (s) => s.put(command));
  }

  private async remove(id: string): Promise<void> {
    const db = await this.db;
    if (!db) this.memoryOutbox.delete(id);
    else await run(db, Outbox, 'readwrite', (s) => s.delete(id));
  }

  private async reload(): Promise<void> {
    const db = await this.db;
    const all = db
      ? ((await run<QueuedCommand[]>(db, Outbox, 'readonly', (s) => s.getAll() as IDBRequest<QueuedCommand[]>)) ?? [])
      : [...this.memoryOutbox.values()];
    // In the order they were done (a tie, as they were put).
    this.queue.set([...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }
}

// The server did not answer at all (no network, the server down): worth sending again.
export function isUnreachable(error: unknown): boolean {
  return error instanceof HttpErrorResponse && (error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504);
}

function describe(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const errors = (error.error as { errors?: string[] } | null)?.errors;
    return errors?.[0] ?? `${error.status} ${error.statusText}`;
  }
  return String(error);
}

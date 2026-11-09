import { Injectable, inject, signal } from '@angular/core';
import { HubConnection, HubConnectionBuilder, HubConnectionState, LogLevel } from '@microsoft/signalr';
import { Subject } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { BrowserPrintJob } from './pos.api';

// The live line to the till's server (/hubs/pos): what changed, the moment it does, on every
// terminal, captain's phone and kitchen screen at once. Each screen reloads what it shows of it.
// Reconnects by itself; while it is down, the screens fall back to asking every few seconds.
@Injectable({ providedIn: 'root' })
export class LiveService {
  private readonly auth = inject(AuthService);
  private connection: HubConnection | null = null;

  readonly connected = signal(false);
  readonly ordersChanged = new Subject<string[]>();
  readonly floorChanged = new Subject<void>();
  readonly kitchenChanged = new Subject<void>();
  readonly shiftChanged = new Subject<void>();
  readonly syncChanged = new Subject<void>();
  readonly menuChanged = new Subject<void>();
  readonly printRequested = new Subject<BrowserPrintJob>();
  // After the line comes back: anything may have changed meanwhile.
  readonly reconnected = new Subject<void>();

  async start(): Promise<void> {
    if (this.connection || typeof window === 'undefined' || !this.auth.token()) {
      return;
    }
    const connection = new HubConnectionBuilder()
      .withUrl('/hubs/pos', { accessTokenFactory: () => this.auth.token() ?? '' })
      .withAutomaticReconnect([0, 1000, 3000, 5000, 10000, 15000, 30000])
      .configureLogging(LogLevel.None)
      .build();
    connection.on('OrdersChanged', (ids: string[]) => this.ordersChanged.next(ids));
    connection.on('FloorChanged', () => this.floorChanged.next());
    connection.on('KitchenChanged', () => this.kitchenChanged.next());
    connection.on('ShiftChanged', () => this.shiftChanged.next());
    connection.on('SyncChanged', () => this.syncChanged.next());
    connection.on('MenuChanged', () => this.menuChanged.next());
    connection.on('PrintRequested', (job: BrowserPrintJob) => this.printRequested.next(job));
    connection.onreconnecting(() => this.connected.set(false));
    connection.onreconnected(() => {
      this.connected.set(true);
      this.reconnected.next();
    });
    connection.onclose(() => {
      this.connected.set(false);
      this.connection = null;
      // Closed for good (the reconnect gave up): try again in a while.
      setTimeout(() => void this.start(), 15000);
    });
    this.connection = connection;
    try {
      await connection.start();
      this.connected.set(true);
    } catch {
      this.connection = null;
      this.connected.set(false);
      setTimeout(() => void this.start(), 5000);
    }
  }

  async stop(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.connected.set(false);
    if (connection && connection.state !== HubConnectionState.Disconnected) {
      connection.onclose(() => undefined);
      await connection.stop();
    }
  }
}

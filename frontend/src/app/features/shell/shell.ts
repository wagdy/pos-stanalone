import { BreakpointObserver } from '@angular/cdk/layout';
import { Component, OnDestroy, OnInit, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { map } from 'rxjs';
import { roleLabels } from '../../core/api/models';
import { AuthService } from '../../core/auth/auth.service';
import { CanDirective } from '../../core/auth/can.directive';
import { homeFor } from '../../core/auth/guards';
import { Permissions } from '../../core/auth/permissions';
import { LiveService } from '../../core/pos/live.service';
import { PrintService } from '../../core/pos/print';
import { SyncStatus } from '../../core/pos/sync-status.service';
import { Company } from '../../core/settings/company';
import { ThemeService } from '../../core/ui/theme';
import { SyncDrawer } from '../pos/sync-drawer';

// Everything after sign-in: the bar with the till, the staff and the settings; the sync light
// (online and synced, or working locally with what waits counted) that opens the sync drawer;
// whether this browser is the print station; and the user's menu. Signed in, the live line to the
// server opens, and the sync light and the print station start.
@Component({
  selector: 'app-shell',
  imports: [CanDirective, MatButtonModule, MatIconModule, MatMenuModule, MatToolbarModule, MatTooltipModule, RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell implements OnInit, OnDestroy {
  protected readonly auth = inject(AuthService);
  protected readonly sync = inject(SyncStatus);
  protected readonly live = inject(LiveService);
  protected readonly printer = inject(PrintService);
  protected readonly theme = inject(ThemeService);
  private readonly dialog = inject(MatDialog);
  protected readonly Permissions = Permissions;
  protected readonly roleLabels = roleLabels;
  protected readonly company = inject(Company);
  protected readonly home = computed(() => homeFor(this.auth.me()?.role));
  // The signed-in user's first letters, in the avatar on their menu.
  protected readonly initials = computed(() =>
    (this.auth.me()?.fullName ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0].toUpperCase())
      .join(''),
  );

  // Narrower than this, the nav shows its icons only (shell.scss), and tooltips name them.
  protected readonly compactNav = toSignal(
    inject(BreakpointObserver)
      .observe('(max-width: 999.98px)')
      .pipe(map((state) => state.matches)),
    { initialValue: false },
  );

  ngOnInit(): void {
    void this.live.start();
    this.sync.start();
    this.printer.listen();
  }

  ngOnDestroy(): void {
    this.sync.stop();
  }

  protected openSync(): void {
    this.dialog.open(SyncDrawer, { width: '560px', maxWidth: '96vw', position: { right: '0', top: '0' }, height: '100dvh', panelClass: 'drawer-panel' });
  }

  protected signOut(): void {
    void this.live.stop();
    this.sync.stop();
    this.auth.signOut();
  }
}

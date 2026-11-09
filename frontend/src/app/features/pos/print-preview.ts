import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { DomSanitizer } from '@angular/platform-browser';
import { PrintService } from '../../core/pos/print';

export interface PrintPreviewData {
  title: string;
  // A whole document at 80 mm, from print.ts (every value in it escaped there).
  html: string;
}

// A document as the thermal printer would have it, on a strip of 80 mm paper on screen, with Print
// to send it to this browser's printer.
@Component({
  selector: 'app-print-preview',
  imports: [MatButtonModule, MatDialogModule, MatIconModule],
  template: `
    <h2 mat-dialog-title><mat-icon>receipt_long</mat-icon> {{ data.title }}</h2>
    <mat-dialog-content>
      <div class="paper">
        <iframe [srcdoc]="doc" [title]="data.title" (load)="fit($event)"></iframe>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Close</button>
      <button mat-flat-button (click)="print()"><mat-icon>print</mat-icon> Print · طباعة</button>
    </mat-dialog-actions>
  `,
  styles: `
    h2 {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .paper {
      display: flex;
      justify-content: center;
      padding: 16px;
      border-radius: 12px;
      background: var(--mat-sys-surface-container-high);
    }
    iframe {
      width: 80mm;
      min-height: 420px;
      border: 0;
      background: #fff;
      box-shadow: 0 6px 24px -8px rgb(0 0 0 / 35%);
    }
  `,
})
export class PrintPreviewDialog {
  protected readonly data = inject<PrintPreviewData>(MAT_DIALOG_DATA);
  private readonly printer = inject(PrintService);
  protected readonly doc = inject(DomSanitizer).bypassSecurityTrustHtml(this.data.html);

  // As tall as the document: the strip of paper whole, the dialog scrolling.
  protected fit(event: Event): void {
    const frame = event.target as HTMLIFrameElement;
    const height = frame.contentDocument?.documentElement.scrollHeight;
    if (height) frame.style.height = `${height + 8}px`;
  }

  protected print(): void {
    this.printer.print(this.data.html);
  }
}

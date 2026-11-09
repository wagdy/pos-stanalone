import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { OfflineStore, isUnreachable } from './offline';

// jsdom has no IndexedDB: the store keeps its outbox in memory, as a private window would.
describe('the terminal’s outbox', () => {
  let store: OfflineStore;
  let http: HttpTestingController;
  const tick = () => new Promise((resolve) => setTimeout(resolve));

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    store = TestBed.inject(OfflineStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const command = (n: number) => ({ method: 'POST' as const, url: `/api/orders/o/items`, body: { n }, label: `Check #1: item ${n}`, orderId: 'o' });

  it('sends at once while the server answers', async () => {
    const sent = store.send<{ ok: boolean }>(command(1));
    await tick();
    const request = http.expectOne('/api/orders/o/items');
    expect(request.request.body).toEqual({ n: 1 });
    request.flush({ ok: true });

    expect(await sent).toEqual({ ok: true });
    expect(store.pending()).toBe(0);
  });

  it('keeps what the server could not be reached for, and sends it in order once it answers', async () => {
    const first = store.send(command(1));
    await tick();
    http.expectOne('/api/orders/o/items').flush(null, { status: 0, statusText: 'Unknown Error' });
    expect(await first).toBeNull();
    expect(store.pending()).toBe(1);

    // The next one waits behind it: the first is tried again first, and still cannot go.
    const second = store.send(command(2));
    await tick();
    http.expectOne('/api/orders/o/items').flush(null, { status: 503, statusText: 'Unavailable' });
    expect(await second).toBeNull();
    expect(store.queue().map((c) => (c.body as { n: number }).n)).toEqual([1, 2]);
    expect(store.queue()[0].attempts).toBe(1);

    const flushed = store.flush();
    await tick();
    const one = http.expectOne('/api/orders/o/items');
    expect(one.request.body).toEqual({ n: 1 });
    one.flush({});
    await tick();
    const two = http.expectOne('/api/orders/o/items');
    expect(two.request.body).toEqual({ n: 2 });
    two.flush({});

    expect(await flushed).toBe(2);
    expect(store.pending()).toBe(0);
  });

  it('sets aside one the server refuses, and sends the rest', async () => {
    void store.send(command(1));
    await tick();
    http.expectOne('/api/orders/o/items').flush(null, { status: 0, statusText: '' });
    await tick();
    void store.send(command(2));
    await tick();
    http.expectOne('/api/orders/o/items').flush(null, { status: 0, statusText: '' });
    await tick();

    const flushed = store.flush();
    await tick();
    http.expectOne('/api/orders/o/items').flush({ errors: ['The check is paid.'] }, { status: 400, statusText: 'Bad Request' });
    await tick();
    http.expectOne('/api/orders/o/items').flush({});
    await flushed;

    expect(store.failed()).toBe(1);
    expect(store.pending()).toBe(0);
    expect(store.queue()[0].lastError).toBe('The check is paid.');

    await store.discard(store.queue()[0].id);
    expect(store.queue()).toEqual([]);
  });

  it('keeps a payment taken while waiting without asking the server to print its receipt again', async () => {
    const pay = { ...command(1), url: '/api/orders/o/pay', body: { payments: [], printReceipt: true }, bodyIfQueued: { payments: [], printReceipt: false } };
    const sent = store.send(pay);
    await tick();
    http.expectOne('/api/orders/o/pay').flush(null, { status: 0, statusText: '' });
    expect(await sent).toBeNull();
    expect(store.queue()[0].body).toEqual({ payments: [], printReceipt: false });
    expect('bodyIfQueued' in store.queue()[0]).toBe(false);

    // Sent later, as it was kept.
    const flushed = store.flush();
    await tick();
    const later = http.expectOne('/api/orders/o/pay');
    expect(later.request.body).toEqual({ payments: [], printReceipt: false });
    later.flush({});
    expect(await flushed).toBe(1);
  });

  it('gives back what it kept when the server cannot be reached, said to be stale', async () => {
    expect(await store.cached('menu', () => of({ items: 3 }))).toEqual({ value: { items: 3 }, stale: false });
    const down = () => throwError(() => new HttpErrorResponse({ status: 0 }));
    expect(await store.cached('menu', down)).toEqual({ value: { items: 3 }, stale: true });
    await expect(store.cached('floor', down)).rejects.toBeInstanceOf(HttpErrorResponse);
  });

  it('counts no answer, a bad gateway and the server down as unreachable; a refusal is not', () => {
    expect([0, 502, 503, 504, 400, 409].map((status) => isUnreachable(new HttpErrorResponse({ status })))).toEqual([true, true, true, true, false, false]);
  });
});

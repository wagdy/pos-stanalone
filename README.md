# Restaurant POS (نقطة البيع)

A standalone restaurant point of sale: the cashier's terminal, a captain's app for waiters'
phones and tablets, a kitchen display, thermal printing, shifts with X and Z reports, customer
loyalty, and links to the Costing, online ordering / loyalty and HR systems. It runs on a
restaurant's own machine (localhost) and keeps working when the network or the server drops.

It has its own repository and its own database (`pos_standalone`). It shares no code or tables
with the Costing, HR or ordering systems; it talks to them over HTTP only, through the Integration
Hub, and each link can be switched off.

## The stack

| Part | What |
| --- | --- |
| `backend/` | .NET 10, Clean Architecture: `Pos.Domain` (the rules), `Pos.Application` (MediatR commands and queries), `Pos.Infrastructure` (EF Core on PostgreSQL, schema `pos`; ESC/POS printing; the outbox sender; ClosedXML), `Pos.Api` (ASP.NET Core, JWT, the SignalR hub `/hubs/pos`) |
| `frontend/` | Angular 21: standalone components, signals, zoneless, Angular Material (M3), Slate & Indigo with an optional dark mode, English with Arabic beside it |
| `dev/docker-compose.yml` | The development database: `pos-dev-db`, PostgreSQL 17 on `127.0.0.1:5437` |
| `Dockerfile`, `railway.json` | One image (the app in the API's `wwwroot`), ready for Railway. See [docs/deploy-railway.md](docs/deploy-railway.md) |

## Running it locally

```bash
docker compose -f dev/docker-compose.yml up -d
```

```bash
cd backend && ASPNETCORE_ENVIRONMENT=Development dotnet run --project src/Pos.Api
```

```bash
cd frontend && npm start
```

The API listens on `http://localhost:5110` and applies its migrations on start. The app is on
`http://localhost:4240` (its dev server proxies `/api`, `/hubs` and `/health` to the API). In
Development the first manager is `manager@example.com` / `change-me-now`, PIN `1234`
(`appsettings.Development.json`): change both at once. **POS settings → Load a sample
restaurant** fills an empty system with four kitchen stations, a menu, two zones of tables and a
browser printer.

## Who works it

| Role | Signs in with | Lands on | Does |
| --- | --- | --- | --- |
| Manager | Email and password, or a PIN | Terminal | Everything: the setup, the staff, voids after the kitchen, discounts past the limit |
| Cashier | PIN | Terminal | Takes orders, settles and splits checks, keeps the shift |
| Captain | PIN | `/pos/captain` | Takes table orders on a phone or tablet, asks for the bill |
| Kitchen | PIN | `/pos/kds` | Works the kitchen screen |

A PIN is four digits no one else has, kept only as a keyed hash. A manager's PIN is also their
"yes" at a terminal: a void after the kitchen or a discount past the cashier's limit asks for it.

## The screens

- **Terminal** (`/pos/terminal`): the open checks by type, the menu by category (search by name or
  code, `/`), and the check. Keys: `F2` a takeaway, `F4` send to the kitchen, `F8` print the
  check, `F9` pay. Customer & loyalty bar, split, transfer, merge, discount, cancel.
- **Floor plan** (`/pos/floor`): each zone's tables where they stand, coloured Available /
  Occupied / Bill printed, with each check's total, guests and age.
- **Checks & receipts** (`/pos/orders`): the day's checks with their items, voids, payments and
  kitchen tickets; any of them previewed at 80 mm and printed again.
- **Kitchen screen** (`/pos/kds`): tickets oldest first, all stations or one, ageing green →
  amber (10 min) → red (20 min); ADD-ON, VOID and TABLE MOVED banners; bump and recall; a chime.
- **Captain** (`/pos/captain`): zones and tables, a table opened with its guests, items with
  sizes, modifiers and kitchen notes, Send to kitchen and Bill.
- **Shift & Z report** (`/pos/shift`): open with a float, paid-outs (expense, staff advance,
  driver), the live X report, close with the cash counted, past Z reports, the Costing sheet,
  clock in/out by PIN.
- **Setup**: Menu (items, categories, kitchen stations), Tables, Printers, POS settings,
  Integrations. **Staff** and **Company** settings sit in the top bar.

## Kitchen workflow

A line is **Draft** (لم يُرسل) until Send to Kitchen locks it on a numbered KOT (**Sent**,
أُرسل للمطبخ); bumping it on the kitchen screen makes it **Prepared**. A later send carries only
the new lines, on an **add-on ticket** (بون إلحاقي). Each station's part goes to that station's
printer and to the kitchen screen.

- **Void before the kitchen**: a draft is taken off freely, logged as a void before.
- **Void after the kitchen**: a manager's PIN (or a manager signed in), a reason, and what became
  of it: *already prepared → waste* (يُسجل هالك) or *not prepared yet → back to stock* (يعود
  للمخزن). A red **VOID** ticket goes to the station's printer and the kitchen screen. Which kind
  a void is comes from the line's state, never from the caller.
- **Split check**: items (or part of a line's quantity) onto check B, C…, or the total shared
  evenly between guests; each settled on its own.
- **Transfer table**: the table's checks move in one step; the kitchen gets a TABLE MOVED ticket.
- **Merge tables**: one table's check folded into another's.

Totals: gross − line discounts − bill discount − points redeemed = net; service (dine-in only)
on the net; VAT on net + service. Points earned = ⌊total × points per unit⌋, only with a
customer on the check.

## Printing

- **Network thermal printers**: ESC/POS over TCP 9100, sent by the server's print queue. Their
  fonts have no Arabic, so Arabic names are left off there (the kitchen screen and browser prints
  show them).
- **Browser printers**: the server asks the *print station* (a terminal with the printer icon on,
  in the top bar) to print the 80 mm HTML document. For silent printing, run Chrome with
  `--kiosk-printing` and the thermal printer as its default.
- Documents: the guest's check (pre-settlement, marks the table Bill printed), the paid receipt
  (payments, change, points, QR code), the KOT by station, and the X/Z report.

## Offline first

- **The terminal**: the menu and floor are kept in IndexedDB; every command carries ids made in
  the browser, so a command sent twice changes nothing the second time. When the server cannot be
  reached, commands wait in the terminal's outbox and are sent in order once it answers; a check
  opened meanwhile is worked on as "Waiting to sync". A void with a manager's PIN is never kept.
- **The server**: what the linked systems are owed waits in its own outbox (`pos.SyncItems`),
  each item's id a UUIDv5 of the system, kind and subject; tried again from 15 seconds, doubling
  to 10 minutes.
- **The sync light** in the top bar: "Online · All synced", or "Offline / Local mode · n pending
  sync"; it opens the sync drawer with every waiting item and **Sync now (مزامنة الآن)**.

## Integration Hub

Settings → Integrations links **Costing & Financials**, **Online ordering & loyalty** and
**HR & payroll**: each switched on with its URL, API key and branch code, and tested. The event
contract, the loyalty lookups and the Costing Excel layout are in
[docs/integrations.md](docs/integrations.md).

## Tests

```bash
cd backend && POS_TEST_DB="Host=localhost;Port=5437;Username=pos;Password=pos-dev" dotnet test --project tests/Pos.Domain.Tests
```

```bash
cd backend && POS_TEST_DB="Host=localhost;Port=5437;Username=pos;Password=pos-dev" dotnet test --project tests/Pos.Application.Tests
```

```bash
cd backend && POS_TEST_DB="Host=localhost;Port=5437;Username=pos;Password=pos-dev" dotnet test --project tests/Pos.Api.Tests
```

```bash
cd frontend && npx ng test --watch=false
```

The API tests make a database of their own for each run and drop it after; without
`POS_TEST_DB` they are skipped, so check the summary's `skipped: 0`.

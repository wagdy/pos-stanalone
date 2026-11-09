# The Integration Hub (ربط الأنظمة)

The POS links to three systems, each optional and each switched on in **Settings →
Integrations** with its URL, API key and branch code. The POS never reads or writes their
databases; it speaks HTTP to them, and the receiving side is theirs to build against this
contract. Nothing is queued for a link that is off, so switching one on later does not send it
the past.

| System | What it gets | What the POS asks of it |
| --- | --- | --- |
| Costing & Financials | `day.closed` at each Z close | — |
| Online ordering & loyalty | `customer.registered`, `order.paid` (points earned and redeemed) | Customers by phone, their points (live) |
| HR & payroll | `staff.advance`, `staff.meal`, `clock.event` | The staff and their PINs (Sync staff) |

## Every request

| Header | Value |
| --- | --- |
| `X-Api-Key` | The link's API key |
| `X-Pos-Node-Key` | The same key, for systems that know the POS as a node |
| `Idempotency-Key` | The event's id (on events) |

- `GET {base}/api/integrations/pos/ping`: **Test**. Any 2xx is connected.
- `POST {base}/api/integrations/pos/events`: one event, in the envelope below.
- `GET {base}/api/integrations/pos/staff` (HR only): the staff, for **Sync staff**.

### What an answer means

| Answer | The POS |
| --- | --- |
| 2xx | Delivered |
| 409 | Delivered: the system had it already (it keeps each event once, by its id) |
| 400, 422 | Refused: the item is marked failed and shown in the sync queue; **Retry the failed** sends it again |
| No answer, 5xx, any other | Unavailable: tried again from 15 seconds, doubling to 10 minutes |

## The envelope

```json
{
  "id": "6f0c…",            // UUIDv5 of (system, kind, subject): the same event always has the same id
  "kind": "day.closed",
  "branchCode": "BR-01",     // the link's branch code, or null
  "occurredAtUtc": "2026-11-09T20:04:51Z",
  "data": { … }
}
```

Property names are camelCase; enums are their names (`"DineIn"`, `"Waste"`); amounts are numbers
in the company's currency; dates are `yyyy-MM-dd`; times are UTC.

## The events

### `day.closed` → Costing

At each shift's close (the Z report). `data`:

```json
{
  "shiftId": "…", "shiftNumber": 3, "businessDate": "2026-11-09",
  "openedAtUtc": "…", "closedAtUtc": "…",
  "soldItems": [{ "code": 6101, "name": "Margherita", "quantity": 1, "netAmount": 215.0 }],
  "waste": [{ "code": 9003, "name": "Soft drink", "quantity": 1, "amount": 30.0, "reason": "Captain error" }],
  "returnedToStock": [{ "code": 7001, "name": "Classic burger", "quantity": 1, "reason": "Customer changed mind" }],
  "takings": {
    "cash": 627.2, "card": 0, "tax": 87.81, "netSales": 627.2,
    "voidsBefore": { "count": 0, "amount": 0 },
    "voidsAfter": { "count": 1, "amount": 30.0, "reasons": [{ "reason": "Captain error", "count": 1, "amount": 30.0 }] },
    "paidOuts": 200, "staffMeals": 0
  }
}
```

`soldItems` is net of voids, by the menu's item code (Costing matches its menu items by code).
`waste` are the voids after the kitchen that were already made (stock used, nothing sold);
`returnedToStock` the ones not yet made. In `takings`, `cash` and `card` are before tax (the tax
taken off in proportion), with `tax` apart.

### `order.paid` → loyalty

When a check with a customer on it is paid:

```json
{
  "orderId": "…", "number": 12, "businessDate": "2026-11-09", "type": "DineIn",
  "customer": { "id": "…", "name": "Sara", "phone": "01000000001", "loyaltyUserId": "…" },
  "net": 560.0, "total": 715.01, "pointsEarned": 71, "pointsRedeemed": 0, "redeemedValue": 0,
  "items": [{ "code": 6101, "name": "Margherita", "quantity": 1, "amount": 215.0 }],
  "paidAtUtc": "…"
}
```

### `customer.registered` → loyalty

`{ "id", "name", "phone", "registeredBy", "createdAtUtc" }`: a customer registered at the till
(name and phone).

### `staff.advance` → HR

`{ "paidOutId", "employee", "amount", "reason", "givenBy", "atUtc", "businessDate" }`: an
advance (سلفة) paid from the drawer during a shift.

### `staff.meal` → HR

`{ "paymentId", "employee", "amount", "orderId", "number", "businessDate", "atUtc" }`: a check
settled as a staff meal (وجبة عاملين).

### `clock.event` → HR

`{ "eventId", "staffId", "name", "role", "clockIn", "atUtc" }`: clock in or out at the till.

## HR: the staff

`GET {base}/api/integrations/pos/staff` answers:

```json
[{ "employeeId": "E-77", "name": "Hana", "role": "Captain", "pin": "7777", "isActive": true }]
```

**Sync staff** adds each active employee not yet known (by `employeeId`) who has a PIN, and
updates the name, role, active flag and PIN of those who are. `role` `cashier` makes a cashier;
`kitchen`, `chef` or `cook` the kitchen; anything else a captain. A manager is never changed from
HR, and a PIN someone else already has is skipped (the rest of that sync goes on).

## Loyalty: the live lookups

With the loyalty link on, the till asks the ordering system's existing till endpoints directly
(not through the outbox, since the answer is needed at once), with the same headers:

| Call | When |
| --- | --- |
| `GET {base}/api/pos-sync/customers/by-phone/{phone}` | A whole phone number typed in the customer search, or a customer registered |
| `GET {base}/api/pos-sync/customers/{loyaltyUserId}/points` | A linked customer looked up or put on a check, and before points are redeemed: their balance |

If the ordering system cannot be reached, the till goes on with what it knows: the customer as
the POS has them, and their balance as last seen (a redemption is checked against it). What was
earned and redeemed reaches the ordering system in `order.paid`, through the outbox.

## Costing without the link: the Excel sheet

**Shift & Z report → Costing sheet**, or **Integrations → Excel for Costing's import**,
downloads one business day (`GET /api/integrations/costing/sheet?date=yyyy-MM-dd`):

| Sheet | Columns | In Costing |
| --- | --- | --- |
| Daily Sales | `Item · الصنف` (code and name), `Quantity Sold · الكمية المباعة` | Sales → Import, as it is |
| Voids After Kitchen | Code, Item, Quantity, Amount, Made? (Waste / Back to stock), Reason, Authorised by, Check | Waste |
| Takings | Company, business day, checks paid, cash and Visa before tax, total tax collected, net sales, total with tax, staff meals, voids before and after the kitchen, void reasons | Financials → Takings in |

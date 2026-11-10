# The Integration Hub (ربط الأنظمة)

The POS links to three systems, each optional and each switched on in **Settings →
Integrations** with its URL, API key and branch code. The POS never reads or writes their
databases; it speaks HTTP to them, and the receiving side is theirs to build against this
contract. Nothing is queued for a link that is off, so switching one on later does not send it
the past.

| System | What it gets | What the POS asks of it |
| --- | --- | --- |
| Costing & Financials | `day.closed` at each Z close | Its menu (Pull menu) |
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
- `GET {base}/api/integrations/pos/menu` (Costing only): the menu, for **Pull menu**.

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
  "soldItems": [{ "code": 6101, "name": "Margherita", "size": "Large", "itemCode": "6101-17", "quantity": 1, "netAmount": 190.0 }],
  "waste": [{ "code": 9003, "name": "Soft drink", "size": null, "itemCode": "9003", "quantity": 1, "amount": 30.0, "reason": "Captain error" }],
  "returnedToStock": [{ "code": 7001, "name": "Classic burger", "size": null, "itemCode": "7001", "quantity": 1, "reason": "Customer changed mind" }],
  "takings": {
    "cash": 627.2, "card": 0, "tax": 87.81, "netSales": 627.2,
    "voidsBefore": { "count": 0, "amount": 0 },
    "voidsAfter": { "count": 1, "amount": 30.0, "reasons": [{ "reason": "Captain error", "count": 1, "amount": 30.0 }] },
    "paidOuts": 200, "staffMeals": 0
  }
}
```

`soldItems` is net of voids, one line per item and size. `itemCode` is the code Costing knows
it by: the item's number (`9003`), or for a size its code there (`6101-17`, item 6101's size 17),
which the size has once the menu is pulled from Costing. A size made here by hand has none, so
its `itemCode` is the item's number and Costing finds the size by its name (`size`). `waste` are
the voids after the kitchen that were already made (stock used, nothing sold);
`returnedToStock` the ones not yet made. In `takings`, `cash` and `card` are before tax (the tax
taken off in proportion), with `tax` apart.

Costing answers each `day.closed` with what it did (recorded, unchanged, updated), refuses one
it cannot place (an item not on its menu, or a day whose sales or takings were typed in there by
hand) with 422, and logs every call under its **Settings → POS Integration → Sync log**.

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

## Costing: the menu (سحب المنيو من التكاليف)

With the Costing link on, **Settings → Integrations → Costing → Pull menu** reads
`GET {base}/api/integrations/pos/menu`:

```json
{
  "atUtc": "2026-11-10T09:44:29Z",
  "categories": [{ "name": "Pizza", "nameAr": "بيتزا", "displayOrder": 1 }],
  "items": [{
    "code": 6101, "name": "Margherita", "nameAr": "مارجريتا", "category": "Pizza", "price": 190,
    "isAvailable": true, "pricedByAddOns": false, "hasRecipe": true,
    "sizes": [{ "code": "6101-17", "variantId": 17, "name": "Large", "nameAr": "كبير", "price": 190 },
              { "code": "6101-18", "variantId": 18, "name": "Medium", "nameAr": "وسط", "price": 140 }],
    "addOnCodes": []
  }],
  "addOns": [{ "code": "A3", "name": "Extra cheese", "nameAr": "جبنة زيادة", "price": 25 }]
}
```

- Categories are matched by name: a new one is added, a known one keeps its colour here.
- Items are matched by their number: a new one is added, a known one takes Costing's name,
  category, price and availability, and keeps its kitchen station and modifiers from here.
- Sizes are matched by their Costing code, then by name, so a size keeps its id here (and its past
  checks); each keeps its Costing code for the Z report.
- Costing's add-ons are not pulled: the modifiers here stay this POS's own.
- An item Costing no longer has is taken off the menu here, not deleted. One Costing prices by
  its add-ons (a kilo of mixed grill) has no price to ring up at, so it is left off.

Pull again whenever the menu changes in Costing. Without the link, the menu is kept here by hand
as before; an item or size added by hand is sent by its number and size name.

## Costing without the link: the Excel sheet

**Shift & Z report → Costing sheet**, or **Integrations → Excel for Costing's import**,
downloads one business day (`GET /api/integrations/costing/sheet?date=yyyy-MM-dd`):

| Sheet | Columns | In Costing |
| --- | --- | --- |
| Daily Sales | `Item · الصنف` (code and name; a size pulled from Costing by its code there, `6101-17`), `Quantity Sold · الكمية المباعة` | Sales → Import, as it is |
| Voids After Kitchen | Code, Item, Quantity, Amount, Made? (Waste / Back to stock), Reason, Authorised by, Check | Waste |
| Takings | Company, business day, checks paid, cash and Visa before tax, total tax collected, net sales, total with tax, staff meals, voids before and after the kitchen, void reasons | Financials → Takings in |

# Deploying to Railway

One service from this repository's `Dockerfile` (Railway finds it through `railway.json`), and a
PostgreSQL database beside it. The API serves the app and its own API on Railway's HTTPS domain.

## 1. The project and the database

1. New project → **Deploy from GitHub repo** → `wagdy/pos-stanalone`. Railway builds the `Dockerfile`.
2. In the same project: **New → Database → PostgreSQL**.

## 2. The service's variables

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (the database's own, by reference) |
| `Auth__SigningKey` | A secret of 32 bytes or more that you make: `openssl rand -base64 48`. Never commit it |
| `Auth__PinKey` | A second secret, for the PINs' keyed hashes: `openssl rand -base64 48`. Set it once and keep it: changing it makes every PIN stop working (the signing key is used when it is not set) |
| `Auth__FirstManager__Email`, `Auth__FirstManager__Name`, `Auth__FirstManager__Password`, `Auth__FirstManager__Pin` | The first manager, made on the first start when there is no user yet. Sign in, change the password on Your account, then delete `Auth__FirstManager__Password` and `Auth__FirstManager__Pin` |
| `Company__Name`, `Company__TimeZoneId`, `Company__WorkdayStartsAtHour`, `Company__Country`, `Company__CurrencySymbol`, `Company__CurrencyPosition` | Optional: the company's settings for the first start (else "My restaurant", Africa/Cairo, 4, Egypt, L.E before). A manager changes them on Company settings after |

`PORT` is Railway's own: the app listens on it. The image trusts the proxy's forwarded headers
(`ASPNETCORE_FORWARDEDHEADERS_ENABLED`), so the sign-in limits count each client's own address.
The migrations are applied on every start.

## 3. Networking

In the service's **Settings → Networking**: **Generate Domain** (HTTP). The app and its API are at
`https://<name>.up.railway.app`.

Railway checks `/health/ready` (the process is up and reaches its database) before it sends
traffic to a new deployment (`railway.json`).

## 4. The first sign-in

1. Sign in as the first manager (Manager: email and password), and change the password on Your
   account.
2. On **Company**: the restaurant's name, logo, currency and time zone.
3. On **Staff**: the cashiers, captains and kitchen, each with a PIN (or **Integrations → HR →
   Sync staff** to bring them from HR).
4. On **POS settings**: VAT, the service charge, the check's header and footer, loyalty points,
   the cashier's discount limit, void reasons and quick notes. On an empty system, **Load a
   sample restaurant** gives a menu and tables to start from.
5. **Menu** (stations, categories, items with their codes, as Costing knows them), **Tables**
   and **Printers**. A thermal printer on the restaurant's network cannot be reached from
   Railway: there, print through a browser print station, or run the POS on the restaurant's own
   machine (`docker run`), which reaches its printers on port 9100.
6. **Integrations**: Costing, online ordering & loyalty and HR, each with its URL, key and branch
   code, and Test.

## Before you rely on it

- **Backups:** Railway's PostgreSQL has its own backups; turn them on for the database.
- **One process:** the company's settings are held in memory by the process that saved them, and
  the live hub (`/hubs/pos`) and the print and sync workers run in it. Run one replica.
- **WebSockets:** the terminals, captains and kitchen screens hear changes over `/hubs/pos`;
  Railway's domains carry WebSockets as they are.

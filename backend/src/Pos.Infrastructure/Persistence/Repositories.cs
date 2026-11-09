using Microsoft.EntityFrameworkCore;
using Pos.Domain.Catalog;
using Pos.Domain.Customers;
using Pos.Domain.Floor;
using Pos.Domain.Integrations;
using Pos.Domain.Kitchen;
using Pos.Domain.Orders;
using Pos.Domain.Printing;
using Pos.Domain.Settings;
using Pos.Domain.Shifts;

namespace Pos.Infrastructure.Persistence;

internal sealed class KitchenStationRepository(PosDbContext db) : IKitchenStationRepository
{
    public Task<KitchenStation?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default) =>
        db.KitchenStations.SingleOrDefaultAsync(s => s.Id == id, cancellationToken);

    public void Add(KitchenStation aggregate) => db.KitchenStations.Add(aggregate);

    public async Task<IReadOnlyList<KitchenStation>> GetAllAsync(CancellationToken cancellationToken = default) =>
        await db.KitchenStations.ToListAsync(cancellationToken);

    public void Remove(KitchenStation station) => db.KitchenStations.Remove(station);
}

internal sealed class MenuCategoryRepository(PosDbContext db) : IMenuCategoryRepository
{
    public Task<MenuCategory?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default) =>
        db.MenuCategories.SingleOrDefaultAsync(c => c.Id == id, cancellationToken);

    public void Add(MenuCategory aggregate) => db.MenuCategories.Add(aggregate);

    public async Task<IReadOnlyList<MenuCategory>> GetAllAsync(CancellationToken cancellationToken = default) =>
        await db.MenuCategories.ToListAsync(cancellationToken);
}

internal sealed class MenuItemRepository(PosDbContext db) : IMenuItemRepository
{
    private IQueryable<MenuItem> Whole => db.MenuItems.Include(i => i.Sizes).Include(i => i.Modifiers);

    public Task<MenuItem?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default) =>
        Whole.SingleOrDefaultAsync(i => i.Id == id, cancellationToken);

    public void Add(MenuItem aggregate) => db.MenuItems.Add(aggregate);

    public async Task<IReadOnlyList<MenuItem>> GetAllAsync(CancellationToken cancellationToken = default) => await Whole.ToListAsync(cancellationToken);

    public async Task<IReadOnlyList<MenuItem>> GetManyAsync(IReadOnlyCollection<Guid> ids, CancellationToken cancellationToken = default) =>
        await Whole.Where(i => ids.Contains(i.Id)).ToListAsync(cancellationToken);

    public Task<bool> CodeTakenAsync(int code, Guid exceptId, CancellationToken cancellationToken = default) =>
        db.MenuItems.AnyAsync(i => i.Code == code && i.Id != exceptId, cancellationToken);
}

internal sealed class DiningZoneRepository(PosDbContext db) : IDiningZoneRepository
{
    public Task<DiningZone?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default) =>
        db.DiningZones.SingleOrDefaultAsync(z => z.Id == id, cancellationToken);

    public void Add(DiningZone aggregate) => db.DiningZones.Add(aggregate);

    public async Task<IReadOnlyList<DiningZone>> GetAllAsync(CancellationToken cancellationToken = default) =>
        await db.DiningZones.ToListAsync(cancellationToken);

    public void Remove(DiningZone zone) => db.DiningZones.Remove(zone);
}

internal sealed class DiningTableRepository(PosDbContext db) : IDiningTableRepository
{
    public Task<DiningTable?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default) =>
        db.DiningTables.SingleOrDefaultAsync(t => t.Id == id, cancellationToken);

    public void Add(DiningTable aggregate) => db.DiningTables.Add(aggregate);

    public async Task<IReadOnlyList<DiningTable>> GetAllAsync(CancellationToken cancellationToken = default) =>
        await db.DiningTables.ToListAsync(cancellationToken);

    public Task<bool> LabelTakenAsync(string label, Guid exceptId, CancellationToken cancellationToken = default) =>
        db.DiningTables.AnyAsync(t => t.Label == label && t.Id != exceptId, cancellationToken);

    public void Remove(DiningTable table) => db.DiningTables.Remove(table);
}

internal sealed class OrderRepository(PosDbContext db) : IOrderRepository
{
    private static readonly OrderStatus[] Open = [OrderStatus.Open, OrderStatus.BillPrinted];
    private static readonly OrderStatus[] ClosedUnpaid = [OrderStatus.Cancelled, OrderStatus.Merged];

    private IQueryable<Order> Whole => db.Orders.Include(o => o.Lines).Include(o => o.Voids).Include(o => o.Payments);

    public Task<Order?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default) =>
        Whole.SingleOrDefaultAsync(o => o.Id == id, cancellationToken);

    public void Add(Order aggregate) => db.Orders.Add(aggregate);

    public async Task<IReadOnlyList<Order>> GetOpenAsync(CancellationToken cancellationToken = default) =>
        await Whole.Where(o => Open.Contains(o.Status)).ToListAsync(cancellationToken);

    public async Task<IReadOnlyList<Order>> GetOpenOnTableAsync(Guid tableId, CancellationToken cancellationToken = default) =>
        await Whole.Where(o => o.TableId == tableId && Open.Contains(o.Status)).ToListAsync(cancellationToken);

    public async Task<IReadOnlyList<Order>> GetForDayAsync(DateOnly businessDate, CancellationToken cancellationToken = default) =>
        await Whole.Where(o => o.BusinessDate == businessDate).ToListAsync(cancellationToken);

    // Paid into the shift, and cancelled or merged while it was open: their voids are its.
    public async Task<IReadOnlyList<Order>> GetForShiftAsync(Guid shiftId, CancellationToken cancellationToken = default)
    {
        var shift = await db.Shifts.AsNoTracking().Where(s => s.Id == shiftId).Select(s => new { s.OpenedAtUtc, s.ClosedAtUtc })
            .SingleOrDefaultAsync(cancellationToken);
        if (shift is null)
            return [];
        var until = shift.ClosedAtUtc ?? DateTime.UtcNow.AddMinutes(1);
        return await Whole.Where(o => o.ShiftId == shiftId
                || (ClosedUnpaid.Contains(o.Status) && o.ClosedAtUtc >= shift.OpenedAtUtc && o.ClosedAtUtc < until))
            .ToListAsync(cancellationToken);
    }

    public async Task<int> NextNumberAsync(DateOnly businessDate, CancellationToken cancellationToken = default)
    {
        var saved = await db.Orders.Where(o => o.BusinessDate == businessDate).MaxAsync(o => (int?)o.Number, cancellationToken) ?? 0;
        var unsaved = db.Orders.Local.Where(o => o.BusinessDate == businessDate).Select(o => o.Number).DefaultIfEmpty(0).Max();
        return Math.Max(saved, unsaved) + 1;
    }
}

internal sealed class KitchenTicketRepository(PosDbContext db) : IKitchenTicketRepository
{
    private IQueryable<KitchenTicket> Whole => db.KitchenTickets.Include(t => t.Lines);

    public Task<KitchenTicket?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default) =>
        Whole.SingleOrDefaultAsync(t => t.Id == id, cancellationToken);

    public void Add(KitchenTicket aggregate) => db.KitchenTickets.Add(aggregate);

    // A ticket left undone for two days is no longer the kitchen's to make.
    public async Task<IReadOnlyList<KitchenTicket>> GetActiveAsync(CancellationToken cancellationToken = default)
    {
        var since = DateTime.UtcNow.AddDays(-2);
        return await Whole.Where(t => t.CreatedAtUtc >= since && t.Lines.Any(l => l.DoneAtUtc == null)).ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<KitchenTicket>> GetForOrderAsync(Guid orderId, CancellationToken cancellationToken = default) =>
        await Whole.Where(t => t.OrderId == orderId).ToListAsync(cancellationToken);

    public async Task<IReadOnlyList<KitchenTicket>> GetRecentlyDoneAsync(DateTime sinceUtc, CancellationToken cancellationToken = default) =>
        await Whole.Where(t => t.Lines.Any(l => l.DoneAtUtc >= sinceUtc)).ToListAsync(cancellationToken);

    public async Task<int> NextNumberAsync(DateOnly businessDate, CancellationToken cancellationToken = default) =>
        (await db.KitchenTickets.Where(t => t.BusinessDate == businessDate).MaxAsync(t => (int?)t.Number, cancellationToken) ?? 0) + 1;
}

internal sealed class CustomerRepository(PosDbContext db) : ICustomerRepository
{
    public Task<Customer?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default) =>
        db.Customers.SingleOrDefaultAsync(c => c.Id == id, cancellationToken);

    public void Add(Customer aggregate) => db.Customers.Add(aggregate);

    public Task<Customer?> GetByPhoneAsync(string phone, CancellationToken cancellationToken = default) =>
        db.Customers.SingleOrDefaultAsync(c => c.Phone == phone, cancellationToken);

    public Task<Customer?> GetByLoyaltyIdAsync(string loyaltyUserId, CancellationToken cancellationToken = default) =>
        db.Customers.SingleOrDefaultAsync(c => c.LoyaltyUserId == loyaltyUserId, cancellationToken);

    public async Task<IReadOnlyList<Customer>> SearchAsync(string text, int take, CancellationToken cancellationToken = default)
    {
        var trimmed = text.Trim();
        var digits = new string(trimmed.Where(char.IsAsciiDigit).ToArray());
        var pattern = $"%{trimmed.Replace("%", "").Replace("_", "")}%";
        var phoneOnly = digits.Length >= 3 && trimmed.All(c => char.IsAsciiDigit(c) || c is ' ' or '+' or '-');
        var query = phoneOnly ? db.Customers.Where(c => c.Phone.Contains(digits))
            : digits.Length >= 3 ? db.Customers.Where(c => EF.Functions.ILike(c.Name, pattern) || c.Phone.Contains(digits))
            : db.Customers.Where(c => EF.Functions.ILike(c.Name, pattern));
        return await query.OrderBy(c => c.Name).Take(take).ToListAsync(cancellationToken);
    }
}

internal sealed class ShiftRepository(PosDbContext db) : IShiftRepository
{
    private IQueryable<Shift> Whole => db.Shifts.Include(s => s.PaidOuts);

    public Task<Shift?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default) => Whole.SingleOrDefaultAsync(s => s.Id == id, cancellationToken);

    public void Add(Shift aggregate) => db.Shifts.Add(aggregate);

    public Task<Shift?> GetOpenAsync(CancellationToken cancellationToken = default) =>
        Whole.SingleOrDefaultAsync(s => s.Status == ShiftStatus.Open, cancellationToken);

    public async Task<IReadOnlyList<Shift>> GetRecentAsync(int take, CancellationToken cancellationToken = default) =>
        await Whole.OrderByDescending(s => s.Number).Take(take).ToListAsync(cancellationToken);

    public async Task<int> NextNumberAsync(CancellationToken cancellationToken = default) =>
        (await db.Shifts.MaxAsync(s => (int?)s.Number, cancellationToken) ?? 0) + 1;
}

internal sealed class ClockEventRepository(PosDbContext db) : IClockEventRepository
{
    public Task<ClockEvent?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default) =>
        db.ClockEvents.SingleOrDefaultAsync(c => c.Id == id, cancellationToken);

    public void Add(ClockEvent aggregate) => db.ClockEvents.Add(aggregate);

    public Task<ClockEvent?> GetLastAsync(string userId, CancellationToken cancellationToken = default) =>
        db.ClockEvents.Where(c => c.UserId == userId).OrderByDescending(c => c.AtUtc).FirstOrDefaultAsync(cancellationToken);

    public async Task<IReadOnlyList<ClockEvent>> GetSinceAsync(DateTime sinceUtc, CancellationToken cancellationToken = default) =>
        await db.ClockEvents.Where(c => c.AtUtc >= sinceUtc).OrderByDescending(c => c.AtUtc).ToListAsync(cancellationToken);
}

internal sealed class PrinterRepository(PosDbContext db) : IPrinterRepository
{
    public Task<Printer?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default) =>
        db.Printers.SingleOrDefaultAsync(p => p.Id == id, cancellationToken);

    public void Add(Printer aggregate) => db.Printers.Add(aggregate);

    public async Task<IReadOnlyList<Printer>> GetAllAsync(CancellationToken cancellationToken = default) => await db.Printers.ToListAsync(cancellationToken);

    public void Remove(Printer printer) => db.Printers.Remove(printer);
}

internal sealed class PosSettingsStore(PosDbContext db) : IPosSettingsStore
{
    public async Task<PosSettings> GetAsync(CancellationToken cancellationToken = default) =>
        db.PosSettings.Local.FirstOrDefault()
        ?? await db.PosSettings.AsNoTracking().SingleOrDefaultAsync(cancellationToken)
        ?? PosSettings.Defaults();

    public async Task<PosSettings> GetForUpdateAsync(CancellationToken cancellationToken = default)
    {
        var settings = await db.PosSettings.SingleOrDefaultAsync(cancellationToken);
        if (settings is null)
            db.PosSettings.Add(settings = PosSettings.Defaults());
        return settings;
    }
}

internal sealed class IntegrationStore(PosDbContext db) : IIntegrationStore
{
    public async Task<IntegrationLink> GetAsync(LinkedSystem system, CancellationToken cancellationToken = default)
    {
        var link = db.IntegrationLinks.Local.FirstOrDefault(l => l.System == system)
            ?? await db.IntegrationLinks.SingleOrDefaultAsync(l => l.System == system, cancellationToken);
        if (link is null)
            db.IntegrationLinks.Add(link = new IntegrationLink(system));
        return link;
    }

    public async Task<IReadOnlyList<IntegrationLink>> GetAllAsync(CancellationToken cancellationToken = default)
    {
        var saved = await db.IntegrationLinks.ToListAsync(cancellationToken);
        return Enum.GetValues<LinkedSystem>().Select(s => saved.FirstOrDefault(l => l.System == s) ?? new IntegrationLink(s)).ToList();
    }
}

internal sealed class SyncQueue(PosDbContext db) : ISyncQueue
{
    public async Task EnqueueAsync(SyncItem item, CancellationToken cancellationToken = default)
    {
        if (db.SyncQueue.Local.Any(i => i.Id == item.Id) || await db.SyncQueue.AnyAsync(i => i.Id == item.Id, cancellationToken))
            return;
        db.SyncQueue.Add(item);
    }

    public Task<SyncItem?> GetAsync(Guid id, CancellationToken cancellationToken = default) =>
        db.SyncQueue.SingleOrDefaultAsync(i => i.Id == id, cancellationToken);

    public async Task<IReadOnlyList<SyncItem>> GetDueAsync(int take, CancellationToken cancellationToken = default)
    {
        var now = DateTime.UtcNow;
        return await db.SyncQueue.Where(i => i.Status == SyncStatus.Pending && i.NextAttemptAtUtc <= now)
            .OrderBy(i => i.CreatedAtUtc).Take(take).ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<SyncItem>> GetRecentAsync(int take, CancellationToken cancellationToken = default) =>
        await db.SyncQueue.OrderByDescending(i => i.CreatedAtUtc).Take(take).ToListAsync(cancellationToken);

    public async Task<(int Pending, int Failed)> CountAsync(CancellationToken cancellationToken = default)
    {
        var counts = await db.SyncQueue.Where(i => i.Status != SyncStatus.Sent).GroupBy(i => i.Status)
            .Select(g => new { g.Key, Count = g.Count() }).ToListAsync(cancellationToken);
        return (counts.FirstOrDefault(c => c.Key == SyncStatus.Pending)?.Count ?? 0, counts.FirstOrDefault(c => c.Key == SyncStatus.Failed)?.Count ?? 0);
    }
}

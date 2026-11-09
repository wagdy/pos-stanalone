using MediatR;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Pos.Application;
using Pos.Application.Common;
using Pos.Application.Integrations;
using Pos.Domain.Access;
using Pos.Domain.Catalog;
using Pos.Domain.Common;
using Pos.Domain.Company;
using Pos.Domain.Customers;
using Pos.Domain.Floor;
using Pos.Domain.Integrations;
using Pos.Domain.Kitchen;
using Pos.Domain.Orders;
using Pos.Domain.Printing;
using Pos.Domain.Settings;
using Pos.Domain.Shifts;

namespace Pos.Application.Tests;

// The use cases wired as the API wires them, over stores in memory. What was printed, told to the
// screens and queued for the linked systems is kept to look at.
public sealed class TestPos
{
    public static readonly Actor Manager = new("boss", "Boss", UserRole.Manager);
    public static readonly Actor Cashier = new("mona", "Mona", UserRole.Cashier);
    public static readonly Actor Captain = new("ali", "Ali", UserRole.Captain);

    private readonly ServiceProvider _services;

    public Stores Store { get; } = new();
    public RecordingNotifier Told { get; } = new();
    public RecordingSpooler Printed { get; } = new();
    public FakeLoyalty Loyalty { get; } = new();
    public FakeStaff Staff { get; } = new();

    public TestPos()
    {
        var services = new ServiceCollection();
        services.AddSingleton(typeof(ILogger<>), typeof(NullLogger<>));
        services.AddPosApplication();
        services.AddSingleton<IUnitOfWork>(new NoUnitOfWork());
        services.AddSingleton<IBusinessCalendar>(new UtcCalendar());
        services.AddSingleton<IKitchenStationRepository>(Store.Stations);
        services.AddSingleton<IMenuCategoryRepository>(Store.Categories);
        services.AddSingleton<IMenuItemRepository>(Store.Items);
        services.AddSingleton<IDiningZoneRepository>(Store.Zones);
        services.AddSingleton<IDiningTableRepository>(Store.Tables);
        services.AddSingleton<IOrderRepository>(Store.Orders);
        services.AddSingleton<IKitchenTicketRepository>(Store.Tickets);
        services.AddSingleton<ICustomerRepository>(Store.Customers);
        services.AddSingleton<IShiftRepository>(Store.Shifts);
        services.AddSingleton<IClockEventRepository>(Store.Clock);
        services.AddSingleton<IPrinterRepository>(Store.Printers);
        services.AddSingleton<IPosSettingsStore>(Store.Settings);
        services.AddSingleton<IIntegrationStore>(Store.Links);
        services.AddSingleton<ISyncQueue>(Store.Queue);
        services.AddSingleton<ISyncHealth>(new NoHealth());
        services.AddSingleton<IPosNotifier>(Told);
        services.AddSingleton<IPrintSpooler>(Printed);
        services.AddSingleton<ILoyaltyGateway>(Loyalty);
        services.AddSingleton<IStaffDirectory>(Staff);
        services.AddSingleton<ILinkGateway>(new NoGateway());
        services.AddSingleton<ICompanyProfile>(new Profile());
        services.AddSingleton<ICompanySettingsStore>(new CompanyStore());
        _services = services.BuildServiceProvider(new ServiceProviderOptions { ValidateScopes = true, ValidateOnBuild = true });
    }

    public async Task<T> Send<T>(IRequest<T> request)
    {
        using var scope = _services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<ISender>().Send(request);
    }

    public async Task Send(IRequest request)
    {
        using var scope = _services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<ISender>().Send(request);
    }

    private sealed class NoUnitOfWork : IUnitOfWork
    {
        public Task<int> SaveChangesAsync(CancellationToken cancellationToken = default) => Task.FromResult(1);
    }

    private sealed class Profile : ICompanyProfile
    {
        public CompanyProfile Current { get; private set; } =
            new("Test restaurant", new MoneyFormat("L.E", CurrencyPosition.Before), Country.Egypt, "UTC", 0, false, null);
        public void Set(CompanyProfile profile) => Current = profile;
    }

    private sealed class CompanyStore : ICompanySettingsStore
    {
        private CompanySettings? _settings;
        public Task<CompanySettings?> GetAsync(CancellationToken cancellationToken = default) => Task.FromResult(_settings);
        public void Add(CompanySettings settings) => _settings = settings;
        public Task PutLogoAsync(byte[]? content, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task<byte[]?> GetLogoAsync(CancellationToken cancellationToken = default) => Task.FromResult<byte[]?>(null);
    }

    private sealed class NoHealth : ISyncHealth
    {
        public bool LastSendFailed => false;
        public DateTime? LastSentAtUtc => null;
        public void Wake() { }
    }

    private sealed class NoGateway : ILinkGateway
    {
        public Task<LinkTestResult> TestAsync(IntegrationLink link, CancellationToken cancellationToken = default) => Task.FromResult(new LinkTestResult(true, "ok"));
        public Task SendAsync(IntegrationLink link, SyncItem item, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task<IReadOnlyList<HrStaffMember>> HrStaffAsync(IntegrationLink link, CancellationToken cancellationToken = default) =>
            Task.FromResult<IReadOnlyList<HrStaffMember>>([]);
    }
}

public sealed class UtcCalendar : IBusinessCalendar
{
    public DateOnly BusinessDateOf(DateTime utc) => DateOnly.FromDateTime(utc);
    public DateOnly LocalDateOf(DateTime utc) => DateOnly.FromDateTime(utc);
    public DateTime ToLocal(DateTime utc) => utc;
    public DateTime ToUtc(DateTime local) => DateTime.SpecifyKind(local, DateTimeKind.Utc);
    public (DateTime FromUtc, DateTime ToUtc) Bounds(DateOnly businessDate)
    {
        var start = businessDate.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
        return (start, start.AddDays(1));
    }
}

public sealed class RecordingNotifier : IPosNotifier
{
    public List<string> Said { get; } = [];
    public Task OrdersChangedAsync(IReadOnlyCollection<Guid> orderIds, CancellationToken cancellationToken = default) => Say("orders");
    public Task FloorChangedAsync(CancellationToken cancellationToken = default) => Say("floor");
    public Task KitchenChangedAsync(CancellationToken cancellationToken = default) => Say("kitchen");
    public Task ShiftChangedAsync(CancellationToken cancellationToken = default) => Say("shift");
    public Task SyncChangedAsync(CancellationToken cancellationToken = default) => Say("sync");
    public Task MenuChangedAsync(CancellationToken cancellationToken = default) => Say("menu");
    public Task PrintRequestedAsync(BrowserPrintJob job, CancellationToken cancellationToken = default) => Say("print");

    private Task Say(string what)
    {
        Said.Add(what);
        return Task.CompletedTask;
    }
}

public sealed class RecordingSpooler : IPrintSpooler
{
    public List<PrintRequest> Requests { get; } = [];

    public Task PrintAsync(IReadOnlyList<PrintRequest> requests, CancellationToken cancellationToken = default)
    {
        Requests.AddRange(requests);
        return Task.CompletedTask;
    }
}

public sealed class FakeLoyalty : ILoyaltyGateway
{
    public bool IsEnabled { get; set; }
    public bool Offline { get; set; }
    public Dictionary<string, LoyaltyCustomer> ByPhone { get; } = [];

    public Task<LoyaltyCustomer?> FindByPhoneAsync(string phone, CancellationToken cancellationToken = default) =>
        Offline ? throw new LinkUnavailableException("offline") : Task.FromResult(ByPhone.GetValueOrDefault(phone));

    public Task<int> PointsAsync(string loyaltyUserId, CancellationToken cancellationToken = default) =>
        Offline ? throw new LinkUnavailableException("offline") : Task.FromResult(ByPhone.Values.Single(c => c.UserId == loyaltyUserId).Points);

    public Task RedeemAsync(string loyaltyUserId, int points, Guid orderId, CancellationToken cancellationToken = default) => Task.CompletedTask;
}

public sealed class FakeStaff : IStaffDirectory
{
    public Dictionary<string, StaffMember> ByPin { get; } = new() { ["1234"] = new("boss", "Boss", UserRole.Manager), ["2222"] = new("mona", "Mona", UserRole.Cashier) };

    public Task<StaffMember?> ByPinAsync(string? pin, CancellationToken cancellationToken = default) => Task.FromResult(ByPin.GetValueOrDefault(pin ?? ""));

    public Task<IReadOnlyList<StaffMember>> ActiveAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<StaffMember>>(ByPin.Values.ToList());
}

public class ListStore<T> : IRepository<T> where T : AggregateRoot
{
    public List<T> All { get; } = [];
    public Task<T?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default) => Task.FromResult(All.SingleOrDefault(x => x.Id == id));
    public void Add(T aggregate) => All.Add(aggregate);
    public void Remove(T aggregate) => All.Remove(aggregate);
    public Task<IReadOnlyList<T>> GetAllAsync(CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyList<T>>(All.ToList());
}

public sealed class Stores
{
    public StationStore Stations { get; } = new();
    public CategoryStore Categories { get; } = new();
    public ItemStore Items { get; } = new();
    public ZoneStore Zones { get; } = new();
    public TableStore Tables { get; } = new();
    public OrderStore Orders { get; } = new();
    public TicketStore Tickets { get; } = new();
    public CustomerStore Customers { get; } = new();
    public ShiftStore Shifts { get; } = new();
    public ClockStore Clock { get; } = new();
    public PrinterStore Printers { get; } = new();
    public SettingsStore Settings { get; } = new();
    public LinkStore Links { get; } = new();
    public QueueStore Queue { get; } = new();
}

public sealed class StationStore : ListStore<KitchenStation>, IKitchenStationRepository;

public sealed class CategoryStore : ListStore<MenuCategory>, IMenuCategoryRepository;

public sealed class ItemStore : ListStore<MenuItem>, IMenuItemRepository
{
    public Task<IReadOnlyList<MenuItem>> GetManyAsync(IReadOnlyCollection<Guid> ids, CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<MenuItem>>(All.Where(i => ids.Contains(i.Id)).ToList());
    public Task<bool> CodeTakenAsync(int code, Guid exceptId, CancellationToken cancellationToken = default) =>
        Task.FromResult(All.Any(i => i.Code == code && i.Id != exceptId));
}

public sealed class ZoneStore : ListStore<DiningZone>, IDiningZoneRepository;

public sealed class TableStore : ListStore<DiningTable>, IDiningTableRepository
{
    public Task<bool> LabelTakenAsync(string label, Guid exceptId, CancellationToken cancellationToken = default) =>
        Task.FromResult(All.Any(t => t.Label == label && t.Id != exceptId));
}

public sealed class OrderStore : ListStore<Order>, IOrderRepository
{
    public Task<IReadOnlyList<Order>> GetOpenAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<Order>>(All.Where(o => !o.IsClosed).ToList());
    public Task<IReadOnlyList<Order>> GetOpenOnTableAsync(Guid tableId, CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<Order>>(All.Where(o => !o.IsClosed && o.TableId == tableId).ToList());
    public Task<IReadOnlyList<Order>> GetForDayAsync(DateOnly businessDate, CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<Order>>(All.Where(o => o.BusinessDate == businessDate).ToList());
    public Task<IReadOnlyList<Order>> GetForShiftAsync(Guid shiftId, CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<Order>>(All.Where(o => o.ShiftId == shiftId || o.Status is OrderStatus.Cancelled or OrderStatus.Merged).ToList());
    public Task<int> NextNumberAsync(DateOnly businessDate, CancellationToken cancellationToken = default) =>
        Task.FromResult(All.Where(o => o.BusinessDate == businessDate).Select(o => o.Number).DefaultIfEmpty(0).Max() + 1);
}

public sealed class TicketStore : ListStore<KitchenTicket>, IKitchenTicketRepository
{
    public Task<IReadOnlyList<KitchenTicket>> GetActiveAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<KitchenTicket>>(All.Where(t => !t.IsDone).ToList());
    public Task<IReadOnlyList<KitchenTicket>> GetForOrderAsync(Guid orderId, CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<KitchenTicket>>(All.Where(t => t.OrderId == orderId).ToList());
    public Task<IReadOnlyList<KitchenTicket>> GetRecentlyDoneAsync(DateTime sinceUtc, CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<KitchenTicket>>(All.Where(t => t.Lines.Any(l => l.DoneAtUtc >= sinceUtc)).ToList());
    public Task<int> NextNumberAsync(DateOnly businessDate, CancellationToken cancellationToken = default) =>
        Task.FromResult(All.Where(t => t.BusinessDate == businessDate).Select(t => t.Number).DefaultIfEmpty(0).Max() + 1);
}

public sealed class CustomerStore : ListStore<Customer>, ICustomerRepository
{
    public Task<Customer?> GetByPhoneAsync(string phone, CancellationToken cancellationToken = default) => Task.FromResult(All.SingleOrDefault(c => c.Phone == phone));
    public Task<Customer?> GetByLoyaltyIdAsync(string loyaltyUserId, CancellationToken cancellationToken = default) =>
        Task.FromResult(All.SingleOrDefault(c => c.LoyaltyUserId == loyaltyUserId));
    public Task<IReadOnlyList<Customer>> SearchAsync(string text, int take, CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<Customer>>(All.Where(c => c.Name.Contains(text, StringComparison.OrdinalIgnoreCase) || c.Phone.Contains(text)).Take(take).ToList());
}

public sealed class ShiftStore : ListStore<Shift>, IShiftRepository
{
    public Task<Shift?> GetOpenAsync(CancellationToken cancellationToken = default) => Task.FromResult(All.SingleOrDefault(s => s.Status == ShiftStatus.Open));
    public Task<IReadOnlyList<Shift>> GetRecentAsync(int take, CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<Shift>>(All.OrderByDescending(s => s.Number).Take(take).ToList());
    public Task<int> NextNumberAsync(CancellationToken cancellationToken = default) => Task.FromResult(All.Count + 1);
}

public sealed class ClockStore : ListStore<ClockEvent>, IClockEventRepository
{
    public Task<ClockEvent?> GetLastAsync(string userId, CancellationToken cancellationToken = default) =>
        Task.FromResult(All.Where(c => c.UserId == userId).OrderBy(c => c.AtUtc).LastOrDefault());
    public Task<IReadOnlyList<ClockEvent>> GetSinceAsync(DateTime sinceUtc, CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<ClockEvent>>(All.Where(c => c.AtUtc >= sinceUtc).ToList());
}

public sealed class PrinterStore : ListStore<Printer>, IPrinterRepository;

public sealed class SettingsStore : IPosSettingsStore
{
    public PosSettings Settings { get; } = PosSettings.Defaults();
    public Task<PosSettings> GetAsync(CancellationToken cancellationToken = default) => Task.FromResult(Settings);
    public Task<PosSettings> GetForUpdateAsync(CancellationToken cancellationToken = default) => Task.FromResult(Settings);
}

public sealed class LinkStore : IIntegrationStore
{
    public Dictionary<LinkedSystem, IntegrationLink> Links { get; } = Enum.GetValues<LinkedSystem>().ToDictionary(s => s, s => new IntegrationLink(s));
    public Task<IntegrationLink> GetAsync(LinkedSystem system, CancellationToken cancellationToken = default) => Task.FromResult(Links[system]);
    public Task<IReadOnlyList<IntegrationLink>> GetAllAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<IntegrationLink>>(Links.Values.ToList());
    public void SwitchOn(LinkedSystem system) => Links[system].Update(true, $"https://{system.ToString().ToLowerInvariant()}.example.com", "key", "BR1", "Boss");
}

public sealed class QueueStore : ISyncQueue
{
    public List<SyncItem> Items { get; } = [];
    public Task EnqueueAsync(SyncItem item, CancellationToken cancellationToken = default)
    {
        if (Items.All(i => i.Id != item.Id))
            Items.Add(item);
        return Task.CompletedTask;
    }
    public Task<SyncItem?> GetAsync(Guid id, CancellationToken cancellationToken = default) => Task.FromResult(Items.SingleOrDefault(i => i.Id == id));
    public Task<IReadOnlyList<SyncItem>> GetDueAsync(int take, CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<SyncItem>>(Items.Where(i => i.Status == SyncStatus.Pending).Take(take).ToList());
    public Task<IReadOnlyList<SyncItem>> GetRecentAsync(int take, CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<SyncItem>>(Items.AsEnumerable().Reverse().Take(take).ToList());
    public Task<(int Pending, int Failed)> CountAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult((Items.Count(i => i.Status == SyncStatus.Pending), Items.Count(i => i.Status == SyncStatus.Failed)));
}

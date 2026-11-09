using Pos.Domain.Common;
using Pos.Domain.Orders;

namespace Pos.Domain.Kitchen;

public enum TicketKind
{
    // A check's first ticket (بون المطبخ).
    New = 1,

    // Items added after the first ticket: only what is new (بون إلحاقي).
    AddOn = 2,

    // Items voided after they reached the kitchen: stop making them (بون إلغاء).
    Void = 3,

    // The check moved to another table, or merged into one (نقل ترابيزة).
    Transfer = 4,
}

// A kitchen order ticket (KOT): numbered from 1 each business day, it tells each station what to
// make for a check, or to stop making it, or where the check went. It prints on each station's
// printer and stays on the kitchen screen until each station bumps its part (done).
public sealed class KitchenTicket : AggregateRoot
{
    private readonly List<KitchenTicketLine> _lines = [];

    private KitchenTicket() { }

    public KitchenTicket(Guid id, int number, DateOnly businessDate, TicketKind kind, Order order, string createdBy, string? note = null)
    {
        Id = id;
        Number = number;
        BusinessDate = businessDate;
        Kind = kind;
        OrderId = order.Id;
        OrderNumber = order.Number;
        OrderType = order.Type;
        TableLabel = order.TableLabel;
        CheckLabel = order.CheckLabel;
        Guests = order.Guests;
        CreatedBy = createdBy;
        CreatedAtUtc = DateTime.UtcNow;
        Note = Catalog.Names.Optional(note, 300);
    }

    public int Number { get; private set; }
    public DateOnly BusinessDate { get; private set; }
    public TicketKind Kind { get; private set; }
    public Guid OrderId { get; private set; }
    public int OrderNumber { get; private set; }
    public OrderType OrderType { get; private set; }
    public string? TableLabel { get; private set; }
    public string? CheckLabel { get; private set; }
    public int Guests { get; private set; }
    public string CreatedBy { get; private set; } = string.Empty;
    public DateTime CreatedAtUtc { get; private set; }

    // The void's reason, or where the check moved: "From table 4 to table 7".
    public string? Note { get; private set; }

    public IReadOnlyList<KitchenTicketLine> Lines => _lines.OrderBy(l => l.Position).ToList().AsReadOnly();

    public bool IsDone => _lines.All(l => l.DoneAtUtc is not null);

    public void Add(Guid lineId, OrderLine line, int quantity) =>
        _lines.Add(new KitchenTicketLine(Id, lineId, line, quantity, _lines.Count));

    // A station's part, done: made, or a void or transfer seen. The order lines it made.
    public IReadOnlyList<Guid> Bump(Guid? stationId, DateTime atUtc)
    {
        var mine = _lines.Where(l => l.StationId == stationId && l.DoneAtUtc is null).ToList();
        foreach (var line in mine)
            line.Done(atUtc);
        return Kind is TicketKind.New or TicketKind.AddOn ? mine.Select(l => l.OrderLineId).ToList() : [];
    }

    // Back on the screen: bumped by mistake.
    public void Recall(Guid? stationId)
    {
        foreach (var line in _lines.Where(l => l.StationId == stationId))
            line.Undone();
    }
}

public sealed class KitchenTicketLine : Entity
{
    private KitchenTicketLine() { }

    internal KitchenTicketLine(Guid ticketId, Guid id, OrderLine line, int quantity, int position)
    {
        Id = id;
        TicketId = ticketId;
        OrderLineId = line.Id;
        StationId = line.StationId;
        StationName = line.StationName;
        Code = line.Code;
        Name = line.Name;
        NameAr = line.NameAr;
        SizeName = line.SizeName;
        Modifiers = line.Modifiers;
        Notes = line.Notes;
        Quantity = quantity;
        Position = position;
    }

    public Guid TicketId { get; private set; }
    public Guid OrderLineId { get; private set; }
    public Guid? StationId { get; private set; }
    public string? StationName { get; private set; }
    public int Code { get; private set; }
    public string Name { get; private set; } = string.Empty;
    public string? NameAr { get; private set; }
    public string? SizeName { get; private set; }
    public string Modifiers { get; private set; } = string.Empty;
    public string? Notes { get; private set; }
    public int Quantity { get; private set; }
    public int Position { get; private set; }
    public DateTime? DoneAtUtc { get; private set; }

    internal void Done(DateTime atUtc) => DoneAtUtc ??= atUtc;

    internal void Undone() => DoneAtUtc = null;
}

public interface IKitchenTicketRepository : IRepository<KitchenTicket>
{
    // Not done at every station: what the kitchen screen shows.
    Task<IReadOnlyList<KitchenTicket>> GetActiveAsync(CancellationToken cancellationToken = default);

    Task<IReadOnlyList<KitchenTicket>> GetForOrderAsync(Guid orderId, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<KitchenTicket>> GetRecentlyDoneAsync(DateTime sinceUtc, CancellationToken cancellationToken = default);

    Task<int> NextNumberAsync(DateOnly businessDate, CancellationToken cancellationToken = default);
}

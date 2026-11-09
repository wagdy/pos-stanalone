using Pos.Domain.Catalog;
using Pos.Domain.Common;

namespace Pos.Domain.Floor;

// An area of the restaurant (صالة): the main hall, the terrace, upstairs.
public sealed class DiningZone : AggregateRoot
{
    private DiningZone() { }

    public DiningZone(Guid id, string name, string? nameAr, int sortOrder)
    {
        Id = id;
        Update(name, nameAr, sortOrder);
    }

    public string Name { get; private set; } = string.Empty;
    public string? NameAr { get; private set; }
    public int SortOrder { get; private set; }

    public void Update(string name, string? nameAr, int sortOrder)
    {
        Name = Names.Required(name, 80, "Name the area: Hall, Terrace. · اسم الصالة.");
        NameAr = Names.Optional(nameAr, 80);
        SortOrder = sortOrder;
    }
}

public enum TableShape
{
    Square = 1,
    Round = 2,
    Long = 3,
}

// A table (ترابيزة) in an area: its label as the staff call it ("12", "T3"), its seats, and where
// it stands on the floor plan, in a grid of 12 columns. Whether it is free, taken or waiting for
// its bill is what its open checks say; it is never stored here.
public sealed class DiningTable : AggregateRoot
{
    public const int GridColumns = 12;

    private DiningTable() { }

    public DiningTable(Guid id, Guid zoneId, string label, int seats, int x, int y, TableShape shape = TableShape.Square)
    {
        Id = id;
        Update(zoneId, label, seats, x, y, shape, true);
    }

    public Guid ZoneId { get; private set; }
    public string Label { get; private set; } = string.Empty;
    public int Seats { get; private set; }
    public int X { get; private set; }
    public int Y { get; private set; }
    public TableShape Shape { get; private set; } = TableShape.Square;
    public bool IsActive { get; private set; } = true;

    public void Update(Guid zoneId, string label, int seats, int x, int y, TableShape shape, bool isActive)
    {
        if (zoneId == Guid.Empty)
            throw new DomainException("Choose the table's area. · اختر الصالة.");
        if (seats is < 1 or > 40)
            throw new DomainException("A table seats 1 to 40. · عدد الكراسي من 1 إلى 40.");
        if (x is < 0 or >= GridColumns || y is < 0 or > 200)
            throw new DomainException("Place the table on the floor plan. · حدد مكان الترابيزة.");
        if (!Enum.IsDefined(shape))
            throw new DomainException("Choose the table's shape.");
        ZoneId = zoneId;
        Label = Names.Required(label, 16, "Label the table: 12, T3. · رقم الترابيزة.");
        Seats = seats;
        X = x;
        Y = y;
        Shape = shape;
        IsActive = isActive;
    }
}

public interface IDiningZoneRepository : IRepository<DiningZone>
{
    Task<IReadOnlyList<DiningZone>> GetAllAsync(CancellationToken cancellationToken = default);

    void Remove(DiningZone zone);
}

public interface IDiningTableRepository : IRepository<DiningTable>
{
    Task<IReadOnlyList<DiningTable>> GetAllAsync(CancellationToken cancellationToken = default);

    Task<bool> LabelTakenAsync(string label, Guid exceptId, CancellationToken cancellationToken = default);

    void Remove(DiningTable table);
}

using Pos.Domain.Catalog;
using Pos.Domain.Common;

namespace Pos.Domain.Shifts;

public enum ShiftStatus
{
    Open = 1,
    Closed = 2,
}

// What a paid-out from the drawer was for.
public enum PaidOutKind
{
    // A small expense paid in cash: ice, gas, a repair (مصروف).
    Expense = 1,

    // An advance to a member of staff, deducted from their pay (سلفة).
    StaffAdvance = 2,

    // Cash handed to a delivery driver: change, fuel (عهدة سائق).
    Driver = 3,
}

// The cashier's shift (الوردية): the drawer opened with its float, paid-outs taken from it, and
// closed with the cash counted. Every check paid while it is open is its; its Z report, worked out
// as it closes, is kept with it as it was.
public sealed class Shift : AggregateRoot
{
    private readonly List<PaidOut> _paidOuts = [];

    private Shift() { }

    public Shift(Guid id, int number, DateOnly businessDate, decimal openingFloat, string openedById, string openedBy)
    {
        if (openingFloat < 0)
            throw new DomainException("The opening float is zero or more. · العهدة صفر أو أكثر.");
        Id = id;
        Number = number;
        BusinessDate = businessDate;
        OpeningFloat = Math.Round(openingFloat, 2, MidpointRounding.AwayFromZero);
        OpenedById = openedById;
        OpenedBy = openedBy;
        OpenedAtUtc = DateTime.UtcNow;
        Status = ShiftStatus.Open;
    }

    public int Number { get; private set; }
    public DateOnly BusinessDate { get; private set; }
    public ShiftStatus Status { get; private set; }
    public decimal OpeningFloat { get; private set; }
    public string OpenedById { get; private set; } = string.Empty;
    public string OpenedBy { get; private set; } = string.Empty;
    public DateTime OpenedAtUtc { get; private set; }
    public string? ClosedBy { get; private set; }
    public DateTime? ClosedAtUtc { get; private set; }

    // The cash counted in the drawer at the close.
    public decimal? CountedCash { get; private set; }

    // The Z report as it was at the close, as JSON: kept as printed, whatever changes later.
    public string? ZReport { get; private set; }

    public IReadOnlyList<PaidOut> PaidOuts => _paidOuts.OrderBy(p => p.AtUtc).ToList().AsReadOnly();

    public decimal PaidOutTotal => _paidOuts.Sum(p => p.Amount);

    public PaidOut PayOut(Guid id, PaidOutKind kind, decimal amount, string reason, string? staffName, string by)
    {
        if (_paidOuts.SingleOrDefault(p => p.Id == id) is { } done)
            return done;
        EnsureOpen();
        if (!Enum.IsDefined(kind))
            throw new DomainException("Say what the paid-out is for.");
        if (amount <= 0)
            throw new DomainException("Pay out more than nothing. · المبلغ أكبر من صفر.");
        if (kind == PaidOutKind.StaffAdvance && string.IsNullOrWhiteSpace(staffName))
            throw new DomainException("Say who the advance is for. · اسم الموظف.");
        var paidOut = new PaidOut(id, Id, kind, Math.Round(amount, 2, MidpointRounding.AwayFromZero), reason, staffName, by);
        _paidOuts.Add(paidOut);
        return paidOut;
    }

    public void Close(decimal countedCash, string by)
    {
        EnsureOpen();
        if (countedCash < 0)
            throw new DomainException("The cash counted is zero or more. · النقدية صفر أو أكثر.");
        CountedCash = Math.Round(countedCash, 2, MidpointRounding.AwayFromZero);
        ClosedBy = by;
        ClosedAtUtc = DateTime.UtcNow;
        Status = ShiftStatus.Closed;
    }

    // The Z report worked out at the close, kept as it was.
    public void Keep(string zReport)
    {
        if (Status != ShiftStatus.Closed)
            throw new DomainException("A shift's Z report is kept as it closes.");
        ZReport ??= zReport;
    }

    private void EnsureOpen()
    {
        if (Status != ShiftStatus.Open)
            throw new DomainException("This shift is closed. · الوردية مغلقة.");
    }
}

public sealed class PaidOut : Entity
{
    private PaidOut() { }

    internal PaidOut(Guid id, Guid shiftId, PaidOutKind kind, decimal amount, string reason, string? staffName, string by)
    {
        Id = id;
        ShiftId = shiftId;
        Kind = kind;
        Amount = amount;
        Reason = Names.Required(reason, 200, "Say what it was paid for. · البيان.");
        StaffName = Names.Optional(staffName, 120);
        By = by;
        AtUtc = DateTime.UtcNow;
    }

    public Guid ShiftId { get; private set; }
    public PaidOutKind Kind { get; private set; }
    public decimal Amount { get; private set; }
    public string Reason { get; private set; } = string.Empty;
    public string? StaffName { get; private set; }
    public string By { get; private set; } = string.Empty;
    public DateTime AtUtc { get; private set; }
}

// A member of staff clocking in or out at a terminal (تسجيل حضور وانصراف), for HR.
public sealed class ClockEvent : AggregateRoot
{
    private ClockEvent() { }

    public ClockEvent(Guid id, string userId, string name, bool clockIn)
    {
        Id = id;
        UserId = userId;
        Name = name;
        IsIn = clockIn;
        AtUtc = DateTime.UtcNow;
    }

    public string UserId { get; private set; } = string.Empty;
    public string Name { get; private set; } = string.Empty;
    public bool IsIn { get; private set; }
    public DateTime AtUtc { get; private set; }
}

public interface IShiftRepository : IRepository<Shift>
{
    Task<Shift?> GetOpenAsync(CancellationToken cancellationToken = default);

    Task<IReadOnlyList<Shift>> GetRecentAsync(int take, CancellationToken cancellationToken = default);

    Task<int> NextNumberAsync(CancellationToken cancellationToken = default);
}

public interface IClockEventRepository : IRepository<ClockEvent>
{
    Task<ClockEvent?> GetLastAsync(string userId, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<ClockEvent>> GetSinceAsync(DateTime sinceUtc, CancellationToken cancellationToken = default);
}

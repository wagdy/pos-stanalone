using System.Text.Json;
using MediatR;
using Pos.Application.Common;
using Pos.Application.Integrations;
using Pos.Domain.Common;
using Pos.Domain.Integrations;
using Pos.Domain.Orders;
using Pos.Domain.Shifts;

namespace Pos.Application.Shifts;

// The cashier's shift (الوردية) and its Z report (تقرير Z): opened with the drawer's float, paid-outs
// taken from it, closed with the cash counted. The Z report says what the shift sold, net and with
// its tax apart, how it was paid, its discounts, its voids before and after the kitchen with their
// reasons, the drivers' cash, and what the drawer should hold against what it does. Closed, the
// report is kept as it was, printed, and sent to Costing for the day's sales, waste and takings.

public sealed record PaidOutDto(Guid Id, PaidOutKind Kind, decimal Amount, string Reason, string? StaffName, string By, DateTime AtUtc);

public sealed record VoidReasonLine(string Reason, int Count, decimal Amount);

public sealed record SoldItemLine(int Code, string Name, int Quantity, decimal Amount);

public sealed record WasteLine(int Code, string Name, int Quantity, decimal Amount, StockOutcome Outcome, string? Reason);

public sealed record DriverLine(string Driver, int Orders, decimal Cash, decimal Total);

public sealed record TypeLine(OrderType Type, int Checks, decimal Total);

public sealed record ZReportDto(
    Guid ShiftId,
    int Number,
    DateOnly BusinessDate,
    string OpenedBy,
    DateTime OpenedAtUtc,
    string? ClosedBy,
    DateTime? ClosedAtUtc,
    bool IsClosed,
    decimal OpeningFloat,
    int Checks,
    int Guests,
    decimal GrossSales,
    decimal Discounts,
    decimal Redemptions,
    decimal NetSales,
    decimal Service,
    decimal Tax,
    decimal TotalSales,
    decimal CashSales,
    decimal CardSales,
    decimal WalletSales,
    decimal StaffMeals,
    IReadOnlyList<TypeLine> ByType,
    decimal PaidOuts,
    IReadOnlyList<PaidOutDto> PaidOutLines,
    int VoidBeforeCount,
    decimal VoidBeforeAmount,
    int VoidAfterCount,
    decimal VoidAfterAmount,
    IReadOnlyList<VoidReasonLine> VoidAfterReasons,
    IReadOnlyList<WasteLine> VoidAfterItems,
    IReadOnlyList<DriverLine> Drivers,
    decimal ExpectedCash,
    decimal? CountedCash,
    decimal? Variance,
    int OpenChecks,
    IReadOnlyList<SoldItemLine> SoldItems);

public sealed record ShiftDto(Guid Id, int Number, DateOnly BusinessDate, ShiftStatus Status, decimal OpeningFloat, string OpenedBy,
    DateTime OpenedAtUtc, string? ClosedBy, DateTime? ClosedAtUtc, decimal? CountedCash, IReadOnlyList<PaidOutDto> PaidOuts);

internal static class ShiftMapping
{
    public static PaidOutDto Dto(PaidOut p) => new(p.Id, p.Kind, p.Amount, p.Reason, p.StaffName, p.By, p.AtUtc);

    public static ShiftDto Dto(Shift s) => new(s.Id, s.Number, s.BusinessDate, s.Status, s.OpeningFloat, s.OpenedBy, s.OpenedAtUtc, s.ClosedBy,
        s.ClosedAtUtc, s.CountedCash, s.PaidOuts.Select(Dto).ToList());
}

// The Z report of a shift as it stands: its paid checks, and the voids on the checks it closed.
internal sealed class ZReportBuilder(IOrderRepository orders)
{
    public async Task<ZReportDto> BuildAsync(Shift shift, decimal? countedCash, CancellationToken cancellationToken)
    {
        var closedHere = await orders.GetForShiftAsync(shift.Id, cancellationToken);
        var paid = closedHere.Where(o => o.Status == OrderStatus.Paid).ToList();
        var open = (await orders.GetOpenAsync(cancellationToken)).Count(o => o.Lines.Any(l => l.Quantity > 0));
        var totals = paid.Select(o => (Order: o, Totals: o.Totals)).ToList();
        var payments = paid.SelectMany(o => o.Payments).Where(p => p.ShiftId == shift.Id).ToList();
        decimal Paid(PaymentMethod method) => payments.Where(p => p.Method == method).Sum(p => p.Amount);

        var voids = closedHere.SelectMany(o => o.Voids).ToList();
        var before = voids.Where(v => v.Kind == VoidKind.BeforeKitchen).ToList();
        var after = voids.Where(v => v.Kind == VoidKind.AfterKitchen).ToList();
        var cash = Paid(PaymentMethod.Cash);
        var expected = shift.OpeningFloat + cash - shift.PaidOutTotal;
        var counted = countedCash ?? shift.CountedCash;

        return new ZReportDto(
            shift.Id, shift.Number, shift.BusinessDate, shift.OpenedBy, shift.OpenedAtUtc, shift.ClosedBy, shift.ClosedAtUtc,
            shift.Status == ShiftStatus.Closed, shift.OpeningFloat, paid.Count, paid.Sum(o => o.Guests),
            totals.Sum(t => t.Totals.Gross), totals.Sum(t => t.Totals.LineDiscounts + t.Totals.BillDiscount), totals.Sum(t => t.Totals.Redemption),
            totals.Sum(t => t.Totals.Net + t.Totals.Service), totals.Sum(t => t.Totals.Service), totals.Sum(t => t.Totals.Tax),
            totals.Sum(t => t.Totals.Total), cash, Paid(PaymentMethod.Card), Paid(PaymentMethod.Wallet), Paid(PaymentMethod.StaffMeal),
            totals.GroupBy(t => t.Order.Type).OrderBy(g => g.Key).Select(g => new TypeLine(g.Key, g.Count(), g.Sum(t => t.Totals.Total))).ToList(),
            shift.PaidOutTotal, shift.PaidOuts.Select(ShiftMapping.Dto).ToList(),
            before.Sum(v => v.Quantity), before.Sum(v => v.Amount), after.Sum(v => v.Quantity), after.Sum(v => v.Amount),
            after.GroupBy(v => v.Reason ?? "—").Select(g => new VoidReasonLine(g.Key, g.Sum(v => v.Quantity), g.Sum(v => v.Amount)))
                .OrderByDescending(r => r.Amount).ToList(),
            after.Select(v => new WasteLine(v.Code, v.ItemName, v.Quantity, v.Amount, v.Outcome, v.Reason)).ToList(),
            paid.Where(o => o.Type == OrderType.Delivery).GroupBy(o => o.DriverName ?? "No driver · بدون سائق")
                .Select(g => new DriverLine(g.Key, g.Count(),
                    g.SelectMany(o => o.Payments).Where(p => p.Method == PaymentMethod.Cash).Sum(p => p.Amount), g.Sum(o => o.Totals.Total)))
                .OrderBy(d => d.Driver).ToList(),
            expected, counted, counted is { } c ? c - expected : null, open,
            paid.SelectMany(o => o.Lines).Where(l => l.Quantity > 0).GroupBy(l => (l.Code, l.Name))
                .Select(g => new SoldItemLine(g.Key.Code, g.Key.Name, g.Sum(l => l.Quantity), g.Sum(l => l.Total)))
                .OrderBy(i => i.Code).ToList());
    }
}

public sealed record GetCurrentShiftQuery : IRequest<ShiftDto?>;

internal sealed class GetCurrentShiftHandler(IShiftRepository shifts) : IRequestHandler<GetCurrentShiftQuery, ShiftDto?>
{
    public async Task<ShiftDto?> Handle(GetCurrentShiftQuery request, CancellationToken cancellationToken) =>
        await shifts.GetOpenAsync(cancellationToken) is { } shift ? ShiftMapping.Dto(shift) : null;
}

public sealed record GetShiftsQuery(int Take = 30) : IRequest<IReadOnlyList<ShiftDto>>;

internal sealed class GetShiftsHandler(IShiftRepository shifts) : IRequestHandler<GetShiftsQuery, IReadOnlyList<ShiftDto>>
{
    public async Task<IReadOnlyList<ShiftDto>> Handle(GetShiftsQuery request, CancellationToken cancellationToken) =>
        (await shifts.GetRecentAsync(Math.Clamp(request.Take, 1, 200), cancellationToken)).Select(ShiftMapping.Dto).ToList();
}

// A closed shift's report as it was kept; an open one's as it stands (an X report).
public sealed record GetZReportQuery(Guid ShiftId) : IRequest<ZReportDto>;

internal sealed class GetZReportHandler(IShiftRepository shifts, ZReportBuilder builder) : IRequestHandler<GetZReportQuery, ZReportDto>
{
    public async Task<ZReportDto> Handle(GetZReportQuery request, CancellationToken cancellationToken)
    {
        var shift = await shifts.GetRequiredAsync(request.ShiftId, cancellationToken);
        return shift.ZReport is { } kept
            ? JsonSerializer.Deserialize<ZReportDto>(kept, Outbox.Json)!
            : await builder.BuildAsync(shift, null, cancellationToken);
    }
}

public sealed record OpenShiftCommand(Guid ShiftId, decimal OpeningFloat, Actor By) : IRequest<ShiftDto>, IRetryOnConflict;

internal sealed class OpenShiftHandler(IShiftRepository shifts, IBusinessCalendar calendar, IPosNotifier notifier, IUnitOfWork unitOfWork)
    : IRequestHandler<OpenShiftCommand, ShiftDto>
{
    public async Task<ShiftDto> Handle(OpenShiftCommand request, CancellationToken cancellationToken)
    {
        if (await shifts.GetOpenAsync(cancellationToken) is { } open)
            return open.Id == request.ShiftId ? ShiftMapping.Dto(open)
                : throw new DomainException($"Shift {open.Number} is open, by {open.OpenedBy}: close it first. · يوجد وردية مفتوحة.");
        var shift = new Shift(request.ShiftId, await shifts.NextNumberAsync(cancellationToken), calendar.BusinessDateOf(DateTime.UtcNow),
            request.OpeningFloat, request.By.Id, request.By.Name);
        shifts.Add(shift);
        await unitOfWork.SaveChangesAsync(cancellationToken);
        await notifier.ShiftChangedAsync(cancellationToken);
        return ShiftMapping.Dto(shift);
    }
}

// Cash out of the drawer: an expense, an advance to a member of staff (sent to payroll), a driver's.
public sealed record PayOutCommand(Guid PaidOutId, PaidOutKind Kind, decimal Amount, string Reason, string? StaffName, Actor By) : IRequest<ShiftDto>;

internal sealed class PayOutHandler(IShiftRepository shifts, Outbox outbox, IPosNotifier notifier, IUnitOfWork unitOfWork) : IRequestHandler<PayOutCommand, ShiftDto>
{
    public async Task<ShiftDto> Handle(PayOutCommand request, CancellationToken cancellationToken)
    {
        var shift = await shifts.GetOpenAsync(cancellationToken) ?? throw new DomainException("Open the shift first. · افتح الوردية أولاً.");
        var paidOut = shift.PayOut(request.PaidOutId, request.Kind, request.Amount, request.Reason, request.StaffName, request.By.Name);
        if (paidOut.Kind == PaidOutKind.StaffAdvance)
            await outbox.QueueAsync(LinkedSystem.Hr, "staff.advance", paidOut.Id.ToString(), $"Advance to {paidOut.StaffName}: {paidOut.Amount:N2}",
                new { PaidOutId = paidOut.Id, Employee = paidOut.StaffName, paidOut.Amount, paidOut.Reason, GivenBy = paidOut.By, paidOut.AtUtc, shift.BusinessDate },
                cancellationToken);
        await unitOfWork.SaveChangesAsync(cancellationToken);
        await notifier.ShiftChangedAsync(cancellationToken);
        return ShiftMapping.Dto(shift);
    }
}

// The shift closed with the cash counted: no check may be left open with items on it. Its Z report
// kept, printed, and Costing sent the day's sales, waste and takings.
public sealed record CloseShiftCommand(Guid ShiftId, decimal CountedCash, bool Print, Actor By) : IRequest<ZReportDto>;

internal sealed class CloseShiftHandler(
    IShiftRepository shifts, ZReportBuilder builder, Outbox outbox, IPrintSpooler printer, IPosNotifier notifier, IUnitOfWork unitOfWork)
    : IRequestHandler<CloseShiftCommand, ZReportDto>
{
    public async Task<ZReportDto> Handle(CloseShiftCommand request, CancellationToken cancellationToken)
    {
        var shift = await shifts.GetRequiredAsync(request.ShiftId, cancellationToken);
        if (shift.Status == ShiftStatus.Closed)
            return JsonSerializer.Deserialize<ZReportDto>(shift.ZReport!, Outbox.Json)!;
        var draft = await builder.BuildAsync(shift, request.CountedCash, cancellationToken);
        if (draft.OpenChecks > 0)
            throw new DomainException($"{draft.OpenChecks} {(draft.OpenChecks == 1 ? "check is" : "checks are")} still open: settle or cancel them first. · توجد شيكات مفتوحة.");

        shift.Close(request.CountedCash, request.By.Name);
        var report = await builder.BuildAsync(shift, request.CountedCash, cancellationToken);
        shift.Keep(JsonSerializer.Serialize(report, Outbox.Json));
        await outbox.QueueAsync(LinkedSystem.Costing, "day.closed", shift.Id.ToString(),
            $"Shift {shift.Number} of {shift.BusinessDate:yyyy-MM-dd}: {report.TotalSales:N2}", CostingDay.From(report), cancellationToken);
        await unitOfWork.SaveChangesAsync(cancellationToken);
        if (request.Print)
            await printer.PrintAsync([new PrintRequest(PrintDocumentKind.ZReport, shift.Id)], cancellationToken);
        await notifier.ShiftChangedAsync(cancellationToken);
        await notifier.SyncChangedAsync(cancellationToken);
        return report;
    }
}

// What Costing takes from a closed shift (day.closed): each item sold, for its recipe to take its
// stock; the voids after the kitchen, made (waste) or not (back to stock); and the takings as its
// Takings in has them, cash and Visa before tax, the tax, the voids before and after with reasons.
public static class CostingDay
{
    public static object From(ZReportDto z) => new
    {
        z.ShiftId,
        ShiftNumber = z.Number,
        z.BusinessDate,
        z.OpenedAtUtc,
        z.ClosedAtUtc,
        SoldItems = z.SoldItems.Select(i => new { i.Code, i.Name, i.Quantity, NetAmount = i.Amount }),
        Waste = z.VoidAfterItems.Where(w => w.Outcome == StockOutcome.Waste).Select(w => new { w.Code, w.Name, w.Quantity, w.Amount, w.Reason }),
        ReturnedToStock = z.VoidAfterItems.Where(w => w.Outcome == StockOutcome.ReturnToStock).Select(w => new { w.Code, w.Name, w.Quantity, w.Reason }),
        Takings = new
        {
            Cash = BeforeTax(z, z.CashSales),
            Card = BeforeTax(z, z.CardSales + z.WalletSales),
            z.Tax,
            z.NetSales,
            VoidsBefore = new { Count = z.VoidBeforeCount, Amount = z.VoidBeforeAmount },
            VoidsAfter = new { Count = z.VoidAfterCount, Amount = z.VoidAfterAmount, Reasons = z.VoidAfterReasons },
            z.PaidOuts,
            z.StaffMeals,
        },
    };

    // A payment's share of the sales before tax: the tax taken off in proportion to what the
    // shift's checks came to.
    public static decimal BeforeTax(ZReportDto z, decimal paid) =>
        z.TotalSales == 0 ? paid : Math.Round(paid * (z.TotalSales - z.Tax) / z.TotalSales, 2, MidpointRounding.AwayFromZero);
}

// A member of staff clocking in, or out if they are in: at the terminal, by their PIN.
public sealed record ClockCommand(string? Pin, Actor By) : IRequest<ClockResultDto>;

public sealed record ClockResultDto(string Name, bool ClockedIn, DateTime AtUtc);

internal sealed class ClockHandler(IClockEventRepository events, IStaffDirectory staff, Outbox outbox, IUnitOfWork unitOfWork)
    : IRequestHandler<ClockCommand, ClockResultDto>
{
    public async Task<ClockResultDto> Handle(ClockCommand request, CancellationToken cancellationToken)
    {
        var who = string.IsNullOrWhiteSpace(request.Pin)
            ? new StaffMember(request.By.Id, request.By.Name, request.By.Role)
            : await staff.ByPinAsync(request.Pin, cancellationToken) ?? throw new DomainException("That PIN is no one's. · الرقم السري غير صحيح.");
        var last = await events.GetLastAsync(who.Id, cancellationToken);
        var clockIn = last is not { IsIn: true };
        var clock = new ClockEvent(Guid.NewGuid(), who.Id, who.Name, clockIn);
        events.Add(clock);
        await outbox.QueueAsync(LinkedSystem.Hr, "clock.event", clock.Id.ToString(), $"{who.Name} clocked {(clockIn ? "in" : "out")}",
            new { EventId = clock.Id, StaffId = who.Id, who.Name, Role = who.Role.ToString(), ClockIn = clockIn, clock.AtUtc }, cancellationToken);
        await unitOfWork.SaveChangesAsync(cancellationToken);
        return new ClockResultDto(who.Name, clockIn, clock.AtUtc);
    }
}

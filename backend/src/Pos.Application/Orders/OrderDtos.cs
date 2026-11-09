using Pos.Domain.Kitchen;
using Pos.Domain.Orders;

namespace Pos.Application.Orders;

public sealed record OrderLineDto(
    Guid Id,
    Guid MenuItemId,
    int Code,
    string Name,
    string? NameAr,
    string? SizeName,
    string? SizeNameAr,
    string Modifiers,
    string? ModifiersAr,
    string? Notes,
    decimal UnitPrice,
    int Quantity,
    decimal Discount,
    decimal Total,
    LineStatus Status,
    Guid? StationId,
    string? StationName,
    int? KitchenTicketNumber,
    DateTime? SentAtUtc,
    DateTime? PreparedAtUtc,
    string AddedBy,
    DateTime AddedAtUtc);

public sealed record VoidDto(
    Guid Id, Guid LineId, int Code, string ItemName, int Quantity, decimal Amount, VoidKind Kind, string? Reason, StockOutcome Outcome,
    string? AuthorizedBy, string VoidedBy, DateTime AtUtc, int? KitchenTicketNumber);

public sealed record PaymentDto(Guid Id, PaymentMethod Method, decimal Amount, decimal? Tendered, decimal Change, string? Reference, string By, DateTime AtUtc);

public sealed record TotalsDto(decimal Gross, decimal LineDiscounts, decimal BillDiscount, decimal Redemption, decimal Net, decimal Service,
    decimal Tax, decimal Total, decimal Paid, decimal Due);

public sealed record OrderCustomerDto(Guid? Id, string? Name, string? Phone, string? LoyaltyUserId, int? Points, string? Tier);

public sealed record TicketSummaryDto(Guid Id, int Number, TicketKind Kind, DateTime CreatedAtUtc, string CreatedBy, bool IsDone);

public sealed record OrderDto(
    Guid Id,
    int Number,
    DateOnly BusinessDate,
    OrderType Type,
    OrderStatus Status,
    Guid? TableId,
    string? TableLabel,
    string? CheckLabel,
    int Guests,
    Guid? SplitFromId,
    Guid? MergedIntoId,
    int? SplitWays,
    string OpenedBy,
    DateTime OpenedAtUtc,
    string? Notes,
    OrderCustomerDto? Customer,
    string? DeliveryAddress,
    string? DriverName,
    decimal ServicePercent,
    decimal TaxPercent,
    decimal DiscountAmount,
    string? DiscountReason,
    int PointsRedeemed,
    int PointsEarned,
    int BillPrints,
    DateTime? BillPrintedAtUtc,
    DateTime? PaidAtUtc,
    string? SettledBy,
    Guid? ShiftId,
    TotalsDto Totals,
    IReadOnlyList<OrderLineDto> Lines,
    IReadOnlyList<VoidDto> Voids,
    IReadOnlyList<PaymentDto> Payments,
    IReadOnlyList<TicketSummaryDto> Tickets);

// A check in a list: the till's open orders, the day's receipts.
public sealed record OrderSummaryDto(
    Guid Id, int Number, OrderType Type, OrderStatus Status, string? TableLabel, string? CheckLabel, int Guests, string OpenedBy,
    DateTime OpenedAtUtc, string? CustomerName, decimal Total, decimal Due, int Items, bool HasDrafts, DateTime? PaidAtUtc);

internal static class OrderMapping
{
    public static OrderDto Dto(Order order, IReadOnlyList<KitchenTicket>? tickets = null, int? points = null, string? tier = null)
    {
        var t = order.Totals;
        return new OrderDto(
            order.Id, order.Number, order.BusinessDate, order.Type, order.Status, order.TableId, order.TableLabel, order.CheckLabel, order.Guests,
            order.SplitFromId, order.MergedIntoId, order.SplitWays, order.OpenedBy, order.OpenedAtUtc, order.Notes,
            order.CustomerId is null && order.CustomerName is null
                ? null
                : new OrderCustomerDto(order.CustomerId, order.CustomerName, order.CustomerPhone, order.LoyaltyUserId, points, tier),
            order.DeliveryAddress, order.DriverName, order.ServicePercent, order.TaxPercent, order.DiscountAmount, order.DiscountReason,
            order.PointsRedeemed, order.PointsEarned, order.BillPrints, order.BillPrintedAtUtc, order.PaidAtUtc, order.SettledBy, order.ShiftId,
            new TotalsDto(t.Gross, t.LineDiscounts, t.BillDiscount, t.Redemption, t.Net, t.Service, t.Tax, t.Total, t.Paid, t.Due),
            order.Lines.Select(l => new OrderLineDto(
                l.Id, l.MenuItemId, l.Code, l.Name, l.NameAr, l.SizeName, l.SizeNameAr, l.Modifiers, l.ModifiersAr, l.Notes, l.UnitPrice, l.Quantity,
                l.Discount, l.Total, l.Status, l.StationId, l.StationName, l.KitchenTicketNumber, l.SentAtUtc, l.PreparedAtUtc, l.AddedBy, l.AddedAtUtc))
                .ToList(),
            order.Voids.Select(v => new VoidDto(
                v.Id, v.LineId, v.Code, v.ItemName, v.Quantity, v.Amount, v.Kind, v.Reason, v.Outcome, v.AuthorizedBy, v.VoidedBy, v.AtUtc,
                v.KitchenTicketNumber)).ToList(),
            order.Payments.Select(p => new PaymentDto(p.Id, p.Method, p.Amount, p.Tendered, p.Change, p.Reference, p.By, p.AtUtc)).ToList(),
            (tickets ?? []).OrderBy(k => k.Number).Select(k => new TicketSummaryDto(k.Id, k.Number, k.Kind, k.CreatedAtUtc, k.CreatedBy, k.IsDone))
                .ToList());
    }

    public static OrderSummaryDto Summary(Order order)
    {
        var t = order.Totals;
        return new OrderSummaryDto(
            order.Id, order.Number, order.Type, order.Status, order.TableLabel, order.CheckLabel, order.Guests, order.OpenedBy, order.OpenedAtUtc,
            order.CustomerName, t.Total, t.Due, order.Lines.Sum(l => l.Quantity), order.HasDrafts, order.PaidAtUtc);
    }
}

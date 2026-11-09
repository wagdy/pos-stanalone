using MediatR;
using Pos.Application.Common;
using Pos.Application.Kitchen;
using Pos.Application.Orders;
using Pos.Application.Shifts;
using Pos.Domain.Kitchen;
using Pos.Domain.Orders;
using Pos.Domain.Settings;

namespace Pos.Infrastructure.Printing;

// The documents as a network thermal printer prints them, 80 mm (48 characters) or 58 mm: the guest's
// check and the paid receipt, a kitchen ticket for one station, a shift's Z report, a test page.
// Built from what the screens show (the same queries), in the till's time zone.
internal sealed class Receipts(ISender sender, ICompanyProfile company, IPosSettingsStore settings, IBusinessCalendar calendar)
{
    public async Task<(string Title, byte[] Bytes)> RenderAsync(PrintRequest request, int width, string printerName, CancellationToken cancellationToken) =>
        request.Kind switch
        {
            PrintDocumentKind.Bill or PrintDocumentKind.Receipt => await CheckAsync(request, width, cancellationToken),
            PrintDocumentKind.KitchenTicket => await TicketAsync(request, width, cancellationToken),
            PrintDocumentKind.ZReport => await ZReportAsync(request, width, cancellationToken),
            _ => Test(width, printerName),
        };

    private async Task<(string, byte[])> CheckAsync(PrintRequest request, int width, CancellationToken cancellationToken)
    {
        var order = await sender.Send(new GetOrderQuery(request.SubjectId), cancellationToken);
        var pos = await settings.GetAsync(cancellationToken);
        var paid = request.Kind == PrintDocumentKind.Receipt;
        var doc = EscPosDocument.Start(width).Align('c').Bold(true).Size(2).Line(company.Current.Name).Size(1).Bold(false);
        foreach (var line in (pos.ReceiptHeader ?? string.Empty).Split('\n'))
            doc.Line(line);
        if (pos.TaxNumber is { } taxNumber)
            doc.Line($"Tax no. {taxNumber}");
        doc.Rule().Bold(true).Size(2).Line(paid ? "RECEIPT" : "CHECK").Size(1).Bold(false).Align('l');
        doc.Pair($"#{order.Number}{(order.CheckLabel is { } l ? $" / Check {l}" : "")}", Local(order.PaidAtUtc ?? DateTime.UtcNow));
        doc.Line(order.Type switch
        {
            OrderType.DineIn => $"Dine-in - Table {order.TableLabel} - Guests {order.Guests}",
            OrderType.Takeaway => "Takeaway",
            _ => "Delivery",
        });
        doc.Line($"Captain: {order.OpenedBy}{(order.SettledBy is { } s ? $"   Cashier: {s}" : "")}");
        if (order.Customer is { } c)
            doc.Line($"Customer: {c.Name} {c.Phone}");
        if (order.DeliveryAddress is { } address)
            doc.Line($"Address: {address}");
        doc.Rule();
        doc.Line(Columns(width, "Item", "Qty", "Price", "Total"));
        doc.Rule();
        foreach (var line in order.Lines.Where(l => l.Quantity > 0))
        {
            doc.Line(Columns(width, line.Name + (line.SizeName is { } size ? $" ({size})" : ""), line.Quantity.ToString(),
                EscPosDocument.Money(line.UnitPrice), EscPosDocument.Money(line.Total)));
            if (line.Modifiers.Length > 0)
                doc.Line($"  + {line.Modifiers}");
        }
        doc.Rule();
        var t = order.Totals;
        doc.Pair("Subtotal", EscPosDocument.Money(t.Gross));
        if (t.LineDiscounts + t.BillDiscount > 0)
            doc.Pair("Discount", "-" + EscPosDocument.Money(t.LineDiscounts + t.BillDiscount));
        if (t.Redemption > 0)
            doc.Pair($"Points redeemed ({order.PointsRedeemed})", "-" + EscPosDocument.Money(t.Redemption));
        if (t.Service > 0)
            doc.Pair($"Service {order.ServicePercent:0.##}%", EscPosDocument.Money(t.Service));
        doc.Pair($"VAT {order.TaxPercent:0.##}%", EscPosDocument.Money(t.Tax));
        doc.Bold(true).Size(2).Pair("TOTAL", EscPosDocument.Money(t.Total), width / 2).Size(1).Bold(false);
        foreach (var payment in order.Payments)
        {
            doc.Pair(payment.Method.ToString(), EscPosDocument.Money(payment.Amount));
            if (payment.Change > 0)
                doc.Pair("  Change", EscPosDocument.Money(payment.Change));
        }
        if (!paid && order.SplitWays is { } ways)
            doc.Pair($"Each of {ways}", EscPosDocument.Money(Math.Ceiling(t.Total / ways * 100) / 100));
        if (order.PointsEarned > 0)
            doc.Line($"Points earned: {order.PointsEarned}");
        doc.Rule().Align('c');
        foreach (var line in (pos.ReceiptFooter ?? string.Empty).Split('\n'))
            doc.Line(line);
        return ($"{(paid ? "Receipt" : "Check")} #{order.Number}", doc.Cut());
    }

    private async Task<(string, byte[])> TicketAsync(PrintRequest request, int width, CancellationToken cancellationToken)
    {
        var ticket = await sender.Send(new GetTicketQuery(request.SubjectId), cancellationToken);
        var lines = ticket.Lines.Where(l => request.StationId is null || l.StationId == request.StationId).ToList();
        var station = lines.FirstOrDefault()?.StationName ?? "Kitchen";
        var doc = EscPosDocument.Start(width).Align('c');
        var banner = ticket.Kind switch
        {
            TicketKind.AddOn => " ADD-ON ",
            TicketKind.Void => " *** VOID - STOP *** ",
            TicketKind.Transfer => " TABLE MOVED ",
            _ => null,
        };
        if (banner is not null)
            doc.Inverse(true).Bold(true).Size(2).Line(banner).Size(1).Bold(false).Inverse(false);
        doc.Bold(true).Size(2).Line($"KOT {ticket.Number}  {station.ToUpperInvariant()}").Size(1).Bold(false).Align('l');
        doc.Bold(true).Size(2).Line(ticket.OrderType switch
        {
            OrderType.DineIn => $"TABLE {ticket.TableLabel}{(ticket.CheckLabel is { } c ? $" ({c})" : "")}",
            OrderType.Takeaway => "TAKEAWAY",
            _ => "DELIVERY",
        }).Size(1).Bold(false);
        doc.Pair($"Order #{ticket.OrderNumber}  Guests {ticket.Guests}", Local(ticket.CreatedAtUtc, "HH:mm"));
        doc.Line($"By: {ticket.CreatedBy}");
        if (ticket.Note is { } note)
            doc.Bold(true).Line(note).Bold(false);
        doc.Rule('=');
        foreach (var line in lines)
        {
            doc.Bold(true).Size(2).Line($"{(ticket.Kind == TicketKind.Void ? "-" : "")}{line.Quantity} x {line.Name}").Size(1).Bold(false);
            if (line.SizeName is { } size)
                doc.Line($"    Size: {size}");
            if (line.Modifiers.Length > 0)
                doc.Line($"    + {line.Modifiers}");
            if (line.Notes is { } notes)
                doc.Bold(true).Line($"    ** {notes} **").Bold(false);
        }
        doc.Rule('=');
        return ($"KOT {ticket.Number} {station}", doc.Cut());
    }

    private async Task<(string, byte[])> ZReportAsync(PrintRequest request, int width, CancellationToken cancellationToken)
    {
        var z = await sender.Send(new GetZReportQuery(request.SubjectId), cancellationToken);
        string M(decimal v) => EscPosDocument.Money(v);
        var doc = EscPosDocument.Start(width).Align('c').Bold(true).Size(2).Line(company.Current.Name)
            .Line(z.IsClosed ? "Z REPORT" : "X REPORT").Size(1).Bold(false).Align('l');
        doc.Pair($"Shift {z.Number}", z.BusinessDate.ToString("yyyy-MM-dd"));
        doc.Pair("Opened", $"{Local(z.OpenedAtUtc)} {z.OpenedBy}");
        if (z.ClosedAtUtc is { } closed)
            doc.Pair("Closed", $"{Local(closed)} {z.ClosedBy}");
        doc.Rule().Pair("Checks / guests", $"{z.Checks} / {z.Guests}").Pair("Gross sales", M(z.GrossSales)).Pair("Discounts", "-" + M(z.Discounts))
            .Pair("Points redeemed", "-" + M(z.Redemptions)).Pair("Net sales (before tax)", M(z.NetSales)).Pair("  of which service", M(z.Service))
            .Pair("Tax collected", M(z.Tax)).Bold(true).Pair("TOTAL", M(z.TotalSales)).Bold(false).Rule();
        doc.Pair("Cash", M(z.CashSales)).Pair("Visa / card", M(z.CardSales)).Pair("Wallet", M(z.WalletSales)).Pair("Staff meals", M(z.StaffMeals));
        foreach (var type in z.ByType)
            doc.Pair($"  {type.Type} ({type.Checks})", M(type.Total));
        doc.Rule().Pair($"Void before kitchen ({z.VoidBeforeCount})", M(z.VoidBeforeAmount)).Pair($"Void after kitchen ({z.VoidAfterCount})", M(z.VoidAfterAmount));
        foreach (var reason in z.VoidAfterReasons)
            doc.Pair($"  {reason.Reason} ({reason.Count})", M(reason.Amount));
        foreach (var driver in z.Drivers)
            doc.Pair($"Driver {driver.Driver} ({driver.Orders})", M(driver.Cash));
        doc.Rule().Pair("Opening float", M(z.OpeningFloat)).Pair("+ Cash sales", M(z.CashSales)).Pair("- Paid out", M(z.PaidOuts))
            .Bold(true).Pair("Expected cash", M(z.ExpectedCash)).Bold(false);
        if (z.CountedCash is { } counted)
            doc.Pair("Counted cash", M(counted)).Bold(true).Pair("Variance", M(z.Variance ?? 0)).Bold(false);
        return ($"{(z.IsClosed ? "Z" : "X")} report shift {z.Number}", doc.Cut());
    }

    private static (string, byte[]) Test(int width, string printerName)
    {
        var doc = EscPosDocument.Start(width).Align('c').Bold(true).Size(2).Line("TEST PRINT").Size(1).Bold(false)
            .Line(printerName).Line(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")).Rule().Align('l');
        doc.Line(new string('1', width)).Inverse(true).Line(" WHITE ON BLACK ").Inverse(false).Bold(true).Line("Bold").Bold(false).Size(2).Line("Double").Size(1);
        return ($"Test page {printerName}", doc.Cut());
    }

    private string Local(DateTime utc, string format = "yyyy-MM-dd HH:mm") => calendar.ToLocal(utc).ToString(format);

    // Item, quantity, price and total in columns, the name taking what the figures leave.
    private static string Columns(int width, string name, string qty, string price, string total)
    {
        var right = $"{qty,4} {price,9} {total,10}";
        var room = width - right.Length - 1;
        var n = name.Length > room ? name[..room] : name;
        return n.PadRight(room) + " " + right;
    }
}

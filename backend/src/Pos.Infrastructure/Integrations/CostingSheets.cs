using ClosedXML.Excel;
using Pos.Domain.Orders;

namespace Pos.Infrastructure.Integrations;

// A business day as Costing imports it, by hand when the link is off: the "Daily Sales" sheet in
// Costing's own daily sales layout (each item by its code and name, how many sold), which its Sales
// → Import reads as it is; then the voids after the kitchen (waste, back to stock) and the takings
// as Financials → Takings in asks for them.
public static class CostingSheets
{
    public const string SalesSheet = "Daily Sales";
    public const string ItemHeader = "Item · الصنف";
    public const string QuantityHeader = "Quantity Sold · الكمية المباعة";

    // sizeCodes: each size's code in the costing system (6101-17), for a size sold to be written as
    // Costing's import reads it; without one, the item's code and the size's name.
    public static byte[] Build(DateOnly date, string company, IReadOnlyList<Order> orders, IReadOnlyDictionary<Guid, string>? sizeCodes = null)
    {
        var paid = orders.Where(o => o.Status == OrderStatus.Paid).ToList();
        using var book = new XLWorkbook();

        var sales = book.AddWorksheet(SalesSheet);
        sales.Cell(1, 1).Value = ItemHeader;
        sales.Cell(1, 2).Value = QuantityHeader;
        var row = 2;
        foreach (var item in paid.SelectMany(o => o.Lines).Where(l => l.Quantity > 0)
                     .GroupBy(l => (l.Code, l.Name, l.SizeName, SizeCode: l.SizeId is { } id ? sizeCodes?.GetValueOrDefault(id) : null))
                     .OrderBy(g => g.Key.Code).ThenBy(g => g.Key.SizeName))
        {
            sales.Cell(row, 1).Value = $"{item.Key.SizeCode ?? item.Key.Code.ToString(System.Globalization.CultureInfo.InvariantCulture)} · {item.Key.Name}{(item.Key.SizeName is { } size ? $" ({size})" : "")}";
            sales.Cell(row, 2).Value = item.Sum(l => l.Quantity);
            row++;
        }
        Header(sales, 2);

        var waste = book.AddWorksheet("Voids After Kitchen");
        string[] wasteHeaders = ["Code · الكود", "Item · الصنف", "Quantity · الكمية", "Amount · القيمة", "Made? · الحالة", "Reason · السبب", "Authorised by · المدير", "Check · الشيك"];
        for (var c = 0; c < wasteHeaders.Length; c++)
            waste.Cell(1, c + 1).Value = wasteHeaders[c];
        row = 2;
        foreach (var (order, entry) in orders.SelectMany(o => o.Voids.Where(v => v.Kind == VoidKind.AfterKitchen).Select(v => (o, v))).OrderBy(x => x.v.AtUtc))
        {
            waste.Cell(row, 1).Value = entry.Code;
            waste.Cell(row, 2).Value = entry.ItemName;
            waste.Cell(row, 3).Value = entry.Quantity;
            waste.Cell(row, 4).Value = entry.Amount;
            waste.Cell(row, 5).Value = entry.Outcome == StockOutcome.Waste ? "Waste · هالك" : "Back to stock · يعود للمخزن";
            waste.Cell(row, 6).Value = entry.Reason;
            waste.Cell(row, 7).Value = entry.AuthorizedBy;
            waste.Cell(row, 8).Value = $"#{order.Number}";
            row++;
        }
        waste.Column(4).Style.NumberFormat.Format = "#,##0.00";
        Header(waste, wasteHeaders.Length);

        var takings = book.AddWorksheet("Takings");
        var totals = paid.Select(o => o.Totals).ToList();
        var payments = paid.SelectMany(o => o.Payments).ToList();
        decimal Paid(PaymentMethod m) => payments.Where(p => p.Method == m).Sum(p => p.Amount);
        var total = totals.Sum(t => t.Total);
        var tax = totals.Sum(t => t.Tax);
        decimal BeforeTax(decimal amount) => total == 0 ? amount : Math.Round(amount * (total - tax) / total, 2, MidpointRounding.AwayFromZero);
        var voids = orders.SelectMany(o => o.Voids).ToList();
        object[][] lines =
        [
            ["Company · الشركة", company],
            ["Business day · اليوم", date.ToString("yyyy-MM-dd")],
            ["Checks paid · عدد الشيكات", paid.Count],
            ["Cash before tax · إيراد الكاش", BeforeTax(Paid(PaymentMethod.Cash))],
            ["Visa / card before tax · إيراد الفيزا", BeforeTax(Paid(PaymentMethod.Card) + Paid(PaymentMethod.Wallet))],
            ["Total tax collected · إجمالي الضريبة المحصلة", tax],
            ["Net sales · صافي المبيعات", totals.Sum(t => t.Net + t.Service)],
            ["Total with tax · الإجمالي", total],
            ["Staff meals · وجبات العاملين", Paid(PaymentMethod.StaffMeal)],
            ["Voids before kitchen · إلغاء قبل المطبخ", voids.Where(v => v.Kind == VoidKind.BeforeKitchen).Sum(v => v.Amount)],
            ["Voids after kitchen · إلغاء بعد المطبخ", voids.Where(v => v.Kind == VoidKind.AfterKitchen).Sum(v => v.Amount)],
            ["Void reasons · أسباب الإلغاء", string.Join("; ", voids.Where(v => v.Kind == VoidKind.AfterKitchen).GroupBy(v => v.Reason)
                .Select(g => $"{g.Key} ×{g.Sum(v => v.Quantity)}"))],
        ];
        for (var i = 0; i < lines.Length; i++)
        {
            takings.Cell(i + 1, 1).Value = (string)lines[i][0];
            takings.Cell(i + 1, 2).Value = XLCellValue.FromObject(lines[i][1]);
        }
        takings.Range(4, 2, 11, 2).Style.NumberFormat.Format = "#,##0.00";
        takings.Column(1).Style.Font.Bold = true;
        takings.Columns().AdjustToContents();

        using var stream = new MemoryStream();
        book.SaveAs(stream);
        return stream.ToArray();
    }

    private static void Header(IXLWorksheet sheet, int columns)
    {
        var header = sheet.Range(1, 1, 1, columns);
        header.Style.Font.Bold = true;
        header.Style.Fill.BackgroundColor = XLColor.FromHtml("#4f46e5");
        header.Style.Font.FontColor = XLColor.White;
        sheet.SheetView.FreezeRows(1);
        sheet.Columns().AdjustToContents();
    }
}

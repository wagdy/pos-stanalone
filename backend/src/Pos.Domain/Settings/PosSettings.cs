using Pos.Domain.Common;

namespace Pos.Domain.Settings;

// How the till charges and prints (إعدادات نقطة البيع): one row, a manager's. The tax and the
// service charge (a table's only), the receipt's header and footer, the loyalty programme's rates,
// the reasons a void after the kitchen can give, the kitchen's quick notes, and how big a discount
// a cashier gives without a manager.
public sealed class PosSettings
{
    public const int SingletonId = 1;

    public static readonly IReadOnlyList<string> DefaultVoidReasons =
        ["Late · تأخير", "Customer changed mind · تغيير رأي العميل", "Captain error · خطأ كابتن", "Item quality · جودة صنف", "Other · أخرى"];

    public static readonly IReadOnlyList<string> DefaultQuickNotes =
        ["No onions · بدون بصل", "Well done · تسوية زيادة", "Medium · وسط", "Spicy · حار", "No ice · بدون ثلج", "Extra sauce · صوص زيادة"];

    private PosSettings() { }

    public static PosSettings Defaults() => new()
    {
        TaxPercent = 14,
        ServicePercent = 12,
        ReceiptFooter = "Thank you for dining with us · شكراً لزيارتكم",
        PointsPerCurrencyUnit = 0.1m,
        RedemptionValuePer100Points = 10,
        CashierDiscountLimitPercent = 10,
        VoidReasons = [.. DefaultVoidReasons],
        QuickNotes = [.. DefaultQuickNotes],
    };

    public int Id { get; private init; } = SingletonId;

    // Added to the prices, which are before tax.
    public decimal TaxPercent { get; private set; }

    // On a table's check only.
    public decimal ServicePercent { get; private set; }

    public string? ReceiptHeader { get; private set; }
    public string? ReceiptFooter { get; private set; }

    // The tax registration number printed on the receipt.
    public string? TaxNumber { get; private set; }

    // Points a bill earns for each unit of currency: 0.1 is one point for each 10.
    public decimal PointsPerCurrencyUnit { get; private set; }

    // What 100 points take off a bill.
    public decimal RedemptionValuePer100Points { get; private set; }

    // A cashier's discount up to this share of the check; past it, a manager's PIN.
    public decimal CashierDiscountLimitPercent { get; private set; }

    public List<string> VoidReasons { get; private set; } = [];
    public List<string> QuickNotes { get; private set; } = [];

    public string? UpdatedBy { get; private set; }
    public DateTime? UpdatedAtUtc { get; private set; }

    public void Update(
        decimal taxPercent, decimal servicePercent, string? receiptHeader, string? receiptFooter, string? taxNumber, decimal pointsPerCurrencyUnit,
        decimal redemptionValuePer100Points, decimal cashierDiscountLimitPercent, IReadOnlyList<string> voidReasons, IReadOnlyList<string> quickNotes,
        string updatedBy)
    {
        if (taxPercent is < 0 or > 50 || servicePercent is < 0 or > 50)
            throw new DomainException("The tax and the service charge are 0% to 50%. · من 0% إلى 50%.");
        if (pointsPerCurrencyUnit is < 0 or > 100 || redemptionValuePer100Points < 0)
            throw new DomainException("The loyalty rates are zero or more.");
        if (cashierDiscountLimitPercent is < 0 or > 100)
            throw new DomainException("A cashier's discount limit is 0% to 100%.");
        var reasons = Clean(voidReasons, 20);
        if (reasons.Count == 0)
            throw new DomainException("Give at least one void reason. · سبب إلغاء واحد على الأقل.");
        TaxPercent = taxPercent;
        ServicePercent = servicePercent;
        ReceiptHeader = Trim(receiptHeader, 300);
        ReceiptFooter = Trim(receiptFooter, 300);
        TaxNumber = Trim(taxNumber, 40);
        PointsPerCurrencyUnit = pointsPerCurrencyUnit;
        RedemptionValuePer100Points = redemptionValuePer100Points;
        CashierDiscountLimitPercent = cashierDiscountLimitPercent;
        VoidReasons = reasons;
        QuickNotes = Clean(quickNotes, 30);
        UpdatedBy = updatedBy;
        UpdatedAtUtc = DateTime.UtcNow;
    }

    // What these points take off a bill.
    public decimal ValueOf(int points) => Math.Round(points * RedemptionValuePer100Points / 100, 2, MidpointRounding.AwayFromZero);

    private static List<string> Clean(IReadOnlyList<string> items, int max) =>
        items.Select(i => i?.Trim() ?? string.Empty).Where(i => i.Length is > 0 and <= 80).Distinct().Take(max).ToList();

    private static string? Trim(string? value, int max) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim()[..Math.Min(value.Trim().Length, max)];
}

public interface IPosSettingsStore
{
    // The settings, their defaults until a manager saves them.
    Task<PosSettings> GetAsync(CancellationToken cancellationToken = default);

    // The row to change, made if there is none: saved with the unit of work.
    Task<PosSettings> GetForUpdateAsync(CancellationToken cancellationToken = default);
}

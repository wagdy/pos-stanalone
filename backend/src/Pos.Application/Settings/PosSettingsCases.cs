using MediatR;
using Pos.Application.Common;
using Pos.Domain.Common;
using Pos.Domain.Settings;

namespace Pos.Application.Settings;

public sealed record PosSettingsDto(
    decimal TaxPercent,
    decimal ServicePercent,
    string? ReceiptHeader,
    string? ReceiptFooter,
    string? TaxNumber,
    decimal PointsPerCurrencyUnit,
    decimal RedemptionValuePer100Points,
    decimal CashierDiscountLimitPercent,
    IReadOnlyList<string> VoidReasons,
    IReadOnlyList<string> QuickNotes,
    string? UpdatedBy,
    DateTime? UpdatedAtUtc)
{
    public static PosSettingsDto From(PosSettings s) => new(
        s.TaxPercent, s.ServicePercent, s.ReceiptHeader, s.ReceiptFooter, s.TaxNumber, s.PointsPerCurrencyUnit, s.RedemptionValuePer100Points,
        s.CashierDiscountLimitPercent, s.VoidReasons, s.QuickNotes, s.UpdatedBy, s.UpdatedAtUtc);
}

public sealed record GetPosSettingsQuery : IRequest<PosSettingsDto>;

internal sealed class GetPosSettingsHandler(IPosSettingsStore store) : IRequestHandler<GetPosSettingsQuery, PosSettingsDto>
{
    public async Task<PosSettingsDto> Handle(GetPosSettingsQuery request, CancellationToken cancellationToken) =>
        PosSettingsDto.From(await store.GetAsync(cancellationToken));
}

public sealed record SavePosSettingsCommand(
    decimal TaxPercent,
    decimal ServicePercent,
    string? ReceiptHeader,
    string? ReceiptFooter,
    string? TaxNumber,
    decimal PointsPerCurrencyUnit,
    decimal RedemptionValuePer100Points,
    decimal CashierDiscountLimitPercent,
    IReadOnlyList<string> VoidReasons,
    IReadOnlyList<string> QuickNotes,
    Actor By) : IRequest<PosSettingsDto>;

// New checks take the new tax and service; open ones keep what they were opened with.
internal sealed class SavePosSettingsHandler(IPosSettingsStore store, IPosNotifier notifier, IUnitOfWork unitOfWork)
    : IRequestHandler<SavePosSettingsCommand, PosSettingsDto>
{
    public async Task<PosSettingsDto> Handle(SavePosSettingsCommand request, CancellationToken cancellationToken)
    {
        var settings = await store.GetForUpdateAsync(cancellationToken);
        settings.Update(request.TaxPercent, request.ServicePercent, request.ReceiptHeader, request.ReceiptFooter, request.TaxNumber,
            request.PointsPerCurrencyUnit, request.RedemptionValuePer100Points, request.CashierDiscountLimitPercent, request.VoidReasons ?? [],
            request.QuickNotes ?? [], request.By.Name);
        await unitOfWork.SaveChangesAsync(cancellationToken);
        await notifier.MenuChangedAsync(cancellationToken);
        return PosSettingsDto.From(settings);
    }
}

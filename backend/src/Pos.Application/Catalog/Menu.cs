using MediatR;
using Pos.Application.Common;
using Pos.Domain.Catalog;
using Pos.Domain.Common;
using Pos.Domain.Printing;
using Pos.Domain.Settings;

namespace Pos.Application.Catalog;

// The menu as the till, the captains' phones and the kitchen read it, and as a manager keeps it:
// the stations that make the items and the printers they print on, the categories, the items with
// their sizes and modifiers. Ids are made by the screen. Read whole: the till keeps a copy to work
// from when the network is down.

public sealed record OptionDto(Guid Id, string Name, string? NameAr, decimal Price);

public sealed record StationDto(Guid Id, string Name, string? NameAr, int SortOrder, Guid? PrinterId, string? PrinterName,
    PrinterConnection? PrinterConnection = null);

public sealed record CategoryDto(Guid Id, string Name, string? NameAr, int SortOrder, string? Color, bool IsActive);

public sealed record MenuItemDto(
    Guid Id,
    int Code,
    string Name,
    string? NameAr,
    Guid CategoryId,
    Guid? StationId,
    decimal Price,
    bool IsActive,
    IReadOnlyList<OptionDto> Sizes,
    IReadOnlyList<OptionDto> Modifiers);

public sealed record MenuDto(
    IReadOnlyList<CategoryDto> Categories,
    IReadOnlyList<MenuItemDto> Items,
    IReadOnlyList<StationDto> Stations,
    IReadOnlyList<string> QuickNotes,
    IReadOnlyList<string> VoidReasons,
    decimal TaxPercent,
    decimal ServicePercent,
    decimal RedemptionValuePer100Points,
    decimal CashierDiscountLimitPercent,
    // The cashier's documents print in the terminal's browser: there is no network cashier printer.
    bool CashierPrintsInBrowser);

public sealed record GetMenuQuery : IRequest<MenuDto>;

internal sealed class GetMenuHandler(
    IMenuCategoryRepository categories, IMenuItemRepository items, IKitchenStationRepository stations, IPrinterRepository printers, IPosSettingsStore settings)
    : IRequestHandler<GetMenuQuery, MenuDto>
{
    public async Task<MenuDto> Handle(GetMenuQuery request, CancellationToken cancellationToken)
    {
        var all = (await printers.GetAllAsync(cancellationToken)).Where(p => p.IsActive).ToList();
        var byId = all.ToDictionary(p => p.Id);
        var cashier = all.Where(p => p.Role == PrinterRole.Cashier).OrderBy(p => p.Name).FirstOrDefault();
        var pos = await settings.GetAsync(cancellationToken);
        return new MenuDto(
            (await categories.GetAllAsync(cancellationToken)).OrderBy(c => c.SortOrder).ThenBy(c => c.Name)
                .Select(c => new CategoryDto(c.Id, c.Name, c.NameAr, c.SortOrder, c.Color, c.IsActive)).ToList(),
            (await items.GetAllAsync(cancellationToken)).OrderBy(i => i.Code).Select(MenuMapping.Dto).ToList(),
            (await stations.GetAllAsync(cancellationToken)).OrderBy(s => s.SortOrder).ThenBy(s => s.Name)
                .Select(s => new StationDto(s.Id, s.Name, s.NameAr, s.SortOrder, s.PrinterId, s.PrinterId is { } p ? byId.GetValueOrDefault(p)?.Name : null,
                    s.PrinterId is { } q ? byId.GetValueOrDefault(q)?.Connection : null))
                .ToList(),
            pos.QuickNotes, pos.VoidReasons, pos.TaxPercent, pos.ServicePercent, pos.RedemptionValuePer100Points, pos.CashierDiscountLimitPercent,
            cashier is null || cashier.Connection == PrinterConnection.Browser);
    }
}

internal static class MenuMapping
{
    public static MenuItemDto Dto(MenuItem item) => new(
        item.Id, item.Code, item.Name, item.NameAr, item.CategoryId, item.StationId, item.Price, item.IsActive,
        item.Sizes.Select(s => new OptionDto(s.Id, s.Name, s.NameAr, s.Price)).ToList(),
        item.Modifiers.Select(m => new OptionDto(m.Id, m.Name, m.NameAr, m.Price)).ToList());
}

public sealed record SaveStationCommand(Guid Id, string Name, string? NameAr, int SortOrder, Guid? PrinterId) : IRequest<StationDto>;

internal sealed class SaveStationHandler(IKitchenStationRepository stations, IPrinterRepository printers, IPosNotifier notifier, IUnitOfWork unitOfWork)
    : IRequestHandler<SaveStationCommand, StationDto>
{
    public async Task<StationDto> Handle(SaveStationCommand request, CancellationToken cancellationToken)
    {
        var printer = request.PrinterId is { } id ? await printers.GetRequiredAsync(id, cancellationToken) : null;
        var station = await stations.GetByIdAsync(request.Id, cancellationToken);
        if (station is null)
            stations.Add(station = new KitchenStation(request.Id, request.Name, request.NameAr, request.SortOrder));
        else
            station.Rename(request.Name, request.NameAr, request.SortOrder);
        station.PrintOn(printer?.Id);
        await unitOfWork.SaveChangesAsync(cancellationToken);
        await notifier.MenuChangedAsync(cancellationToken);
        return new StationDto(station.Id, station.Name, station.NameAr, station.SortOrder, printer?.Id, printer?.Name);
    }
}

// Its items are made nowhere in particular after it: they print on no station's printer.
public sealed record DeleteStationCommand(Guid Id) : IRequest;

internal sealed class DeleteStationHandler(IKitchenStationRepository stations, IMenuItemRepository items, IPosNotifier notifier, IUnitOfWork unitOfWork)
    : IRequestHandler<DeleteStationCommand>
{
    public async Task Handle(DeleteStationCommand request, CancellationToken cancellationToken)
    {
        var station = await stations.GetRequiredAsync(request.Id, cancellationToken);
        foreach (var item in (await items.GetAllAsync(cancellationToken)).Where(i => i.StationId == station.Id))
            item.Update(item.Code, item.Name, item.NameAr, item.CategoryId, item.Price, null, item.IsActive);
        stations.Remove(station);
        await unitOfWork.SaveChangesAsync(cancellationToken);
        await notifier.MenuChangedAsync(cancellationToken);
    }
}

public sealed record SaveCategoryCommand(Guid Id, string Name, string? NameAr, int SortOrder, string? Color, bool IsActive) : IRequest<CategoryDto>;

internal sealed class SaveCategoryHandler(IMenuCategoryRepository categories, IPosNotifier notifier, IUnitOfWork unitOfWork)
    : IRequestHandler<SaveCategoryCommand, CategoryDto>
{
    public async Task<CategoryDto> Handle(SaveCategoryCommand request, CancellationToken cancellationToken)
    {
        var category = await categories.GetByIdAsync(request.Id, cancellationToken);
        if (category is null)
            categories.Add(category = new MenuCategory(request.Id, request.Name, request.NameAr, request.SortOrder, request.Color));
        category.Update(request.Name, request.NameAr, request.SortOrder, request.Color, request.IsActive);
        await unitOfWork.SaveChangesAsync(cancellationToken);
        await notifier.MenuChangedAsync(cancellationToken);
        return new CategoryDto(category.Id, category.Name, category.NameAr, category.SortOrder, category.Color, category.IsActive);
    }
}

public sealed record SaveMenuItemCommand(
    Guid Id,
    int Code,
    string Name,
    string? NameAr,
    Guid CategoryId,
    Guid? StationId,
    decimal Price,
    bool IsActive,
    IReadOnlyList<OptionDto> Sizes,
    IReadOnlyList<OptionDto> Modifiers) : IRequest<MenuItemDto>;

internal sealed class SaveMenuItemHandler(
    IMenuItemRepository items, IMenuCategoryRepository categories, IKitchenStationRepository stations, IPosNotifier notifier, IUnitOfWork unitOfWork)
    : IRequestHandler<SaveMenuItemCommand, MenuItemDto>
{
    public async Task<MenuItemDto> Handle(SaveMenuItemCommand request, CancellationToken cancellationToken)
    {
        await categories.GetRequiredAsync(request.CategoryId, cancellationToken);
        if (request.StationId is { } stationId)
            await stations.GetRequiredAsync(stationId, cancellationToken);
        if (await items.CodeTakenAsync(request.Code, request.Id, cancellationToken))
            throw new DomainException($"Code {request.Code} is another item's. · الكود مستخدم.");
        var item = await items.GetByIdAsync(request.Id, cancellationToken);
        if (item is null)
            items.Add(item = new MenuItem(request.Id, request.Code, request.Name, request.NameAr, request.CategoryId, request.Price, request.StationId));
        item.Update(request.Code, request.Name, request.NameAr, request.CategoryId, request.Price, request.StationId, request.IsActive);
        item.SetOptions(
            (request.Sizes ?? []).Select(o => new MenuOption(o.Id, o.Name, o.NameAr, o.Price)).ToList(),
            (request.Modifiers ?? []).Select(o => new MenuOption(o.Id, o.Name, o.NameAr, o.Price)).ToList());
        await unitOfWork.SaveChangesAsync(cancellationToken);
        await notifier.MenuChangedAsync(cancellationToken);
        return MenuMapping.Dto(item);
    }
}

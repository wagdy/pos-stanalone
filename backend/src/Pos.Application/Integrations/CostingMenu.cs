using MediatR;
using Pos.Application.Common;
using Pos.Domain.Catalog;
using Pos.Domain.Common;
using Pos.Domain.Integrations;

namespace Pos.Application.Integrations;

// The menu pulled from the costing system (سحب المنيو من التكاليف), when it is linked: its
// categories by name; its items by their number (the same code here), with their names, prices
// and sizes, each size keeping its code there so the Z report names it as the costing system does.
// What is only here stays: each item's kitchen station and modifiers, the categories' colours. An
// item the costing system no longer sells is taken off the menu here, not deleted (past checks
// name it); one priced by its add-ons there cannot be rung up here, and is left off. Unlinked, the
// menu is kept by hand as before.

public sealed record MenuPullResult(
    int Categories, int CategoriesAdded, int Items, int ItemsAdded, int ItemsUpdated, int ItemsTakenOff, int Sizes, int PricedByAddOns);

public sealed record PullCostingMenuCommand(Actor By) : IRequest<MenuPullResult>;

internal sealed class PullCostingMenuHandler(
    IIntegrationStore links,
    ILinkGateway gateway,
    IMenuCategoryRepository categories,
    IMenuItemRepository items,
    IPosNotifier notifier,
    IUnitOfWork unitOfWork) : IRequestHandler<PullCostingMenuCommand, MenuPullResult>
{
    private static readonly string[] Colors = ["#dc2626", "#ea580c", "#16a34a", "#2563eb", "#7c3aed", "#db2777", "#0891b2", "#ca8a04"];

    public async Task<MenuPullResult> Handle(PullCostingMenuCommand request, CancellationToken cancellationToken)
    {
        var link = await links.GetAsync(LinkedSystem.Costing, cancellationToken);
        if (!link.IsReady)
            throw new DomainException("Link the costing system first: its URL and key, switched on. · اربط نظام التكاليف أولاً.");
        CostingMenu menu;
        try
        {
            menu = await gateway.CostingMenuAsync(link, cancellationToken);
        }
        catch (LinkRefusedException ex)
        {
            throw new DomainException(ex.Message);
        }
        if (menu.Items.Count == 0)
            throw new DomainException("The costing system's menu is empty: nothing was changed. · المنيو في نظام التكاليف فارغ.");

        // The categories by name: kept (their colour too), new ones added.
        var known = (await categories.GetAllAsync(cancellationToken)).ToList();
        var byName = known.ToDictionary(c => c.Name.Trim(), StringComparer.OrdinalIgnoreCase);
        var added = 0;
        var named = menu.Categories.Select(c => c.Name.Trim())
            .Concat(menu.Items.Select(i => i.Category.Trim()))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        foreach (var name in named)
        {
            var given = menu.Categories.FirstOrDefault(c => string.Equals(c.Name.Trim(), name, StringComparison.OrdinalIgnoreCase));
            var order = given?.DisplayOrder ?? byName.Count + 1;
            if (byName.TryGetValue(name, out var category))
            {
                category.Update(name, given?.NameAr ?? category.NameAr, order, category.Color, true);
                continue;
            }
            category = new MenuCategory(Guid.NewGuid(), name, given?.NameAr, order, Colors[(known.Count + added) % Colors.Length]);
            categories.Add(category);
            byName[name] = category;
            added++;
        }

        // The items by their code.
        var here = (await items.GetAllAsync(cancellationToken)).ToDictionary(i => i.Code);
        var (itemsAdded, itemsUpdated, sizes, byAddOns) = (0, 0, 0, 0);
        foreach (var source in menu.Items)
        {
            var category = byName[source.Category.Trim()];
            // Priced by its add-ons there (a kilo of mixed grill): no price to ring it up at here.
            var active = source.IsAvailable && !source.PricedByAddOns;
            if (source.PricedByAddOns)
                byAddOns++;
            if (here.TryGetValue(source.Code, out var item))
            {
                item.Update(source.Code, source.Name, source.NameAr, category.Id, source.Price, item.StationId, active);
                itemsUpdated++;
            }
            else
            {
                item = new MenuItem(Guid.NewGuid(), source.Code, source.Name, source.NameAr, category.Id, source.Price, null);
                item.Update(source.Code, source.Name, source.NameAr, category.Id, source.Price, null, active);
                items.Add(item);
                itemsAdded++;
            }

            // Its sizes: one here by the same code, or the same name, keeps its id (and so its past
            // checks); the rest are new. Its modifiers are this POS's own, kept.
            var options = source.Sizes.Select(s =>
            {
                var existing = item.Sizes.FirstOrDefault(z => z.Code == s.Code)
                    ?? item.Sizes.FirstOrDefault(z => string.Equals(z.Name, s.Name.Trim(), StringComparison.OrdinalIgnoreCase));
                return new MenuOption(existing?.Id ?? Guid.NewGuid(), s.Name, s.NameAr, s.Price, s.Code);
            }).ToList();
            item.SetOptions(options, item.Modifiers.Select(m => new MenuOption(m.Id, m.Name, m.NameAr, m.Price)).ToList());
            sizes += options.Count;
        }

        // What the costing system no longer sells: off the menu here.
        var codes = menu.Items.Select(i => i.Code).ToHashSet();
        var takenOff = 0;
        foreach (var item in here.Values.Where(i => i.IsActive && !codes.Contains(i.Code)))
        {
            item.Update(item.Code, item.Name, item.NameAr, item.CategoryId, item.Price, item.StationId, false);
            takenOff++;
        }

        await unitOfWork.SaveChangesAsync(cancellationToken);
        await notifier.MenuChangedAsync(cancellationToken);
        return new MenuPullResult(named.Count, added, menu.Items.Count, itemsAdded, itemsUpdated, takenOff, sizes, byAddOns);
    }
}

using Pos.Domain.Common;

namespace Pos.Domain.Catalog;

// A kitchen station (قسم المطبخ): the grill, the oven, the bar, the cold section. Each item is made
// at one; its tickets go to the station's printer and its screen.
public sealed class KitchenStation : AggregateRoot
{
    public const int MaxNameLength = 80;

    private KitchenStation() { }

    public KitchenStation(Guid id, string name, string? nameAr, int sortOrder, Guid? printerId = null)
    {
        Id = id;
        Rename(name, nameAr, sortOrder);
        PrinterId = printerId;
    }

    public string Name { get; private set; } = string.Empty;
    public string? NameAr { get; private set; }
    public int SortOrder { get; private set; }

    // Where its tickets print; none, and they are only on the kitchen screen.
    public Guid? PrinterId { get; private set; }

    public void Rename(string name, string? nameAr, int sortOrder)
    {
        Name = Names.Required(name, MaxNameLength, "Name the station: Grill, Pizza, Bar, Cold. · اسم القسم.");
        NameAr = Names.Optional(nameAr, MaxNameLength);
        SortOrder = sortOrder;
    }

    public void PrintOn(Guid? printerId) => PrinterId = printerId;
}

// A menu category (قسم المنيو): pizza, burgers, drinks.
public sealed class MenuCategory : AggregateRoot
{
    public const int MaxNameLength = 80;

    private MenuCategory() { }

    public MenuCategory(Guid id, string name, string? nameAr, int sortOrder, string? color = null)
    {
        Id = id;
        Update(name, nameAr, sortOrder, color, true);
    }

    public string Name { get; private set; } = string.Empty;
    public string? NameAr { get; private set; }
    public int SortOrder { get; private set; }

    // Its tile's colour on the till: "#4f46e5".
    public string? Color { get; private set; }
    public bool IsActive { get; private set; } = true;

    public void Update(string name, string? nameAr, int sortOrder, string? color, bool isActive)
    {
        Name = Names.Required(name, MaxNameLength, "Name the category. · اسم القسم.");
        NameAr = Names.Optional(nameAr, MaxNameLength);
        SortOrder = sortOrder;
        Color = string.IsNullOrWhiteSpace(color) ? null : color.Trim()[..Math.Min(color.Trim().Length, 16)];
        IsActive = isActive;
    }
}

// What the menu sells (صنف): its code (the number on every report and on the Costing sheets), its
// names, its category, the station that makes it, its price before tax; its sizes, each priced,
// when it is sold by size; and the modifiers that can go on it, each with what it adds.
public sealed class MenuItem : AggregateRoot
{
    public const int MaxNameLength = 120;

    private readonly List<MenuItemSize> _sizes = [];
    private readonly List<MenuModifier> _modifiers = [];

    private MenuItem() { }

    public MenuItem(Guid id, int code, string name, string? nameAr, Guid categoryId, decimal price, Guid? stationId)
    {
        Id = id;
        Update(code, name, nameAr, categoryId, price, stationId, true);
    }

    public int Code { get; private set; }
    public string Name { get; private set; } = string.Empty;
    public string? NameAr { get; private set; }
    public Guid CategoryId { get; private set; }
    public Guid? StationId { get; private set; }

    // Before tax; a size's own price when it has sizes.
    public decimal Price { get; private set; }
    public bool IsActive { get; private set; } = true;

    public IReadOnlyList<MenuItemSize> Sizes => _sizes.OrderBy(s => s.SortOrder).ToList().AsReadOnly();
    public IReadOnlyList<MenuModifier> Modifiers => _modifiers.OrderBy(m => m.SortOrder).ToList().AsReadOnly();

    public void Update(int code, string name, string? nameAr, Guid categoryId, decimal price, Guid? stationId, bool isActive)
    {
        if (code <= 0)
            throw new DomainException("Give the item its code: a number above 0. · كود الصنف.");
        if (price < 0)
            throw new DomainException("A price is zero or more. · السعر صفر أو أكثر.");
        if (categoryId == Guid.Empty)
            throw new DomainException("Choose the item's category. · اختر القسم.");
        Code = code;
        Name = Names.Required(name, MaxNameLength, "Name the item. · اسم الصنف.");
        NameAr = Names.Optional(nameAr, MaxNameLength);
        CategoryId = categoryId;
        Price = Math.Round(price, 2, MidpointRounding.AwayFromZero);
        StationId = stationId;
        IsActive = isActive;
    }

    // Its sizes and modifiers as given: each kept by its id, so an order line keeps naming it.
    public void SetOptions(IReadOnlyList<MenuOption> sizes, IReadOnlyList<MenuOption> modifiers)
    {
        if (sizes.Select(s => s.Id).Distinct().Count() != sizes.Count || modifiers.Select(m => m.Id).Distinct().Count() != modifiers.Count)
            throw new DomainException("A size or modifier is listed twice.");
        Replace(_sizes, sizes, (o, i) => new MenuItemSize(o.Id, Id, o.Name, o.NameAr, o.Price, i));
        Replace(_modifiers, modifiers, (o, i) => new MenuModifier(o.Id, Id, o.Name, o.NameAr, o.Price, i));
    }

    public MenuItemSize? Size(Guid? sizeId) => sizeId is { } id ? _sizes.SingleOrDefault(s => s.Id == id) : null;

    public MenuModifier? Modifier(Guid modifierId) => _modifiers.SingleOrDefault(m => m.Id == modifierId);

    private static void Replace<T>(List<T> list, IReadOnlyList<MenuOption> given, Func<MenuOption, int, T> make) where T : MenuOptionEntity
    {
        list.RemoveAll(existing => given.All(g => g.Id != existing.Id));
        for (var i = 0; i < given.Count; i++)
        {
            if (list.SingleOrDefault(e => e.Id == given[i].Id) is { } kept)
                kept.Set(given[i].Name, given[i].NameAr, given[i].Price, i);
            else
                list.Add(make(given[i], i));
        }
    }
}

public sealed record MenuOption(Guid Id, string Name, string? NameAr, decimal Price);

public abstract class MenuOptionEntity : Entity
{
    protected MenuOptionEntity() { }

    protected MenuOptionEntity(Guid id, Guid menuItemId, string name, string? nameAr, decimal price, int sortOrder)
    {
        Id = id;
        MenuItemId = menuItemId;
        Set(name, nameAr, price, sortOrder);
    }

    public Guid MenuItemId { get; private set; }
    public string Name { get; private set; } = string.Empty;
    public string? NameAr { get; private set; }
    public decimal Price { get; private set; }
    public int SortOrder { get; private set; }

    internal void Set(string name, string? nameAr, decimal price, int sortOrder)
    {
        if (price < 0)
            throw new DomainException("A price is zero or more. · السعر صفر أو أكثر.");
        Name = Names.Required(name, MenuItem.MaxNameLength, "Name each size and modifier.");
        NameAr = Names.Optional(nameAr, MenuItem.MaxNameLength);
        Price = Math.Round(price, 2, MidpointRounding.AwayFromZero);
        SortOrder = sortOrder;
    }
}

// A size (حجم): its own price, in place of the item's.
public sealed class MenuItemSize : MenuOptionEntity
{
    private MenuItemSize() { }

    internal MenuItemSize(Guid id, Guid menuItemId, string name, string? nameAr, decimal price, int sortOrder)
        : base(id, menuItemId, name, nameAr, price, sortOrder) { }
}

// A modifier (إضافة): extra cheese, no onions; what it adds to the price, nothing for a free one.
public sealed class MenuModifier : MenuOptionEntity
{
    private MenuModifier() { }

    internal MenuModifier(Guid id, Guid menuItemId, string name, string? nameAr, decimal price, int sortOrder)
        : base(id, menuItemId, name, nameAr, price, sortOrder) { }
}

public static class Names
{
    public static string Required(string? value, int max, string message)
    {
        var trimmed = value?.Trim() ?? string.Empty;
        if (trimmed.Length == 0)
            throw new DomainException(message);
        if (trimmed.Length > max)
            throw new DomainException($"Keep it to {max} characters. · {max} حرف على الأكثر.");
        return trimmed;
    }

    public static string? Optional(string? value, int max)
    {
        var trimmed = value?.Trim();
        if (string.IsNullOrEmpty(trimmed))
            return null;
        if (trimmed.Length > max)
            throw new DomainException($"Keep it to {max} characters. · {max} حرف على الأكثر.");
        return trimmed;
    }
}

public interface IKitchenStationRepository : IRepository<KitchenStation>
{
    Task<IReadOnlyList<KitchenStation>> GetAllAsync(CancellationToken cancellationToken = default);

    void Remove(KitchenStation station);
}

public interface IMenuCategoryRepository : IRepository<MenuCategory>
{
    Task<IReadOnlyList<MenuCategory>> GetAllAsync(CancellationToken cancellationToken = default);
}

// Returns items with their sizes and modifiers loaded.
public interface IMenuItemRepository : IRepository<MenuItem>
{
    Task<IReadOnlyList<MenuItem>> GetAllAsync(CancellationToken cancellationToken = default);

    Task<IReadOnlyList<MenuItem>> GetManyAsync(IReadOnlyCollection<Guid> ids, CancellationToken cancellationToken = default);

    Task<bool> CodeTakenAsync(int code, Guid exceptId, CancellationToken cancellationToken = default);
}

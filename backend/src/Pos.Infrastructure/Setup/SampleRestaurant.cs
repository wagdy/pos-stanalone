using Microsoft.EntityFrameworkCore;
using Pos.Domain.Catalog;
using Pos.Domain.Common;
using Pos.Domain.Floor;
using Pos.Domain.Printing;
using Pos.Infrastructure.Persistence;

namespace Pos.Infrastructure.Setup;

// A sample restaurant to start from (تحميل مطعم تجريبي): four kitchen stations, a menu of pizzas,
// grills, cold starters and drinks with sizes and modifiers, two areas of tables, and the cashier's
// printer in the browser. Only into an empty system: it never touches a menu or floor set up already.
public sealed class SampleRestaurant(PosDbContext db)
{
    public async Task LoadAsync(CancellationToken cancellationToken)
    {
        if (await db.MenuItems.AnyAsync(cancellationToken) || await db.DiningTables.AnyAsync(cancellationToken))
            throw new DomainException("The menu or the floor is set up already: the sample goes only into an empty system. · النظام ليس فارغاً.");

        var cashier = new Printer(Guid.NewGuid(), "Cashier", PrinterConnection.Browser, PrinterRole.Cashier, null, 9100, 48);
        db.Printers.Add(cashier);

        var grill = Station("Grill", "مشويات", 1);
        var pizza = Station("Pizza / Oven", "بيتزا / فرن", 2);
        var bar = Station("Bar", "البار", 3);
        var cold = Station("Cold", "بارد", 4);

        var pizzas = Category("Pizza", "بيتزا", 1, "#dc2626");
        var grills = Category("Grills & burgers", "مشويات وبرجر", 2, "#ea580c");
        var starters = Category("Starters & salads", "مقبلات وسلطات", 3, "#16a34a");
        var drinks = Category("Drinks", "مشروبات", 4, "#2563eb");
        var desserts = Category("Desserts", "حلويات", 5, "#db2777");

        MenuOption[] pizzaSizes = [Option("Medium", "وسط", 140), Option("Large", "كبير", 190)];
        MenuOption[] pizzaExtras = [Option("Extra cheese", "جبنة زيادة", 25), Option("Mushrooms", "مشروم", 15), Option("No olives", "بدون زيتون", 0)];
        Item(6101, "Margherita", "مارجريتا", pizzas, pizza, 140, pizzaSizes, pizzaExtras);
        Item(6102, "Pepperoni", "بيبروني", pizzas, pizza, 175, [Option("Medium", "وسط", 175), Option("Large", "كبير", 235)], pizzaExtras);
        Item(6103, "Chicken ranch", "تشيكن رانش", pizzas, pizza, 185, [Option("Medium", "وسط", 185), Option("Large", "كبير", 245)], pizzaExtras);
        Item(6104, "Four cheese", "فور تشيز", pizzas, pizza, 195, [Option("Medium", "وسط", 195), Option("Large", "كبير", 255)], pizzaExtras);

        MenuOption[] doneness = [Option("Medium", "وسط", 0), Option("Well done", "تسوية زيادة", 0), Option("Extra cheese", "جبنة زيادة", 20), Option("No onions", "بدون بصل", 0)];
        Item(7001, "Classic burger", "برجر كلاسيك", grills, grill, 165, [], doneness);
        Item(7002, "Double smash burger", "دبل سماش برجر", grills, grill, 215, [], doneness);
        Item(7003, "Mixed grill", "مشويات مشكلة", grills, grill, 340, [], [Option("Extra rice", "أرز زيادة", 30), Option("Spicy", "حار", 0)]);
        Item(7004, "Grilled chicken", "فراخ مشوية", grills, grill, 230, [Option("Half", "نص", 230), Option("Whole", "كاملة", 420)], []);

        Item(8001, "Caesar salad", "سلطة سيزر", starters, cold, 120, [], [Option("Add chicken", "إضافة فراخ", 45)]);
        Item(8002, "Hummus", "حمص", starters, cold, 70, [], []);
        Item(8003, "Fries", "بطاطس", starters, grill, 55, [Option("Regular", "عادي", 55), Option("Large", "كبير", 75)], [Option("Cheese sauce", "صوص جبنة", 20)]);

        MenuOption[] ice = [Option("No ice", "بدون ثلج", 0), Option("Less sugar", "سكر خفيف", 0)];
        Item(9001, "Fresh orange", "برتقال فريش", drinks, bar, 60, [], ice);
        Item(9002, "Lemon mint", "ليمون نعناع", drinks, bar, 55, [], ice);
        Item(9003, "Soft drink", "مشروب غازي", drinks, bar, 30, [], []);
        Item(9004, "Water", "مياه", drinks, bar, 15, [Option("Small", "صغير", 15), Option("Large", "كبير", 25)], []);
        Item(9005, "Turkish coffee", "قهوة تركي", drinks, bar, 45, [Option("Single", "سنجل", 45), Option("Double", "دبل", 65)], []);

        Item(9501, "Chocolate fondant", "فوندان شوكولاتة", desserts, cold, 95, [], [Option("Ice cream scoop", "بولة آيس كريم", 25)]);
        Item(9502, "Om Ali", "أم علي", desserts, cold, 80, [], []);

        var hall = new DiningZone(Guid.NewGuid(), "Main hall", "الصالة الرئيسية", 1);
        var terrace = new DiningZone(Guid.NewGuid(), "Terrace", "التراس", 2);
        db.DiningZones.AddRange(hall, terrace);
        for (var i = 0; i < 12; i++)
            db.DiningTables.Add(new DiningTable(Guid.NewGuid(), hall.Id, (i + 1).ToString(), i % 3 == 0 ? 6 : 4, (i % 4) * 3, i / 4 * 3,
                i % 3 == 0 ? TableShape.Long : i % 2 == 0 ? TableShape.Round : TableShape.Square));
        for (var i = 0; i < 6; i++)
            db.DiningTables.Add(new DiningTable(Guid.NewGuid(), terrace.Id, $"T{i + 1}", 2, (i % 3) * 4, i / 3 * 3, TableShape.Round));

        await db.SaveChangesAsync(cancellationToken);

        KitchenStation Station(string name, string nameAr, int order)
        {
            var station = new KitchenStation(Guid.NewGuid(), name, nameAr, order);
            db.KitchenStations.Add(station);
            return station;
        }

        MenuCategory Category(string name, string nameAr, int order, string color)
        {
            var category = new MenuCategory(Guid.NewGuid(), name, nameAr, order, color);
            db.MenuCategories.Add(category);
            return category;
        }

        void Item(int code, string name, string nameAr, MenuCategory category, KitchenStation station, decimal price, MenuOption[] sizes, MenuOption[] modifiers)
        {
            var item = new MenuItem(Guid.NewGuid(), code, name, nameAr, category.Id, price, station.Id);
            item.SetOptions(sizes.Select(s => s with { Id = Guid.NewGuid() }).ToList(), modifiers.Select(m => m with { Id = Guid.NewGuid() }).ToList());
            db.MenuItems.Add(item);
        }

        static MenuOption Option(string name, string nameAr, decimal price) => new(Guid.Empty, name, nameAr, price);
    }
}

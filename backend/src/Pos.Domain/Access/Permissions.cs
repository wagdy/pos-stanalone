namespace Pos.Domain.Access;

// Who works the restaurant, by what they do:
// - a manager does everything: the menu, the floor, the staff, the printers and the integrations,
//   and authorises what only a manager may (a void after the kitchen, a discount past the limit);
// - a cashier takes orders at the till, settles checks, splits them, keeps the shift and its cash;
// - a captain (a waiter) takes table orders on a phone or tablet and sends them to the kitchen;
// - the kitchen works the kitchen screen: what to make, and what is made.
// Everyone but a manager signs in on a terminal with a four-digit PIN.
public enum UserRole
{
    Manager = 1,
    Cashier = 2,
    Captain = 3,
    Kitchen = 4,
}

// What a user may do, as the API's policies and the app's buttons read it.
public static class Permissions
{
    // Orders taken and sent to the kitchen: items added, notes, guests, a table opened.
    public const string OrdersTake = "orders.take";

    // Checks settled, split, transferred and merged; bills and receipts printed; customers attached.
    public const string OrdersSettle = "orders.settle";

    // A void after the kitchen, a discount, a check reopened: a manager's, or authorised by a
    // manager's PIN at the terminal.
    public const string OrdersAuthorize = "orders.authorize";

    // The kitchen screen: tickets seen and bumped as made.
    public const string KitchenWork = "kitchen.work";

    // The shift: opened with its float, paid-outs, closed with the cash counted, its Z report.
    public const string ShiftsManage = "shifts.manage";

    // The menu, the floor, the stations and printers, the staff's PINs and the integrations.
    public const string SetupManage = "setup.manage";

    // Sales, voids and shifts over time.
    public const string ReportsView = "reports.view";

    // The system's users: added, changed, deactivated, their passwords and PINs reset.
    public const string UsersManage = "users.manage";

    // Company Settings: the name and logo, the currency, the country, the time zone.
    public const string SettingsManage = "settings.manage";

    public static IReadOnlyList<string> All { get; } =
        [OrdersTake, OrdersSettle, OrdersAuthorize, KitchenWork, ShiftsManage, SetupManage, ReportsView, UsersManage, SettingsManage];
}

// What each role may do. Fail closed: a role missing here gets nothing.
public static class RolePermissions
{
    private static readonly IReadOnlySet<string> None = new HashSet<string>();

    private static readonly IReadOnlyDictionary<UserRole, IReadOnlySet<string>> ByRole =
        new Dictionary<UserRole, IReadOnlySet<string>>
        {
            [UserRole.Manager] = new HashSet<string>(Permissions.All),
            [UserRole.Cashier] = new HashSet<string> { Permissions.OrdersTake, Permissions.OrdersSettle, Permissions.KitchenWork, Permissions.ShiftsManage },
            [UserRole.Captain] = new HashSet<string> { Permissions.OrdersTake },
            [UserRole.Kitchen] = new HashSet<string> { Permissions.KitchenWork },
        };

    public static IReadOnlySet<string> For(UserRole role) => ByRole.TryGetValue(role, out var permissions) ? permissions : None;

    public static bool Has(UserRole role, string permission) => For(role).Contains(permission);
}

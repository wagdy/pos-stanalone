using Pos.Domain.Access;
using Pos.Domain.Integrations;

namespace Pos.Application.Common;

// Who is doing it: the signed-in user, from their token.
public sealed record Actor(string Id, string Name, UserRole Role)
{
    public bool Can(string permission) => RolePermissions.Has(Role, permission);
}

// A member of staff as their PIN finds them.
public sealed record StaffMember(string Id, string Name, UserRole Role);

// Who a PIN belongs to: an active member of staff, or no one.
public interface IStaffDirectory
{
    Task<StaffMember?> ByPinAsync(string? pin, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<StaffMember>> ActiveAsync(CancellationToken cancellationToken = default);
}

// Tells every terminal, captain's phone and kitchen screen what changed, at once (SignalR). Each
// reloads what it shows of it: nothing is pushed but ids.
public interface IPosNotifier
{
    Task OrdersChangedAsync(IReadOnlyCollection<Guid> orderIds, CancellationToken cancellationToken = default);

    Task FloorChangedAsync(CancellationToken cancellationToken = default);

    Task KitchenChangedAsync(CancellationToken cancellationToken = default);

    Task ShiftChangedAsync(CancellationToken cancellationToken = default);

    Task SyncChangedAsync(CancellationToken cancellationToken = default);

    Task MenuChangedAsync(CancellationToken cancellationToken = default);

    // A document for a terminal's browser to print: the printer has no network address.
    Task PrintRequestedAsync(BrowserPrintJob job, CancellationToken cancellationToken = default);
}

// What can be printed.
public enum PrintDocumentKind
{
    // The check for the guest, before paying (شيك الحساب).
    Bill = 1,

    // The paid receipt (فاتورة الدفع).
    Receipt = 2,

    // A kitchen ticket (بون المطبخ): new, add-on, void or transfer.
    KitchenTicket = 3,

    // A shift's Z report.
    ZReport = 4,

    // A printer's test page.
    Test = 5,
}

// One thing to print: what it is, what it is of (the check, the ticket, the shift), and on which
// printer; none, the cashier's.
public sealed record PrintRequest(PrintDocumentKind Kind, Guid SubjectId, Guid? PrinterId = null, Guid? StationId = null);

// A print a terminal's browser does: it fetches the document's subject and prints it at 80 mm.
public sealed record BrowserPrintJob(Guid Id, PrintDocumentKind Kind, Guid SubjectId, Guid? PrinterId, string? PrinterName, Guid? StationId);

// Sends documents to the printers: a network printer gets ESC/POS from the print queue, a browser
// printer a request to the terminals.
public interface IPrintSpooler
{
    Task PrintAsync(IReadOnlyList<PrintRequest> requests, CancellationToken cancellationToken = default);
}

// A customer as the loyalty system knows them.
public sealed record LoyaltyCustomer(string UserId, string? Name, string? Phone, int Points, string? Tier);

// The online ordering & loyalty system, live: a customer found by phone or by their card, their
// points, a redemption. Throws LinkUnavailableException when it is off or cannot be reached; the
// till goes on with what it knows.
public interface ILoyaltyGateway
{
    bool IsEnabled { get; }

    Task<LoyaltyCustomer?> FindByPhoneAsync(string phone, CancellationToken cancellationToken = default);

    Task<int> PointsAsync(string loyaltyUserId, CancellationToken cancellationToken = default);

    Task RedeemAsync(string loyaltyUserId, int points, Guid orderId, CancellationToken cancellationToken = default);
}

// A linked system that is off or cannot be reached right now.
public sealed class LinkUnavailableException(string message, Exception? inner = null) : Exception(message, inner);

// What a test of a link found.
public sealed record LinkTestResult(bool Ok, string Message);

// Talks to a linked system: tests it, sends it what is queued, and asks the HR system for its staff.
public interface ILinkGateway
{
    Task<LinkTestResult> TestAsync(IntegrationLink link, CancellationToken cancellationToken = default);

    // Throws LinkUnavailableException to try again later; LinkRefusedException when trying again
    // will not help.
    Task SendAsync(IntegrationLink link, SyncItem item, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<HrStaffMember>> HrStaffAsync(IntegrationLink link, CancellationToken cancellationToken = default);
}

// The system answered, and said no.
public sealed class LinkRefusedException(string message) : Exception(message);

// A member of staff as the HR system sends them: their PIN for the till too.
public sealed record HrStaffMember(string EmployeeId, string Name, string? Role, string? Pin, bool IsActive);

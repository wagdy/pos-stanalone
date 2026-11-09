using Pos.Application.Common;
using Pos.Domain.Access;
using Pos.Domain.Catalog;
using Pos.Domain.Common;
using Pos.Domain.Customers;
using Pos.Domain.Kitchen;
using Pos.Domain.Orders;

namespace Pos.Application.Orders;

// Kitchen tickets as a check makes them: numbered for the day, and each station's part printed on
// the station's printer (a station with none sees it on the kitchen screen only).
internal sealed class KitchenDesk(IKitchenTicketRepository tickets, IKitchenStationRepository stations, IBusinessCalendar calendar)
{
    private readonly List<KitchenTicket> _made = [];

    // The tickets made in this request, to print once it is saved.
    public IReadOnlyList<KitchenTicket> Made => _made;

    public async Task<KitchenTicket> TicketAsync(
        Order order, TicketKind kind, IEnumerable<(OrderLine Line, int Quantity)> lines, Actor by, string? note, CancellationToken cancellationToken,
        int? number = null)
    {
        var today = calendar.BusinessDateOf(DateTime.UtcNow);
        var ticket = new KitchenTicket(
            Guid.NewGuid(), number ?? await NextNumberAsync(today, cancellationToken), today, kind, order, by.Name, note);
        foreach (var (line, quantity) in lines)
            ticket.Add(Guid.NewGuid(), line, quantity);
        tickets.Add(ticket);
        _made.Add(ticket);
        return ticket;
    }

    // The next number, counting the tickets made in this request too.
    public async Task<int> NextNumberAsync(DateOnly day, CancellationToken cancellationToken) =>
        Math.Max(await tickets.NextNumberAsync(day, cancellationToken), _made.Where(t => t.BusinessDate == day).Select(t => t.Number + 1).DefaultIfEmpty(1).Max());

    // Each ticket made, to each of its stations' printers.
    public async Task<IReadOnlyList<PrintRequest>> PrintsAsync(CancellationToken cancellationToken)
    {
        if (_made.Count == 0)
            return [];
        var printers = (await stations.GetAllAsync(cancellationToken)).Where(s => s.PrinterId is not null).ToDictionary(s => s.Id, s => s.PrinterId!.Value);
        return _made
            .SelectMany(t => t.Lines.Select(l => l.StationId).Distinct()
                .Where(s => s is { } id && printers.ContainsKey(id))
                .Select(s => new PrintRequest(PrintDocumentKind.KitchenTicket, t.Id, printers[s!.Value], s)))
            .ToList();
    }
}

// Who says a manager's yes: the manager doing it, or a manager's PIN typed at the terminal. Null
// when there is neither; a PIN typed that is no manager's is refused outright.
internal sealed class ManagerAuthority(IStaffDirectory staff)
{
    public async Task<string?> ApproverAsync(Actor actor, string? pin, CancellationToken cancellationToken)
    {
        if (actor.Can(Permissions.OrdersAuthorize))
            return actor.Name;
        if (string.IsNullOrWhiteSpace(pin))
            return null;
        var found = await staff.ByPinAsync(pin, cancellationToken);
        if (found is null || !RolePermissions.Has(found.Role, Permissions.OrdersAuthorize))
            throw new ForbiddenException("That PIN is not a manager's. · الرقم السري ليس لمدير.");
        return found.Name;
    }
}

// A check as the screens show it: with its kitchen tickets, and its customer's points.
internal sealed class OrderReader(IKitchenTicketRepository tickets, ICustomerRepository customers)
{
    public async Task<OrderDto> DtoAsync(Order order, CancellationToken cancellationToken)
    {
        var customer = order.CustomerId is { } id ? await customers.GetByIdAsync(id, cancellationToken) : null;
        return OrderMapping.Dto(order, await tickets.GetForOrderAsync(order.Id, cancellationToken), customer?.PointsBalance, customer?.Tier);
    }
}

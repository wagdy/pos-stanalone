using MediatR;
using Pos.Application.Common;
using Pos.Domain.Common;
using Pos.Domain.Kitchen;
using Pos.Domain.Orders;

namespace Pos.Application.Kitchen;

// The kitchen screen (KDS, /pos/kds): each ticket not yet done, oldest first, at every station or one;
// a station bumps its part when it is made (or, for a void or a move, seen), and can call back what
// it bumped by mistake. Bumping what the kitchen made marks those items prepared on the check.

public sealed record TicketLineDto(Guid Id, Guid OrderLineId, Guid? StationId, string? StationName, int Code, string Name, string? NameAr,
    string? SizeName, string Modifiers, string? Notes, int Quantity, DateTime? DoneAtUtc);

public sealed record TicketDto(Guid Id, int Number, TicketKind Kind, Guid OrderId, int OrderNumber, OrderType OrderType, string? TableLabel,
    string? CheckLabel, int Guests, string CreatedBy, DateTime CreatedAtUtc, string? Note, bool IsDone, IReadOnlyList<TicketLineDto> Lines);

public sealed record KitchenBoardDto(IReadOnlyList<TicketDto> Active, IReadOnlyList<TicketDto> RecentlyDone);

internal static class TicketMapping
{
    public static TicketDto Dto(KitchenTicket t) => new(
        t.Id, t.Number, t.Kind, t.OrderId, t.OrderNumber, t.OrderType, t.TableLabel, t.CheckLabel, t.Guests, t.CreatedBy, t.CreatedAtUtc, t.Note,
        t.IsDone,
        t.Lines.Select(l => new TicketLineDto(l.Id, l.OrderLineId, l.StationId, l.StationName, l.Code, l.Name, l.NameAr, l.SizeName, l.Modifiers,
            l.Notes, l.Quantity, l.DoneAtUtc)).ToList());
}

// StationId: one station's part of each ticket; none, all of it.
public sealed record GetKitchenBoardQuery(Guid? StationId) : IRequest<KitchenBoardDto>;

internal sealed class GetKitchenBoardHandler(IKitchenTicketRepository tickets) : IRequestHandler<GetKitchenBoardQuery, KitchenBoardDto>
{
    public async Task<KitchenBoardDto> Handle(GetKitchenBoardQuery request, CancellationToken cancellationToken)
    {
        bool Mine(KitchenTicketLine l) => request.StationId is null || l.StationId == request.StationId;
        var active = (await tickets.GetActiveAsync(cancellationToken))
            .Where(t => t.Lines.Any(l => Mine(l) && l.DoneAtUtc is null))
            .OrderBy(t => t.CreatedAtUtc).Select(TicketMapping.Dto).ToList();
        var done = (await tickets.GetRecentlyDoneAsync(DateTime.UtcNow.AddMinutes(-30), cancellationToken))
            .Where(t => t.Lines.Any(Mine) && t.Lines.Where(Mine).All(l => l.DoneAtUtc is not null))
            .OrderByDescending(t => t.Lines.Max(l => l.DoneAtUtc)).Take(12).Select(TicketMapping.Dto).ToList();
        return new KitchenBoardDto(active, done);
    }
}

public sealed record GetTicketQuery(Guid TicketId) : IRequest<TicketDto>;

internal sealed class GetTicketHandler(IKitchenTicketRepository tickets) : IRequestHandler<GetTicketQuery, TicketDto>
{
    public async Task<TicketDto> Handle(GetTicketQuery request, CancellationToken cancellationToken) =>
        TicketMapping.Dto(await tickets.GetRequiredAsync(request.TicketId, cancellationToken));
}

// A station's part done; StationId none: the lines made at no station.
public sealed record BumpTicketCommand(Guid TicketId, Guid? StationId, bool AllStations, Actor By) : IRequest<TicketDto>;

internal sealed class BumpTicketHandler(IKitchenTicketRepository tickets, IOrderRepository orders, IPosNotifier notifier, IUnitOfWork unitOfWork)
    : IRequestHandler<BumpTicketCommand, TicketDto>
{
    public async Task<TicketDto> Handle(BumpTicketCommand request, CancellationToken cancellationToken)
    {
        var ticket = await tickets.GetRequiredAsync(request.TicketId, cancellationToken);
        var stations = request.AllStations ? ticket.Lines.Select(l => l.StationId).Distinct().ToList() : [request.StationId];
        var made = stations.SelectMany(s => ticket.Bump(s, DateTime.UtcNow)).ToList();
        if (made.Count > 0 && await orders.GetByIdAsync(ticket.OrderId, cancellationToken) is { IsClosed: false } order)
            order.Prepared(made, DateTime.UtcNow);
        await unitOfWork.SaveChangesAsync(cancellationToken);
        await notifier.KitchenChangedAsync(cancellationToken);
        if (made.Count > 0)
            await notifier.OrdersChangedAsync([ticket.OrderId], cancellationToken);
        return TicketMapping.Dto(ticket);
    }
}

public sealed record RecallTicketCommand(Guid TicketId, Guid? StationId, Actor By) : IRequest<TicketDto>;

internal sealed class RecallTicketHandler(IKitchenTicketRepository tickets, IPosNotifier notifier, IUnitOfWork unitOfWork)
    : IRequestHandler<RecallTicketCommand, TicketDto>
{
    public async Task<TicketDto> Handle(RecallTicketCommand request, CancellationToken cancellationToken)
    {
        var ticket = await tickets.GetRequiredAsync(request.TicketId, cancellationToken);
        ticket.Recall(request.StationId);
        await unitOfWork.SaveChangesAsync(cancellationToken);
        await notifier.KitchenChangedAsync(cancellationToken);
        return TicketMapping.Dto(ticket);
    }
}

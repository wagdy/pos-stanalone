using MediatR;
using Pos.Application.Common;
using Pos.Domain.Common;
using Pos.Domain.Floor;
using Pos.Domain.Orders;

namespace Pos.Application.Floor;

// The floor plan (خريطة الصالة): each area and its tables, each table as its open checks make it,
// free, taken, or waiting for its bill; and a manager's setting out of the areas and tables.

public enum TableState
{
    Available = 1,
    Occupied = 2,

    // Every check on it has its bill printed: the table waits to pay.
    BillRequested = 3,
}

public sealed record TableCheck(Guid OrderId, int Number, string? CheckLabel, OrderStatus Status, decimal Total, int Guests, string OpenedBy,
    DateTime OpenedAtUtc, bool HasDrafts);

public sealed record TableDto(Guid Id, Guid ZoneId, string Label, int Seats, int X, int Y, TableShape Shape, bool IsActive, TableState State,
    IReadOnlyList<TableCheck> Checks);

public sealed record ZoneDto(Guid Id, string Name, string? NameAr, int SortOrder);

public sealed record FloorDto(IReadOnlyList<ZoneDto> Zones, IReadOnlyList<TableDto> Tables);

public sealed record GetFloorQuery : IRequest<FloorDto>;

internal sealed class GetFloorHandler(IDiningZoneRepository zones, IDiningTableRepository tables, IOrderRepository orders)
    : IRequestHandler<GetFloorQuery, FloorDto>
{
    public async Task<FloorDto> Handle(GetFloorQuery request, CancellationToken cancellationToken)
    {
        var open = (await orders.GetOpenAsync(cancellationToken)).Where(o => o.TableId is not null).ToLookup(o => o.TableId!.Value);
        return new FloorDto(
            (await zones.GetAllAsync(cancellationToken)).OrderBy(z => z.SortOrder).ThenBy(z => z.Name)
                .Select(z => new ZoneDto(z.Id, z.Name, z.NameAr, z.SortOrder)).ToList(),
            (await tables.GetAllAsync(cancellationToken)).OrderBy(t => t.Y).ThenBy(t => t.X).Select(t =>
            {
                var checks = open[t.Id].OrderBy(o => o.CheckLabel).ThenBy(o => o.Number).Select(o =>
                    new TableCheck(o.Id, o.Number, o.CheckLabel, o.Status, o.Totals.Total, o.Guests, o.OpenedBy, o.OpenedAtUtc, o.HasDrafts)).ToList();
                var state = checks.Count == 0 ? TableState.Available
                    : checks.All(c => c.Status == OrderStatus.BillPrinted) ? TableState.BillRequested
                    : TableState.Occupied;
                return new TableDto(t.Id, t.ZoneId, t.Label, t.Seats, t.X, t.Y, t.Shape, t.IsActive, state, checks);
            }).ToList());
    }
}

public sealed record SaveZoneCommand(Guid Id, string Name, string? NameAr, int SortOrder) : IRequest<ZoneDto>;

internal sealed class SaveZoneHandler(IDiningZoneRepository zones, IPosNotifier notifier, IUnitOfWork unitOfWork) : IRequestHandler<SaveZoneCommand, ZoneDto>
{
    public async Task<ZoneDto> Handle(SaveZoneCommand request, CancellationToken cancellationToken)
    {
        var zone = await zones.GetByIdAsync(request.Id, cancellationToken);
        if (zone is null)
            zones.Add(zone = new DiningZone(request.Id, request.Name, request.NameAr, request.SortOrder));
        else
            zone.Update(request.Name, request.NameAr, request.SortOrder);
        await unitOfWork.SaveChangesAsync(cancellationToken);
        await notifier.FloorChangedAsync(cancellationToken);
        return new ZoneDto(zone.Id, zone.Name, zone.NameAr, zone.SortOrder);
    }
}

public sealed record DeleteZoneCommand(Guid Id) : IRequest;

internal sealed class DeleteZoneHandler(IDiningZoneRepository zones, IDiningTableRepository tables, IPosNotifier notifier, IUnitOfWork unitOfWork)
    : IRequestHandler<DeleteZoneCommand>
{
    public async Task Handle(DeleteZoneCommand request, CancellationToken cancellationToken)
    {
        var zone = await zones.GetRequiredAsync(request.Id, cancellationToken);
        if ((await tables.GetAllAsync(cancellationToken)).Any(t => t.ZoneId == zone.Id))
            throw new DomainException("Move or delete its tables first. · انقل الترابيزات أو احذفها أولاً.");
        zones.Remove(zone);
        await unitOfWork.SaveChangesAsync(cancellationToken);
        await notifier.FloorChangedAsync(cancellationToken);
    }
}

public sealed record SaveTableCommand(Guid Id, Guid ZoneId, string Label, int Seats, int X, int Y, TableShape Shape, bool IsActive) : IRequest;

internal sealed class SaveTableHandler(IDiningZoneRepository zones, IDiningTableRepository tables, IPosNotifier notifier, IUnitOfWork unitOfWork)
    : IRequestHandler<SaveTableCommand>
{
    public async Task Handle(SaveTableCommand request, CancellationToken cancellationToken)
    {
        await zones.GetRequiredAsync(request.ZoneId, cancellationToken);
        if (await tables.LabelTakenAsync(request.Label?.Trim() ?? string.Empty, request.Id, cancellationToken))
            throw new DomainException($"Table {request.Label?.Trim()} is there already. · الترابيزة موجودة.");
        var table = await tables.GetByIdAsync(request.Id, cancellationToken);
        if (table is null)
            tables.Add(new DiningTable(request.Id, request.ZoneId, request.Label!, request.Seats, request.X, request.Y, request.Shape));
        else
            table.Update(request.ZoneId, request.Label!, request.Seats, request.X, request.Y, request.Shape, request.IsActive);
        await unitOfWork.SaveChangesAsync(cancellationToken);
        await notifier.FloorChangedAsync(cancellationToken);
    }
}

// A free table only: one with a check open is in use.
public sealed record DeleteTableCommand(Guid Id) : IRequest;

internal sealed class DeleteTableHandler(IDiningTableRepository tables, IOrderRepository orders, IPosNotifier notifier, IUnitOfWork unitOfWork)
    : IRequestHandler<DeleteTableCommand>
{
    public async Task Handle(DeleteTableCommand request, CancellationToken cancellationToken)
    {
        var table = await tables.GetRequiredAsync(request.Id, cancellationToken);
        if ((await orders.GetOpenOnTableAsync(table.Id, cancellationToken)).Count > 0)
            throw new DomainException("A check is open on it: close it first. · يوجد شيك مفتوح عليها.");
        tables.Remove(table);
        await unitOfWork.SaveChangesAsync(cancellationToken);
        await notifier.FloorChangedAsync(cancellationToken);
    }
}

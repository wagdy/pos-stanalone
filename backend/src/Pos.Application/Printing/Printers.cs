using MediatR;
using Pos.Application.Common;
using Pos.Domain.Catalog;
using Pos.Domain.Common;
using Pos.Domain.Printing;

namespace Pos.Application.Printing;

// The printers (Settings → Printers): the cashier's and each kitchen station's, in the browser or on
// the network; a test page; and any document printed again (a receipt, a ticket, a Z report).

public sealed record PrinterDto(Guid Id, string Name, PrinterConnection Connection, PrinterRole Role, string? Host, int Port, int CharactersPerLine,
    bool IsActive, IReadOnlyList<string> Stations);

public sealed record GetPrintersQuery : IRequest<IReadOnlyList<PrinterDto>>;

internal sealed class GetPrintersHandler(IPrinterRepository printers, IKitchenStationRepository stations) : IRequestHandler<GetPrintersQuery, IReadOnlyList<PrinterDto>>
{
    public async Task<IReadOnlyList<PrinterDto>> Handle(GetPrintersQuery request, CancellationToken cancellationToken)
    {
        var routed = (await stations.GetAllAsync(cancellationToken)).Where(s => s.PrinterId is not null).ToLookup(s => s.PrinterId!.Value, s => s.Name);
        return (await printers.GetAllAsync(cancellationToken)).OrderBy(p => p.Role).ThenBy(p => p.Name)
            .Select(p => new PrinterDto(p.Id, p.Name, p.Connection, p.Role, p.Host, p.Port, p.CharactersPerLine, p.IsActive, routed[p.Id].ToList()))
            .ToList();
    }
}

public sealed record SavePrinterCommand(Guid Id, string Name, PrinterConnection Connection, PrinterRole Role, string? Host, int Port,
    int CharactersPerLine, bool IsActive) : IRequest;

internal sealed class SavePrinterHandler(IPrinterRepository printers, IUnitOfWork unitOfWork) : IRequestHandler<SavePrinterCommand>
{
    public async Task Handle(SavePrinterCommand request, CancellationToken cancellationToken)
    {
        var printer = await printers.GetByIdAsync(request.Id, cancellationToken);
        if (printer is null)
            printers.Add(new Printer(request.Id, request.Name, request.Connection, request.Role, request.Host, request.Port, request.CharactersPerLine));
        else
            printer.Update(request.Name, request.Connection, request.Role, request.Host, request.Port, request.CharactersPerLine, request.IsActive);
        await unitOfWork.SaveChangesAsync(cancellationToken);
    }
}

// Its stations print nowhere after it, until another printer is chosen for them.
public sealed record DeletePrinterCommand(Guid Id) : IRequest;

internal sealed class DeletePrinterHandler(IPrinterRepository printers, IKitchenStationRepository stations, IUnitOfWork unitOfWork)
    : IRequestHandler<DeletePrinterCommand>
{
    public async Task Handle(DeletePrinterCommand request, CancellationToken cancellationToken)
    {
        var printer = await printers.GetRequiredAsync(request.Id, cancellationToken);
        foreach (var station in (await stations.GetAllAsync(cancellationToken)).Where(s => s.PrinterId == printer.Id))
            station.PrintOn(null);
        printers.Remove(printer);
        await unitOfWork.SaveChangesAsync(cancellationToken);
    }
}

// A document sent to a printer: a test page, or a check, ticket or Z report printed again.
public sealed record PrintCommand(PrintDocumentKind Kind, Guid SubjectId, Guid? PrinterId) : IRequest;

internal sealed class PrintHandler(IPrintSpooler spooler, IPrinterRepository printers) : IRequestHandler<PrintCommand>
{
    public async Task Handle(PrintCommand request, CancellationToken cancellationToken)
    {
        if (request.PrinterId is { } id)
            await printers.GetRequiredAsync(id, cancellationToken);
        else if (request.Kind == PrintDocumentKind.Test)
            throw new DomainException("Choose the printer to test.");
        await spooler.PrintAsync([new PrintRequest(request.Kind, request.SubjectId, request.PrinterId)], cancellationToken);
    }
}

using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Pos.Api.Auth;
using Pos.Application.Catalog;
using Pos.Application.Customers;
using Pos.Application.Floor;
using Pos.Application.Kitchen;
using Pos.Application.Printing;
using Pos.Application.Settings;
using Pos.Application.Shifts;
using Pos.Domain.Access;
using Pos.Domain.Floor;
using Pos.Domain.Printing;
using Pos.Domain.Shifts;
using Pos.Infrastructure.Setup;

namespace Pos.Api.Controllers;

// The menu (/api/menu): read whole by every screen; kept by a manager.
[ApiController]
[Route("api/menu")]
[Authorize]
public sealed class MenuController(ISender sender) : ControllerBase
{
    [HttpGet]
    [Authorize]
    public Task<MenuDto> Get(CancellationToken cancellationToken) => sender.Send(new GetMenuQuery(), cancellationToken);

    [Authorize(Policy = Permissions.SetupManage)]
    [HttpPut("stations/{id:guid}")]
    public Task<StationDto> SaveStation(Guid id, StationRequest r, CancellationToken cancellationToken) =>
        sender.Send(new SaveStationCommand(id, r.Name, r.NameAr, r.SortOrder, r.PrinterId), cancellationToken);

    [Authorize(Policy = Permissions.SetupManage)]
    [HttpDelete("stations/{id:guid}")]
    public async Task<IActionResult> DeleteStation(Guid id, CancellationToken cancellationToken)
    {
        await sender.Send(new DeleteStationCommand(id), cancellationToken);
        return NoContent();
    }

    [Authorize(Policy = Permissions.SetupManage)]
    [HttpPut("categories/{id:guid}")]
    public Task<CategoryDto> SaveCategory(Guid id, CategoryRequest r, CancellationToken cancellationToken) =>
        sender.Send(new SaveCategoryCommand(id, r.Name, r.NameAr, r.SortOrder, r.Color, r.IsActive), cancellationToken);

    [Authorize(Policy = Permissions.SetupManage)]
    [HttpPut("items/{id:guid}")]
    public Task<MenuItemDto> SaveItem(Guid id, MenuItemRequest r, CancellationToken cancellationToken) =>
        sender.Send(new SaveMenuItemCommand(id, r.Code, r.Name, r.NameAr, r.CategoryId, r.StationId, r.Price, r.IsActive, r.Sizes ?? [], r.Modifiers ?? []),
            cancellationToken);
}

public sealed record StationRequest(string Name, string? NameAr, int SortOrder, Guid? PrinterId);

public sealed record CategoryRequest(string Name, string? NameAr, int SortOrder, string? Color, bool IsActive = true);

public sealed record MenuItemRequest(int Code, string Name, string? NameAr, Guid CategoryId, Guid? StationId, decimal Price, bool IsActive,
    IReadOnlyList<OptionDto>? Sizes, IReadOnlyList<OptionDto>? Modifiers);

// The floor plan (/api/floor): every table as its checks make it; set out by a manager.
[ApiController]
[Route("api/floor")]
[Authorize]
public sealed class FloorController(ISender sender) : ControllerBase
{
    [HttpGet]
    [Authorize]
    public Task<FloorDto> Get(CancellationToken cancellationToken) => sender.Send(new GetFloorQuery(), cancellationToken);

    [Authorize(Policy = Permissions.SetupManage)]
    [HttpPut("zones/{id:guid}")]
    public Task<ZoneDto> SaveZone(Guid id, ZoneRequest r, CancellationToken cancellationToken) =>
        sender.Send(new SaveZoneCommand(id, r.Name, r.NameAr, r.SortOrder), cancellationToken);

    [Authorize(Policy = Permissions.SetupManage)]
    [HttpDelete("zones/{id:guid}")]
    public async Task<IActionResult> DeleteZone(Guid id, CancellationToken cancellationToken)
    {
        await sender.Send(new DeleteZoneCommand(id), cancellationToken);
        return NoContent();
    }

    [Authorize(Policy = Permissions.SetupManage)]
    [HttpPut("tables/{id:guid}")]
    public async Task<IActionResult> SaveTable(Guid id, TableRequest r, CancellationToken cancellationToken)
    {
        await sender.Send(new SaveTableCommand(id, r.ZoneId, r.Label, r.Seats, r.X, r.Y, r.Shape, r.IsActive), cancellationToken);
        return NoContent();
    }

    [Authorize(Policy = Permissions.SetupManage)]
    [HttpDelete("tables/{id:guid}")]
    public async Task<IActionResult> DeleteTable(Guid id, CancellationToken cancellationToken)
    {
        await sender.Send(new DeleteTableCommand(id), cancellationToken);
        return NoContent();
    }
}

public sealed record ZoneRequest(string Name, string? NameAr, int SortOrder);

public sealed record TableRequest(Guid ZoneId, string Label, int Seats, int X, int Y, TableShape Shape = TableShape.Square, bool IsActive = true);

// The kitchen screen (/api/kitchen): the tickets to make, bumped as made.
[ApiController]
[Route("api/kitchen")]
[Authorize]
public sealed class KitchenController(ISender sender) : ControllerBase
{
    [Authorize(Policy = Permissions.KitchenWork)]
    [HttpGet]
    public Task<KitchenBoardDto> Get([FromQuery] Guid? stationId, CancellationToken cancellationToken) =>
        sender.Send(new GetKitchenBoardQuery(stationId), cancellationToken);

    [HttpGet("tickets/{ticketId:guid}")]
    [Authorize]
    public Task<TicketDto> GetTicket(Guid ticketId, CancellationToken cancellationToken) => sender.Send(new GetTicketQuery(ticketId), cancellationToken);

    [Authorize(Policy = Permissions.KitchenWork)]
    [HttpPost("tickets/{ticketId:guid}/bump")]
    public Task<TicketDto> Bump(Guid ticketId, BumpRequest request, CancellationToken cancellationToken) =>
        sender.Send(new BumpTicketCommand(ticketId, request.StationId, request.AllStations, Actors.Of(User)), cancellationToken);

    [Authorize(Policy = Permissions.KitchenWork)]
    [HttpPost("tickets/{ticketId:guid}/recall")]
    public Task<TicketDto> Recall(Guid ticketId, BumpRequest request, CancellationToken cancellationToken) =>
        sender.Send(new RecallTicketCommand(ticketId, request.StationId, Actors.Of(User)), cancellationToken);
}

public sealed record BumpRequest(Guid? StationId, bool AllStations = false);

// Customers and their loyalty points (/api/customers): found by phone, name or card, registered.
[ApiController]
[Route("api/customers")]
[Authorize(Policy = Permissions.OrdersTake)]
public sealed class CustomersController(ISender sender) : ControllerBase
{
    [HttpGet]
    public Task<IReadOnlyList<CustomerDto>> Search([FromQuery] string? search, CancellationToken cancellationToken) =>
        sender.Send(new SearchCustomersQuery(search ?? string.Empty), cancellationToken);

    [HttpGet("card/{code}")]
    public Task<CustomerDto> ByCard(string code, CancellationToken cancellationToken) => sender.Send(new FindByCardQuery(code), cancellationToken);

    [HttpGet("{id:guid}")]
    public Task<CustomerDto> Get(Guid id, CancellationToken cancellationToken) => sender.Send(new GetCustomerQuery(id), cancellationToken);

    [HttpPost]
    public Task<CustomerDto> Register(RegisterCustomerRequest r, CancellationToken cancellationToken) =>
        sender.Send(new RegisterCustomerCommand(r.Id, r.Name, r.Phone, Actors.Of(User)), cancellationToken);
}

public sealed record RegisterCustomerRequest(Guid Id, string Name, string Phone);

// The shift and its Z report (/api/shifts), and clocking in and out.
[ApiController]
[Route("api/shifts")]
[Authorize]
public sealed class ShiftsController(ISender sender) : ControllerBase
{
    [HttpGet("current")]
    [Authorize]
    public Task<ShiftDto?> Current(CancellationToken cancellationToken) => sender.Send(new GetCurrentShiftQuery(), cancellationToken);

    [Authorize(Policy = Permissions.ShiftsManage)]
    [HttpGet]
    public Task<IReadOnlyList<ShiftDto>> Recent([FromQuery] int take, CancellationToken cancellationToken) =>
        sender.Send(new GetShiftsQuery(take == 0 ? 30 : take), cancellationToken);

    [Authorize(Policy = Permissions.ShiftsManage)]
    [HttpGet("{shiftId:guid}/report")]
    public Task<ZReportDto> Report(Guid shiftId, CancellationToken cancellationToken) => sender.Send(new GetZReportQuery(shiftId), cancellationToken);

    [Authorize(Policy = Permissions.ShiftsManage)]
    [HttpPost]
    public Task<ShiftDto> Open(OpenShiftRequest r, CancellationToken cancellationToken) =>
        sender.Send(new OpenShiftCommand(r.ShiftId, r.OpeningFloat, Actors.Of(User)), cancellationToken);

    [Authorize(Policy = Permissions.ShiftsManage)]
    [HttpPost("paid-outs")]
    public Task<ShiftDto> PayOut(PayOutRequest r, CancellationToken cancellationToken) =>
        sender.Send(new PayOutCommand(r.PaidOutId, r.Kind, r.Amount, r.Reason, r.StaffName, Actors.Of(User)), cancellationToken);

    [Authorize(Policy = Permissions.ShiftsManage)]
    [HttpPost("{shiftId:guid}/close")]
    public Task<ZReportDto> Close(Guid shiftId, CloseShiftRequest r, CancellationToken cancellationToken) =>
        sender.Send(new CloseShiftCommand(shiftId, r.CountedCash, r.Print, Actors.Of(User)), cancellationToken);

    // In or out: by the PIN typed, or the one signed in.
    [HttpPost("/api/clock")]
    [Authorize]
    public Task<ClockResultDto> Clock(ClockRequest r, CancellationToken cancellationToken) =>
        sender.Send(new ClockCommand(r.Pin, Actors.Of(User)), cancellationToken);
}

public sealed record OpenShiftRequest(Guid ShiftId, decimal OpeningFloat);

public sealed record PayOutRequest(Guid PaidOutId, PaidOutKind Kind, decimal Amount, string Reason, string? StaffName);

public sealed record CloseShiftRequest(decimal CountedCash, bool Print = true);

public sealed record ClockRequest(string? Pin);

// Printers, POS settings and the sample restaurant (/api/setup): a manager's.
[ApiController]
[Route("api/setup")]
[Authorize]
public sealed class SetupController(ISender sender) : ControllerBase
{
    [Authorize(Policy = Permissions.SetupManage)]
    [HttpGet("printers")]
    public Task<IReadOnlyList<PrinterDto>> Printers(CancellationToken cancellationToken) => sender.Send(new GetPrintersQuery(), cancellationToken);

    [Authorize(Policy = Permissions.SetupManage)]
    [HttpPut("printers/{id:guid}")]
    public async Task<IActionResult> SavePrinter(Guid id, PrinterRequest r, CancellationToken cancellationToken)
    {
        await sender.Send(new SavePrinterCommand(id, r.Name, r.Connection, r.Role, r.Host, r.Port, r.CharactersPerLine, r.IsActive), cancellationToken);
        return NoContent();
    }

    [Authorize(Policy = Permissions.SetupManage)]
    [HttpDelete("printers/{id:guid}")]
    public async Task<IActionResult> DeletePrinter(Guid id, CancellationToken cancellationToken)
    {
        await sender.Send(new DeletePrinterCommand(id), cancellationToken);
        return NoContent();
    }

    // A document printed (again): a test page, a check, a receipt, a ticket, a Z report.
    [HttpPost("/api/print")]
    [Authorize(Policy = Permissions.OrdersTake)]
    public async Task<IActionResult> Print(PrintRequestBody r, CancellationToken cancellationToken)
    {
        await sender.Send(new PrintCommand(r.Kind, r.SubjectId, r.PrinterId), cancellationToken);
        return Accepted();
    }

    [HttpGet("pos-settings")]
    [Authorize]
    public Task<PosSettingsDto> Settings(CancellationToken cancellationToken) => sender.Send(new GetPosSettingsQuery(), cancellationToken);

    [Authorize(Policy = Permissions.SetupManage)]
    [HttpPut("pos-settings")]
    public Task<PosSettingsDto> SaveSettings(PosSettingsRequest r, CancellationToken cancellationToken) =>
        sender.Send(new SavePosSettingsCommand(r.TaxPercent, r.ServicePercent, r.ReceiptHeader, r.ReceiptFooter, r.TaxNumber, r.PointsPerCurrencyUnit,
            r.RedemptionValuePer100Points, r.CashierDiscountLimitPercent, r.VoidReasons ?? [], r.QuickNotes ?? [], Actors.Of(User)), cancellationToken);

    // Into an empty system only.
    [Authorize(Policy = Permissions.SetupManage)]
    [HttpPost("sample")]
    public async Task<IActionResult> LoadSample([FromServices] SampleRestaurant sample, CancellationToken cancellationToken)
    {
        await sample.LoadAsync(cancellationToken);
        return NoContent();
    }
}

public sealed record PrinterRequest(string Name, PrinterConnection Connection, PrinterRole Role, string? Host, int Port = 9100, int CharactersPerLine = 48,
    bool IsActive = true);

public sealed record PrintRequestBody(Pos.Application.Common.PrintDocumentKind Kind, Guid SubjectId, Guid? PrinterId);

public sealed record PosSettingsRequest(decimal TaxPercent, decimal ServicePercent, string? ReceiptHeader, string? ReceiptFooter, string? TaxNumber,
    decimal PointsPerCurrencyUnit, decimal RedemptionValuePer100Points, decimal CashierDiscountLimitPercent, IReadOnlyList<string>? VoidReasons,
    IReadOnlyList<string>? QuickNotes);

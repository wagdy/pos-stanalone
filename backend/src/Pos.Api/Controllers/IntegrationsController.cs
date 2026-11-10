using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Pos.Api.Auth;
using Pos.Application.Common;
using Pos.Application.Integrations;
using Pos.Domain.Access;
using Pos.Domain.Integrations;
using Pos.Domain.Orders;
using Pos.Infrastructure.Identity;
using Pos.Infrastructure.Integrations;

namespace Pos.Api.Controllers;

// Settings → Ecosystem integrations (/api/integrations): each linked system switched on and set up,
// tested; the sync queue and "Sync now"; a day's Costing sheets by hand; the HR system's staff.
// The header's light is everyone's to read.
[ApiController]
[Route("api/integrations")]
[Authorize]
public sealed class IntegrationsController(ISender sender) : ControllerBase
{
    [Authorize(Policy = Permissions.SetupManage)]
    [HttpGet("links")]
    public Task<IReadOnlyList<LinkDto>> Links(CancellationToken cancellationToken) => sender.Send(new GetLinksQuery(), cancellationToken);

    // An API key left empty keeps the one saved.
    [Authorize(Policy = Permissions.SetupManage)]
    [HttpPut("links/{system}")]
    public Task<LinkDto> Save(LinkedSystem system, LinkRequest r, CancellationToken cancellationToken) =>
        sender.Send(new SaveLinkCommand(system, r.Enabled, r.BaseUrl, r.ApiKey, r.BranchCode, Actors.Of(User)), cancellationToken);

    [Authorize(Policy = Permissions.SetupManage)]
    [HttpPost("links/{system}/test")]
    public Task<LinkDto> Test(LinkedSystem system, CancellationToken cancellationToken) => sender.Send(new TestLinkCommand(system), cancellationToken);

    [HttpGet("sync")]
    [Authorize]
    public Task<SyncStateDto> State(CancellationToken cancellationToken) => sender.Send(new GetSyncStateQuery(), cancellationToken);

    [HttpGet("sync/queue")]
    [Authorize(Policy = Permissions.OrdersSettle)]
    public Task<IReadOnlyList<SyncItemDto>> Queue([FromQuery] int take, CancellationToken cancellationToken) =>
        sender.Send(new GetSyncQueueQuery(take == 0 ? 100 : take), cancellationToken);

    [HttpPost("sync/now")]
    [Authorize(Policy = Permissions.OrdersSettle)]
    public Task<SyncStateDto> SyncNow(SyncNowRequest r, CancellationToken cancellationToken) =>
        sender.Send(new SyncNowCommand(r.RetryFailed, r.ItemId), cancellationToken);

    // A business day as Costing imports it: its Daily Sales sheet, the voids after the kitchen, the takings.
    [HttpGet("costing/sheet")]
    [Authorize(Policy = Permissions.ShiftsManage)]
    public async Task<IActionResult> CostingSheet([FromQuery] DateOnly date, [FromServices] IOrderRepository orders, [FromServices] ICompanyProfile company,
        [FromServices] Pos.Domain.Catalog.IMenuItemRepository items,
        CancellationToken cancellationToken)
    {
        var sizeCodes = (await items.GetAllAsync(cancellationToken)).SelectMany(i => i.Sizes).Where(z => z.Code is not null).ToDictionary(z => z.Id, z => z.Code!);
        var bytes = CostingSheets.Build(date, company.Current.Name, await orders.GetForDayAsync(date, cancellationToken), sizeCodes);
        return File(bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", $"costing-{date:yyyy-MM-dd}.xlsx");
    }

    // The costing system's menu taken as this POS's own (سحب المنيو من التكاليف).
    [Authorize(Policy = Permissions.SetupManage)]
    [HttpPost("costing/menu")]
    public Task<MenuPullResult> PullCostingMenu(CancellationToken cancellationToken) =>
        sender.Send(new PullCostingMenuCommand(Actors.Of(User)), cancellationToken);

    // The HR system's staff brought in: added or changed by their employee id, their PINs set.
    [Authorize(Policy = Permissions.SetupManage)]
    [HttpPost("hr/staff")]
    public async Task<StaffSyncResult> SyncStaff([FromServices] IIntegrationStore links, [FromServices] ILinkGateway gateway,
        [FromServices] UserDirectory users, CancellationToken cancellationToken)
    {
        var link = await links.GetAsync(LinkedSystem.Hr, cancellationToken);
        if (!link.IsReady)
            throw new Pos.Domain.Common.DomainException("Switch the HR system on first. · فعّل نظام الموارد البشرية أولاً.");
        var staff = await gateway.HrStaffAsync(link, cancellationToken);
        var (added, updated, skipped) = await users.SyncFromHrAsync(staff, cancellationToken);
        return new StaffSyncResult(staff.Count, added, updated, skipped);
    }
}

public sealed record LinkRequest(bool Enabled, string? BaseUrl, string? ApiKey, string? BranchCode);

public sealed record SyncNowRequest(bool RetryFailed = false, Guid? ItemId = null);

public sealed record StaffSyncResult(int Received, int Added, int Updated, int Skipped);

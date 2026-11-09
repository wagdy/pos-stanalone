using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Pos.Api.Auth;
using Pos.Application.Common;
using Pos.Application.Orders;
using Pos.Domain.Access;
using Pos.Domain.Orders;

namespace Pos.Api.Controllers;

// The checks (/api/orders): opened, items added and sent to the kitchen, voided, the bill printed,
// split, moved and merged, paid. Ids are made by the terminal or the phone: a request sent again
// changes nothing the second time. Taking an order is a captain's too; settling it is the till's.
[ApiController]
[Route("api/orders")]
[Authorize]
public sealed class OrdersController(ISender sender) : ControllerBase
{
    private Actor By => Actors.Of(User);

    [Authorize(Policy = Permissions.OrdersTake)]
    [HttpGet("open")]
    public Task<IReadOnlyList<OrderSummaryDto>> GetOpen(CancellationToken cancellationToken) => sender.Send(new GetOpenOrdersQuery(), cancellationToken);

    // Whole, for the terminal's own copy.
    [Authorize(Policy = Permissions.OrdersTake)]
    [HttpGet("open/full")]
    public Task<IReadOnlyList<OrderDto>> GetOpenFull(CancellationToken cancellationToken) => sender.Send(new GetOpenOrderDetailsQuery(), cancellationToken);

    [HttpGet]
    [Authorize(Policy = Permissions.OrdersSettle)]
    public Task<IReadOnlyList<OrderSummaryDto>> GetDay([FromQuery] DateOnly date, CancellationToken cancellationToken) =>
        sender.Send(new GetDayOrdersQuery(date), cancellationToken);

    [HttpGet("{orderId:guid}")]
    [Authorize]
    public Task<OrderDto> Get(Guid orderId, CancellationToken cancellationToken) => sender.Send(new GetOrderQuery(orderId), cancellationToken);

    [Authorize(Policy = Permissions.OrdersTake)]
    [HttpPost]
    public Task<OrderDto> Open(OpenOrderRequest request, CancellationToken cancellationToken) =>
        sender.Send(new OpenOrderCommand(request.OrderId, request.Type, request.TableId, request.Guests, By, request.CustomerName, request.CustomerPhone),
            cancellationToken);

    [Authorize(Policy = Permissions.OrdersTake)]
    [HttpPost("{orderId:guid}/items")]
    public Task<OrderDto> AddItems(Guid orderId, AddItemsRequest request, CancellationToken cancellationToken) =>
        sender.Send(new AddItemsCommand(orderId, request.Items ?? [], request.SendToKitchen, By), cancellationToken);

    [Authorize(Policy = Permissions.OrdersTake)]
    [HttpPut("{orderId:guid}/lines/{lineId:guid}")]
    public Task<OrderDto> ChangeLine(Guid orderId, Guid lineId, ChangeLineRequest request, CancellationToken cancellationToken) =>
        sender.Send(new ChangeLineCommand(orderId, lineId, request.Quantity, request.Notes, By), cancellationToken);

    [Authorize(Policy = Permissions.OrdersTake)]
    [HttpPost("{orderId:guid}/send")]
    public Task<OrderDto> Send(Guid orderId, CancellationToken cancellationToken) => sender.Send(new SendToKitchenCommand(orderId, By), cancellationToken);

    // Drafts freely; anything the kitchen has, with a manager's PIN (or as a manager), a reason, and
    // whether it was made.
    [Authorize(Policy = Permissions.OrdersTake)]
    [HttpPost("{orderId:guid}/voids")]
    public Task<OrderDto> Void(Guid orderId, VoidRequest request, CancellationToken cancellationToken) =>
        sender.Send(new VoidItemsCommand(orderId, request.Items ?? [], request.Reason, request.Outcome ?? StockOutcome.None, request.ManagerPin, By),
            cancellationToken);

    [Authorize(Policy = Permissions.OrdersTake)]
    [HttpPost("{orderId:guid}/bill")]
    public Task<OrderDto> PrintBill(Guid orderId, PrintBillRequest? request, CancellationToken cancellationToken) =>
        sender.Send(new PrintBillCommand(orderId, By, request?.Print ?? true), cancellationToken);

    [Authorize(Policy = Permissions.OrdersTake)]
    [HttpPut("{orderId:guid}")]
    public Task<OrderDto> Update(Guid orderId, UpdateOrderRequest request, CancellationToken cancellationToken) =>
        sender.Send(new UpdateOrderCommand(orderId, request.Guests, request.Notes, request.DeliveryAddress, request.DriverName, request.CustomerName,
            request.CustomerPhone, By), cancellationToken);

    [Authorize(Policy = Permissions.OrdersTake)]
    [HttpPost("{orderId:guid}/cancel")]
    public Task<OrderDto> Cancel(Guid orderId, ReasonRequest request, CancellationToken cancellationToken) =>
        sender.Send(new CancelOrderCommand(orderId, request.Reason, By), cancellationToken);

    // Every check on a table to another, free one; the kitchen told.
    [Authorize(Policy = Permissions.OrdersTake)]
    [HttpPost("/api/tables/{fromTableId:guid}/transfer")]
    public Task<IReadOnlyList<OrderDto>> Transfer(Guid fromTableId, TransferRequest request, CancellationToken cancellationToken) =>
        sender.Send(new TransferTableCommand(fromTableId, request.ToTableId, By), cancellationToken);

    // Another check's items onto this one.
    [Authorize(Policy = Permissions.OrdersTake)]
    [HttpPost("{orderId:guid}/merge")]
    public Task<OrderDto> Merge(Guid orderId, MergeRequest request, CancellationToken cancellationToken) =>
        sender.Send(new MergeChecksCommand(orderId, request.SourceOrderId, By), cancellationToken);

    [HttpPost("{orderId:guid}/split")]
    [Authorize(Policy = Permissions.OrdersSettle)]
    public Task<SplitResultDto> Split(Guid orderId, SplitRequest request, CancellationToken cancellationToken) =>
        sender.Send(new SplitCheckCommand(orderId, request.NewOrderId, request.Moves ?? [], By), cancellationToken);

    [HttpPost("{orderId:guid}/split-evenly")]
    [Authorize(Policy = Permissions.OrdersSettle)]
    public Task<OrderDto> SplitEvenly(Guid orderId, SplitEvenlyRequest request, CancellationToken cancellationToken) =>
        sender.Send(new SplitEvenlyCommand(orderId, request.Ways, By), cancellationToken);

    [HttpPost("{orderId:guid}/discount")]
    [Authorize(Policy = Permissions.OrdersSettle)]
    public Task<OrderDto> Discount(Guid orderId, DiscountRequest request, CancellationToken cancellationToken) =>
        sender.Send(new DiscountCommand(orderId, request.Amount, request.Percent, request.Reason, request.ManagerPin, By), cancellationToken);

    [Authorize(Policy = Permissions.OrdersTake)]
    [HttpPut("{orderId:guid}/customer")]
    public Task<OrderDto> AttachCustomer(Guid orderId, AttachCustomerRequest request, CancellationToken cancellationToken) =>
        sender.Send(new AttachCustomerCommand(orderId, request.CustomerId, By), cancellationToken);

    [HttpPost("{orderId:guid}/redeem")]
    [Authorize(Policy = Permissions.OrdersSettle)]
    public Task<OrderDto> Redeem(Guid orderId, RedeemRequest request, CancellationToken cancellationToken) =>
        sender.Send(new RedeemPointsCommand(orderId, request.Points, By), cancellationToken);

    [HttpPost("{orderId:guid}/pay")]
    [Authorize(Policy = Permissions.OrdersSettle)]
    public Task<OrderDto> Pay(Guid orderId, PayRequest request, CancellationToken cancellationToken) =>
        sender.Send(new PayCommand(orderId, request.Payments ?? [], request.PrintReceipt, By), cancellationToken);
}

public sealed record OpenOrderRequest(Guid OrderId, OrderType Type, Guid? TableId, int Guests, string? CustomerName = null, string? CustomerPhone = null);

public sealed record AddItemsRequest(IReadOnlyList<NewLine>? Items, bool SendToKitchen = false);

public sealed record ChangeLineRequest(int Quantity, string? Notes);

public sealed record VoidRequest(IReadOnlyList<VoidItem>? Items, string? Reason, StockOutcome? Outcome, string? ManagerPin);

public sealed record UpdateOrderRequest(int? Guests, string? Notes, string? DeliveryAddress, string? DriverName, string? CustomerName, string? CustomerPhone);

public sealed record ReasonRequest(string? Reason);

public sealed record TransferRequest(Guid ToTableId);

public sealed record MergeRequest(Guid SourceOrderId);

public sealed record SplitRequest(Guid NewOrderId, IReadOnlyList<SplitMove>? Moves);

public sealed record SplitEvenlyRequest(int Ways);

public sealed record DiscountRequest(decimal? Amount, decimal? Percent, string? Reason, string? ManagerPin);

public sealed record AttachCustomerRequest(Guid? CustomerId);

public sealed record RedeemRequest(int Points);

public sealed record PayRequest(IReadOnlyList<NewPayment>? Payments, bool PrintReceipt = true);

public sealed record PrintBillRequest(bool Print = true);

using MediatR;
using Pos.Application.Common;
using Pos.Application.Integrations;
using Pos.Domain.Catalog;
using Pos.Domain.Common;
using Pos.Domain.Customers;
using Pos.Domain.Floor;
using Pos.Domain.Integrations;
using Pos.Domain.Kitchen;
using Pos.Domain.Orders;
using Pos.Domain.Settings;
using Pos.Domain.Shifts;

namespace Pos.Application.Orders;

// Taking an order, from the till or a captain's phone: a check opened on a table (or for a
// takeaway or a delivery), items added as drafts, sent to the kitchen on a ticket, more added and
// sent on an add-on ticket; voided before the kitchen freely, after it only with a manager's PIN, a
// reason and what became of it, on a VOID ticket; the bill printed; split, moved, merged; paid.
// Every id is made by the screen, so a request sent again changes nothing the second time. Each
// change is told to every screen at once.

public sealed record NewLine(Guid LineId, Guid MenuItemId, Guid? SizeId, IReadOnlyList<Guid>? ModifierIds, int Quantity, string? Notes);

public sealed record VoidItem(Guid VoidId, Guid LineId, int Quantity);

public sealed record SplitMove(Guid LineId, int Quantity);

public sealed record NewPayment(Guid PaymentId, PaymentMethod Method, decimal Amount, decimal? Tendered, string? Reference);

public sealed record SplitResultDto(OrderDto Source, OrderDto Created);

public sealed record GetOrderQuery(Guid OrderId) : IRequest<OrderDto>;

internal sealed class GetOrderHandler(IOrderRepository orders, OrderReader reader) : IRequestHandler<GetOrderQuery, OrderDto>
{
    public async Task<OrderDto> Handle(GetOrderQuery request, CancellationToken cancellationToken) =>
        await reader.DtoAsync(await orders.GetRequiredAsync(request.OrderId, cancellationToken), cancellationToken);
}

// Every check not closed, the oldest first.
public sealed record GetOpenOrdersQuery : IRequest<IReadOnlyList<OrderSummaryDto>>;

internal sealed class GetOpenOrdersHandler(IOrderRepository orders) : IRequestHandler<GetOpenOrdersQuery, IReadOnlyList<OrderSummaryDto>>
{
    public async Task<IReadOnlyList<OrderSummaryDto>> Handle(GetOpenOrdersQuery request, CancellationToken cancellationToken) =>
        (await orders.GetOpenAsync(cancellationToken)).OrderBy(o => o.OpenedAtUtc).Select(OrderMapping.Summary).ToList();
}

// A business day's checks, the latest first: the receipts.
public sealed record GetDayOrdersQuery(DateOnly Date) : IRequest<IReadOnlyList<OrderSummaryDto>>;

internal sealed class GetDayOrdersHandler(IOrderRepository orders) : IRequestHandler<GetDayOrdersQuery, IReadOnlyList<OrderSummaryDto>>
{
    public async Task<IReadOnlyList<OrderSummaryDto>> Handle(GetDayOrdersQuery request, CancellationToken cancellationToken) =>
        (await orders.GetForDayAsync(request.Date, cancellationToken)).OrderByDescending(o => o.OpenedAtUtc).Select(OrderMapping.Summary).ToList();
}

// What every order command shares: the check, the menu, the day, saving and telling the screens.
internal sealed class OrderDesk(
    IOrderRepository orders,
    IDiningTableRepository tables,
    IPosSettingsStore settings,
    IBusinessCalendar calendar,
    KitchenDesk kitchen,
    OrderReader reader,
    IPrintSpooler printer,
    IPosNotifier notifier,
    IUnitOfWork unitOfWork)
{
    public IOrderRepository Orders => orders;
    public KitchenDesk Kitchen => kitchen;

    public DateOnly Today => calendar.BusinessDateOf(DateTime.UtcNow);

    public Task<Order> GetAsync(Guid orderId, CancellationToken cancellationToken) => orders.GetRequiredAsync(orderId, cancellationToken);

    public Task<PosSettings> SettingsAsync(CancellationToken cancellationToken) => settings.GetAsync(cancellationToken);

    public async Task<DiningTable> TableAsync(Guid tableId, CancellationToken cancellationToken)
    {
        var table = await tables.GetRequiredAsync(tableId, cancellationToken);
        if (!table.IsActive)
            throw new DomainException($"Table {table.Label} is not in use. · الترابيزة غير مستخدمة.");
        return table;
    }

    // The drafts to the kitchen on a ticket: the check's first, or an add-on with only what is new.
    public async Task SendAsync(Order order, Actor by, CancellationToken cancellationToken)
    {
        var addOn = order.HasBeenToKitchen;
        var number = await kitchen.NextNumberAsync(Today, cancellationToken);
        var sent = order.SendToKitchen(number, DateTime.UtcNow);
        await kitchen.TicketAsync(order, addOn ? TicketKind.AddOn : TicketKind.New, sent.Select(l => (l, l.Quantity)), by, null, cancellationToken, number);
    }

    // Saved, then printed and told: the kitchen tickets made, anything else asked, every screen.
    public async Task<OrderDto> DoneAsync(Order order, CancellationToken cancellationToken, IReadOnlyList<PrintRequest>? prints = null,
        bool floor = true, params Guid[] alsoChanged)
    {
        await unitOfWork.SaveChangesAsync(cancellationToken);
        await PrintAsync(prints, cancellationToken);
        await notifier.OrdersChangedAsync([order.Id, .. alsoChanged], cancellationToken);
        if (floor)
            await notifier.FloorChangedAsync(cancellationToken);
        if (kitchen.Made.Count > 0)
            await notifier.KitchenChangedAsync(cancellationToken);
        return await reader.DtoAsync(order, cancellationToken);
    }

    public async Task PrintAsync(IReadOnlyList<PrintRequest>? prints, CancellationToken cancellationToken)
    {
        var all = (await kitchen.PrintsAsync(cancellationToken)).Concat(prints ?? []).ToList();
        if (all.Count > 0)
            await printer.PrintAsync(all, cancellationToken);
    }

    public Task<OrderDto> ReadAsync(Order order, CancellationToken cancellationToken) => reader.DtoAsync(order, cancellationToken);

    // The next letter for a new check on the table, after those open on it: B after A.
    public async Task<string> NextLabelAsync(Order source, CancellationToken cancellationToken)
    {
        var open = source.TableId is { } tableId ? await orders.GetOpenOnTableAsync(tableId, cancellationToken) : [source];
        var last = open.Select(o => o.CheckLabel ?? "A").Append(source.CheckLabel ?? "A").Max(StringComparer.Ordinal)!;
        return last[0] >= 'Z' ? "Z" : ((char)(last[0] + 1)).ToString();
    }
}

public sealed record OpenOrderCommand(
    Guid OrderId, OrderType Type, Guid? TableId, int Guests, Actor By, string? CustomerName = null, string? CustomerPhone = null)
    : IRequest<OrderDto>, IRetryOnConflict;

internal sealed class OpenOrderHandler(OrderDesk desk) : IRequestHandler<OpenOrderCommand, OrderDto>
{
    public async Task<OrderDto> Handle(OpenOrderCommand request, CancellationToken cancellationToken)
    {
        if (await desk.Orders.GetByIdAsync(request.OrderId, cancellationToken) is { } opened)
            return await desk.ReadAsync(opened, cancellationToken);

        DiningTable? table = null;
        if (request.Type == OrderType.DineIn)
        {
            table = await desk.TableAsync(request.TableId ?? throw new DomainException("Choose the table. · اختر الترابيزة."), cancellationToken);
            if ((await desk.Orders.GetOpenOnTableAsync(table.Id, cancellationToken)).Count > 0)
                throw new DomainException($"Table {table.Label} has a check open: add to it. · الترابيزة عليها شيك مفتوح.");
        }

        var settings = await desk.SettingsAsync(cancellationToken);
        var today = desk.Today;
        var order = new Order(
            request.OrderId, await desk.Orders.NextNumberAsync(today, cancellationToken), today, request.Type, table, request.Guests, request.By.Id,
            request.By.Name, settings.ServicePercent, settings.TaxPercent);
        if (!string.IsNullOrWhiteSpace(request.CustomerName) || !string.IsNullOrWhiteSpace(request.CustomerPhone))
            order.AttachCustomer(null, request.CustomerName, request.CustomerPhone, null);
        desk.Orders.Add(order);
        return await desk.DoneAsync(order, cancellationToken);
    }
}

public sealed record AddItemsCommand(Guid OrderId, IReadOnlyList<NewLine> Items, bool SendToKitchen, Actor By) : IRequest<OrderDto>, IRetryOnConflict;

internal sealed class AddItemsHandler(OrderDesk desk, IMenuItemRepository menu, IKitchenStationRepository stations) : IRequestHandler<AddItemsCommand, OrderDto>
{
    public async Task<OrderDto> Handle(AddItemsCommand request, CancellationToken cancellationToken)
    {
        if (request.Items.Count == 0 && !request.SendToKitchen)
            throw new DomainException("Add at least one item. · أضف صنفاً.");
        var order = await desk.GetAsync(request.OrderId, cancellationToken);
        var items = (await menu.GetManyAsync(request.Items.Select(i => i.MenuItemId).Distinct().ToList(), cancellationToken)).ToDictionary(i => i.Id);
        var stationNames = (await stations.GetAllAsync(cancellationToken)).ToDictionary(s => s.Id, s => s.Name);
        foreach (var line in request.Items)
        {
            var item = items.GetValueOrDefault(line.MenuItemId) ?? throw new NotFoundException("Menu item", line.MenuItemId);
            var size = item.Size(line.SizeId);
            if (line.SizeId is not null && size is null)
                throw new DomainException($"{item.Name} has no such size. · الحجم غير موجود.");
            var modifiers = (line.ModifierIds ?? []).Distinct()
                .Select(id => item.Modifier(id) ?? throw new DomainException($"{item.Name} has no such modifier. · الإضافة غير موجودة."))
                .ToList();
            order.AddLine(line.LineId, item, size, modifiers, line.Quantity, line.Notes,
                item.StationId is { } s ? stationNames.GetValueOrDefault(s) : null, request.By.Name);
        }
        if (request.SendToKitchen && order.HasDrafts)
            await desk.SendAsync(order, request.By, cancellationToken);
        return await desk.DoneAsync(order, cancellationToken);
    }
}

// A draft's quantity or note.
public sealed record ChangeLineCommand(Guid OrderId, Guid LineId, int Quantity, string? Notes, Actor By) : IRequest<OrderDto>;

internal sealed class ChangeLineHandler(OrderDesk desk) : IRequestHandler<ChangeLineCommand, OrderDto>
{
    public async Task<OrderDto> Handle(ChangeLineCommand request, CancellationToken cancellationToken)
    {
        var order = await desk.GetAsync(request.OrderId, cancellationToken);
        order.ChangeDraft(request.LineId, request.Quantity, request.Notes);
        return await desk.DoneAsync(order, cancellationToken);
    }
}

public sealed record SendToKitchenCommand(Guid OrderId, Actor By) : IRequest<OrderDto>, IRetryOnConflict;

internal sealed class SendToKitchenHandler(OrderDesk desk) : IRequestHandler<SendToKitchenCommand, OrderDto>
{
    public async Task<OrderDto> Handle(SendToKitchenCommand request, CancellationToken cancellationToken)
    {
        var order = await desk.GetAsync(request.OrderId, cancellationToken);
        // Sent again after an answer was lost: there is nothing new.
        if (!order.HasDrafts && order.HasBeenToKitchen)
            return await desk.ReadAsync(order, cancellationToken);
        await desk.SendAsync(order, request.By, cancellationToken);
        return await desk.DoneAsync(order, cancellationToken);
    }
}

// Items off the check. Drafts go as voids before the kitchen. Anything the kitchen has goes as a void
// after it: a manager's PIN (or a manager), a reason, waste or back to stock, and a VOID ticket to
// the kitchen so it stops making it.
public sealed record VoidItemsCommand(
    Guid OrderId, IReadOnlyList<VoidItem> Items, string? Reason, StockOutcome Outcome, string? ManagerPin, Actor By)
    : IRequest<OrderDto>, IRetryOnConflict;

internal sealed class VoidItemsHandler(OrderDesk desk, ManagerAuthority authority) : IRequestHandler<VoidItemsCommand, OrderDto>
{
    public async Task<OrderDto> Handle(VoidItemsCommand request, CancellationToken cancellationToken)
    {
        var order = await desk.GetAsync(request.OrderId, cancellationToken);
        var done = order.Voids.Select(v => v.Id).ToHashSet();
        var items = request.Items.Where(i => !done.Contains(i.VoidId)).ToList();
        if (items.Count == 0)
            return await desk.ReadAsync(order, cancellationToken);

        var afterKitchen = items.Where(i => order.Line(i.LineId).Status != LineStatus.Draft).ToList();
        string? approver = null;
        int? ticketNumber = null;
        if (afterKitchen.Count > 0)
        {
            approver = await authority.ApproverAsync(request.By, request.ManagerPin, cancellationToken)
                ?? throw new ForbiddenException("A void after the kitchen needs a manager's PIN. · يلزم رقم المدير السري.");
            ticketNumber = await desk.Kitchen.NextNumberAsync(desk.Today, cancellationToken);
        }

        var lines = afterKitchen.Select(i => (Line: order.Line(i.LineId), i.Quantity)).ToList();
        foreach (var item in items)
            order.Void(item.VoidId, item.LineId, item.Quantity, request.Reason, request.Outcome, approver, request.By.Name, ticketNumber);

        if (lines.Count > 0)
        {
            var outcome = request.Outcome == StockOutcome.Waste ? "made: waste · هالك" : "not made: back to stock · يعود للمخزن";
            await desk.Kitchen.TicketAsync(order, TicketKind.Void, lines, request.By, $"{request.Reason} ({outcome}) · by {approver}",
                cancellationToken, ticketNumber);
        }
        return await desk.DoneAsync(order, cancellationToken);
    }
}

// The guest's bill (طباعة الشيك): printed on the cashier's printer; the table waits to pay.
public sealed record PrintBillCommand(Guid OrderId, Actor By) : IRequest<OrderDto>;

internal sealed class PrintBillHandler(OrderDesk desk) : IRequestHandler<PrintBillCommand, OrderDto>
{
    public async Task<OrderDto> Handle(PrintBillCommand request, CancellationToken cancellationToken)
    {
        var order = await desk.GetAsync(request.OrderId, cancellationToken);
        if (order.HasDrafts)
            throw new DomainException("Send the new items to the kitchen first. · أرسل الأصناف الجديدة أولاً.");
        order.PrintBill(DateTime.UtcNow);
        return await desk.DoneAsync(order, cancellationToken, [new PrintRequest(PrintDocumentKind.Bill, order.Id)]);
    }
}

// The bill's discount, by an amount or a share of it. A cashier's up to the limit set; past it, a
// manager's PIN.
public sealed record DiscountCommand(Guid OrderId, decimal? Amount, decimal? Percent, string? Reason, string? ManagerPin, Actor By) : IRequest<OrderDto>;

internal sealed class DiscountHandler(OrderDesk desk, ManagerAuthority authority) : IRequestHandler<DiscountCommand, OrderDto>
{
    public async Task<OrderDto> Handle(DiscountCommand request, CancellationToken cancellationToken)
    {
        var order = await desk.GetAsync(request.OrderId, cancellationToken);
        var settings = await desk.SettingsAsync(cancellationToken);
        var totals = order.Totals;
        var basis = totals.Gross - totals.LineDiscounts;
        if (request.Percent is < 0 or > 100)
            throw new DomainException("A discount is 0% to 100%.");
        var amount = request.Percent is { } percent ? Order.Round(basis * percent / 100) : request.Amount ?? 0;
        var share = basis == 0 ? 0 : amount * 100 / basis;
        var by = request.By.Name;
        if (amount > 0 && share > settings.CashierDiscountLimitPercent)
            by = await authority.ApproverAsync(request.By, request.ManagerPin, cancellationToken)
                ?? throw new ForbiddenException($"A discount over {settings.CashierDiscountLimitPercent:0.##}% needs a manager's PIN. · يلزم رقم المدير.");
        if (amount > 0 && string.IsNullOrWhiteSpace(request.Reason))
            throw new DomainException("Say why it is discounted. · سبب الخصم.");
        order.Discount(amount, request.Reason, by);
        return await desk.DoneAsync(order, cancellationToken);
    }
}

// The customer on the check (تسجيل عميل), or none.
public sealed record AttachCustomerCommand(Guid OrderId, Guid? CustomerId, Actor By) : IRequest<OrderDto>;

internal sealed class AttachCustomerHandler(OrderDesk desk, ICustomerRepository customers) : IRequestHandler<AttachCustomerCommand, OrderDto>
{
    public async Task<OrderDto> Handle(AttachCustomerCommand request, CancellationToken cancellationToken)
    {
        var order = await desk.GetAsync(request.OrderId, cancellationToken);
        if (request.CustomerId is { } id)
        {
            var customer = await customers.GetRequiredAsync(id, cancellationToken);
            order.AttachCustomer(customer.Id, customer.Name, customer.Phone, customer.LoyaltyUserId);
        }
        else
        {
            order.AttachCustomer(null, null, null, null);
        }
        return await desk.DoneAsync(order, cancellationToken, floor: false);
    }
}

// Points off the bill: no more than the customer has, as the loyalty system says it now when it can
// be reached, as last known when not. The loyalty system takes them once the check is paid.
public sealed record RedeemPointsCommand(Guid OrderId, int Points, Actor By) : IRequest<OrderDto>;

internal sealed class RedeemPointsHandler(OrderDesk desk, ICustomerRepository customers, ILoyaltyGateway loyalty) : IRequestHandler<RedeemPointsCommand, OrderDto>
{
    public async Task<OrderDto> Handle(RedeemPointsCommand request, CancellationToken cancellationToken)
    {
        var order = await desk.GetAsync(request.OrderId, cancellationToken);
        var customer = order.CustomerId is { } id ? await customers.GetRequiredAsync(id, cancellationToken)
            : throw new DomainException("Attach the customer first. · سجّل العميل أولاً.");
        if (request.Points > 0 && customer.LoyaltyUserId is { } loyaltyId && loyalty.IsEnabled)
        {
            try
            {
                customer.Linked(null, await loyalty.PointsAsync(loyaltyId, cancellationToken), null);
            }
            catch (LinkUnavailableException)
            {
                // Offline: the balance last known.
            }
        }
        if (request.Points > customer.PointsBalance)
            throw new DomainException($"{customer.Name} has {customer.PointsBalance} points. · رصيد النقاط {customer.PointsBalance}.");
        var settings = await desk.SettingsAsync(cancellationToken);
        order.Redeem(request.Points, settings.ValueOf(request.Points));
        return await desk.DoneAsync(order, cancellationToken, floor: false);
    }
}

// Part of a check onto a new one (فصل الشيك): Check A keeps the rest, Check B (C, D) gets what moves.
public sealed record SplitCheckCommand(Guid OrderId, Guid NewOrderId, IReadOnlyList<SplitMove> Moves, Actor By)
    : IRequest<SplitResultDto>, IRetryOnConflict;

internal sealed class SplitCheckHandler(OrderDesk desk) : IRequestHandler<SplitCheckCommand, SplitResultDto>
{
    public async Task<SplitResultDto> Handle(SplitCheckCommand request, CancellationToken cancellationToken)
    {
        var source = await desk.GetAsync(request.OrderId, cancellationToken);
        if (await desk.Orders.GetByIdAsync(request.NewOrderId, cancellationToken) is { } made)
            return new SplitResultDto(await desk.ReadAsync(source, cancellationToken), await desk.ReadAsync(made, cancellationToken));

        var table = source.TableId is { } tableId ? await desk.TableAsync(tableId, cancellationToken) : null;
        var label = await desk.NextLabelAsync(source, cancellationToken);
        var today = desk.Today;
        var created = new Order(
            request.NewOrderId, await desk.Orders.NextNumberAsync(today, cancellationToken), today, source.Type, table, Math.Min(1, source.Guests),
            request.By.Id, request.By.Name, source.ServicePercent, source.TaxPercent);
        source.Label(source.CheckLabel ?? "A");
        created.Label(label);
        source.SplitOnto(created, request.Moves.Select(m => (m.LineId, m.Quantity)).ToList());
        desk.Orders.Add(created);
        var dto = await desk.DoneAsync(source, cancellationToken, alsoChanged: created.Id);
        return new SplitResultDto(dto, await desk.ReadAsync(created, cancellationToken));
    }
}

// Shared evenly by the guests: each pays their part of it.
public sealed record SplitEvenlyCommand(Guid OrderId, int Ways, Actor By) : IRequest<OrderDto>;

internal sealed class SplitEvenlyHandler(OrderDesk desk) : IRequestHandler<SplitEvenlyCommand, OrderDto>
{
    public async Task<OrderDto> Handle(SplitEvenlyCommand request, CancellationToken cancellationToken)
    {
        var order = await desk.GetAsync(request.OrderId, cancellationToken);
        order.SplitEvenly(request.Ways);
        return await desk.DoneAsync(order, cancellationToken, floor: false);
    }
}

// Every check on a table to another, free table (نقل ترابيزة), and the kitchen told where they went.
public sealed record TransferTableCommand(Guid FromTableId, Guid ToTableId, Actor By) : IRequest<IReadOnlyList<OrderDto>>, IRetryOnConflict;

internal sealed class TransferTableHandler(OrderDesk desk) : IRequestHandler<TransferTableCommand, IReadOnlyList<OrderDto>>
{
    public async Task<IReadOnlyList<OrderDto>> Handle(TransferTableCommand request, CancellationToken cancellationToken)
    {
        if (request.FromTableId == request.ToTableId)
            throw new DomainException("Choose another table. · اختر ترابيزة أخرى.");
        var from = await desk.TableAsync(request.FromTableId, cancellationToken);
        var to = await desk.TableAsync(request.ToTableId, cancellationToken);
        var moving = await desk.Orders.GetOpenOnTableAsync(from.Id, cancellationToken);
        if (moving.Count == 0)
            throw new DomainException($"Table {from.Label} has no check open. · لا يوجد شيك.");
        if ((await desk.Orders.GetOpenOnTableAsync(to.Id, cancellationToken)).Count > 0)
            throw new DomainException($"Table {to.Label} is taken: merge the tables instead. · الترابيزة مشغولة: استخدم الدمج.");

        var number = await desk.Kitchen.NextNumberAsync(desk.Today, cancellationToken);
        foreach (var order in moving)
        {
            order.MoveTo(to);
            var inKitchen = order.Lines.Where(l => l.Status == LineStatus.Sent).Select(l => (l, l.Quantity)).ToList();
            if (inKitchen.Count > 0)
                await desk.Kitchen.TicketAsync(order, TicketKind.Transfer, inKitchen, request.By,
                    $"Table {from.Label} → Table {to.Label} · نقل من ترابيزة {from.Label} إلى {to.Label}", cancellationToken, number++);
        }
        var first = await desk.DoneAsync(moving[0], cancellationToken, alsoChanged: [.. moving.Skip(1).Select(o => o.Id)]);
        var all = new List<OrderDto> { first };
        foreach (var order in moving.Skip(1))
            all.Add(await desk.ReadAsync(order, cancellationToken));
        return all;
    }
}

// One check's items onto another's (دمج ترابيزات): two tables' checks become one, the merged one
// kept as merged; the kitchen told.
public sealed record MergeChecksCommand(Guid TargetOrderId, Guid SourceOrderId, Actor By) : IRequest<OrderDto>, IRetryOnConflict;

internal sealed class MergeChecksHandler(OrderDesk desk) : IRequestHandler<MergeChecksCommand, OrderDto>
{
    public async Task<OrderDto> Handle(MergeChecksCommand request, CancellationToken cancellationToken)
    {
        var target = await desk.GetAsync(request.TargetOrderId, cancellationToken);
        var source = await desk.GetAsync(request.SourceOrderId, cancellationToken);
        // Sent again after an answer was lost: merged already.
        if (source.MergedIntoId == target.Id)
            return await desk.ReadAsync(target, cancellationToken);
        var inKitchen = source.Lines.Where(l => l.Status == LineStatus.Sent).Select(l => (l, l.Quantity)).ToList();
        target.MergeFrom(source);
        if (inKitchen.Count > 0)
        {
            var from = source.TableLabel is { } f ? $"Table {f}" : $"#{source.Number}";
            var into = target.TableLabel is { } t ? $"Table {t}" : $"#{target.Number}";
            await desk.Kitchen.TicketAsync(target, TicketKind.Transfer, inKitchen, request.By, $"{from} merged into {into} · دمج {from} مع {into}",
                cancellationToken);
        }
        return await desk.DoneAsync(target, cancellationToken, alsoChanged: source.Id);
    }
}

// Paid (دفع): into the open shift, the new items sent to the kitchen first. Paid in full, the
// customer's points move, the loyalty system is told (the bill earned, the points redeemed), a staff
// meal is sent to payroll, and the receipt prints when asked.
public sealed record PayCommand(Guid OrderId, IReadOnlyList<NewPayment> Payments, bool PrintReceipt, Actor By) : IRequest<OrderDto>, IRetryOnConflict;

internal sealed class PayHandler(OrderDesk desk, IShiftRepository shifts, ICustomerRepository customers, Outbox outbox) : IRequestHandler<PayCommand, OrderDto>
{
    public async Task<OrderDto> Handle(PayCommand request, CancellationToken cancellationToken)
    {
        var order = await desk.GetAsync(request.OrderId, cancellationToken);
        var made = order.Payments.Select(p => p.Id).ToHashSet();
        var payments = request.Payments.Where(p => !made.Contains(p.PaymentId)).ToList();
        if (payments.Count == 0)
            return await desk.ReadAsync(order, cancellationToken);
        var shift = await shifts.GetOpenAsync(cancellationToken)
            ?? throw new DomainException("Open the shift before taking payments. · افتح الوردية أولاً.");
        if (order.HasDrafts)
            await desk.SendAsync(order, request.By, cancellationToken);

        var settings = await desk.SettingsAsync(cancellationToken);
        foreach (var payment in payments)
            order.Pay(payment.PaymentId, payment.Method, payment.Amount, payment.Tendered, payment.Reference, request.By.Name, shift.Id, settings.PointsPerCurrencyUnit);

        var prints = new List<PrintRequest>();
        if (order.Status == OrderStatus.Paid)
        {
            await SettledAsync(order, cancellationToken);
            if (request.PrintReceipt)
                prints.Add(new PrintRequest(PrintDocumentKind.Receipt, order.Id));
        }
        var dto = await desk.DoneAsync(order, cancellationToken, prints);
        return dto;
    }

    private async Task SettledAsync(Order order, CancellationToken cancellationToken)
    {
        var totals = order.Totals;
        if (order.CustomerId is { } customerId && await customers.GetByIdAsync(customerId, cancellationToken) is { } customer)
        {
            customer.Moved(order.PointsEarned - order.PointsRedeemed);
            await outbox.QueueAsync(LinkedSystem.Loyalty, "order.paid", order.Id.ToString(), $"Check #{order.Number}: {order.PointsEarned} points to {customer.Name}",
                new
                {
                    OrderId = order.Id,
                    order.Number,
                    order.BusinessDate,
                    order.Type,
                    Customer = new { customer.Id, customer.Name, customer.Phone, customer.LoyaltyUserId },
                    totals.Net,
                    totals.Total,
                    order.PointsEarned,
                    order.PointsRedeemed,
                    RedeemedValue = totals.Redemption,
                    Items = order.Lines.Where(l => l.Quantity > 0).Select(l => new { l.Code, l.Name, l.Quantity, Amount = l.Total }),
                    order.PaidAtUtc,
                }, cancellationToken);
        }
        foreach (var meal in order.Payments.Where(p => p.Method == PaymentMethod.StaffMeal))
            await outbox.QueueAsync(LinkedSystem.Hr, "staff.meal", meal.Id.ToString(), $"Staff meal for {meal.Reference}: {meal.Amount:N2}",
                new { PaymentId = meal.Id, Employee = meal.Reference, meal.Amount, OrderId = order.Id, order.Number, order.BusinessDate, meal.AtUtc },
                cancellationToken);
    }
}

// Off before the kitchen had anything of it, or anything was paid.
public sealed record CancelOrderCommand(Guid OrderId, string? Reason, Actor By) : IRequest<OrderDto>;

internal sealed class CancelOrderHandler(OrderDesk desk) : IRequestHandler<CancelOrderCommand, OrderDto>
{
    public async Task<OrderDto> Handle(CancelOrderCommand request, CancellationToken cancellationToken)
    {
        var order = await desk.GetAsync(request.OrderId, cancellationToken);
        if (order.Status != OrderStatus.Cancelled)
            order.Cancel(request.Reason, request.By.Name);
        return await desk.DoneAsync(order, cancellationToken);
    }
}

// The guests, the note, and for a delivery its address, driver and who it is for.
public sealed record UpdateOrderCommand(
    Guid OrderId, int? Guests, string? Notes, string? DeliveryAddress, string? DriverName, string? CustomerName, string? CustomerPhone, Actor By)
    : IRequest<OrderDto>;

internal sealed class UpdateOrderHandler(OrderDesk desk) : IRequestHandler<UpdateOrderCommand, OrderDto>
{
    public async Task<OrderDto> Handle(UpdateOrderCommand request, CancellationToken cancellationToken)
    {
        var order = await desk.GetAsync(request.OrderId, cancellationToken);
        if (request.Guests is { } guests)
            order.SetGuests(guests);
        order.SetNotes(request.Notes);
        if (order.Type == OrderType.Delivery)
            order.SetDelivery(request.DeliveryAddress, request.DriverName);
        if (order.CustomerId is null && (request.CustomerName is not null || request.CustomerPhone is not null))
            order.AttachCustomer(null, request.CustomerName, request.CustomerPhone, null);
        return await desk.DoneAsync(order, cancellationToken);
    }
}

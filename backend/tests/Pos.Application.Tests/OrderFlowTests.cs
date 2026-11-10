using System.Text.Json;
using Pos.Application.Common;
using Pos.Application.Customers;
using Pos.Application.Floor;
using Pos.Application.Integrations;
using Pos.Application.Kitchen;
using Pos.Application.Orders;
using Pos.Application.Shifts;
using Pos.Domain.Catalog;
using Pos.Domain.Common;
using Pos.Domain.Floor;
using Pos.Domain.Integrations;
using Pos.Domain.Kitchen;
using Pos.Domain.Orders;
using Pos.Domain.Printing;
using Pos.Domain.Shifts;

namespace Pos.Application.Tests;

// The till and the captains' phones taking orders, the kitchen working them, the cashier settling
// them and closing the shift, and what goes to the linked systems.
public class OrderFlowTests
{
    private readonly TestPos _pos = new();
    private readonly MenuItem _burger;
    private readonly MenuItem _pizza;
    private readonly KitchenStation _grill;
    private readonly KitchenStation _oven;
    private readonly Printer _grillPrinter;
    private readonly DiningTable _t1;
    private readonly DiningTable _t2;
    private readonly DiningTable _t3;

    public OrderFlowTests()
    {
        _grillPrinter = new Printer(Guid.NewGuid(), "Grill printer", PrinterConnection.Network, PrinterRole.Kitchen, "10.0.0.20", 9100, 48);
        _pos.Store.Printers.Add(_grillPrinter);
        _grill = new KitchenStation(Guid.NewGuid(), "Grill", "مشويات", 1, _grillPrinter.Id);
        _oven = new KitchenStation(Guid.NewGuid(), "Oven", "فرن", 2);
        _pos.Store.Stations.Add(_grill);
        _pos.Store.Stations.Add(_oven);
        var category = new MenuCategory(Guid.NewGuid(), "Food", null, 1);
        _pos.Store.Categories.Add(category);
        _burger = new MenuItem(Guid.NewGuid(), 7001, "Burger", "برجر", category.Id, 100, _grill.Id);
        _burger.SetOptions([], [new MenuOption(Guid.NewGuid(), "Cheese", null, 20)]);
        _pizza = new MenuItem(Guid.NewGuid(), 6101, "Pizza", "بيتزا", category.Id, 150, _oven.Id);
        _pizza.SetOptions([new MenuOption(Guid.NewGuid(), "Large", "كبير", 200)], []);
        _pos.Store.Items.Add(_burger);
        _pos.Store.Items.Add(_pizza);
        var zone = new DiningZone(Guid.NewGuid(), "Hall", null, 1);
        _pos.Store.Zones.Add(zone);
        _t1 = new DiningTable(Guid.NewGuid(), zone.Id, "1", 4, 0, 0);
        _t2 = new DiningTable(Guid.NewGuid(), zone.Id, "2", 4, 3, 0);
        _t3 = new DiningTable(Guid.NewGuid(), zone.Id, "3", 4, 6, 0);
        _pos.Store.Tables.Add(_t1);
        _pos.Store.Tables.Add(_t2);
        _pos.Store.Tables.Add(_t3);
    }

    private async Task<OrderDto> TableCheck(DiningTable table, Actor? by = null) =>
        await _pos.Send(new OpenOrderCommand(Guid.NewGuid(), OrderType.DineIn, table.Id, 2, by ?? TestPos.Captain));

    private Task<OrderDto> Add(Guid orderId, MenuItem item, int quantity, bool send = false, Guid? lineId = null, Actor? by = null) =>
        _pos.Send(new AddItemsCommand(orderId, [new NewLine(lineId ?? Guid.NewGuid(), item.Id, item.Sizes.FirstOrDefault()?.Id, null, quantity, null)],
            send, by ?? TestPos.Captain));

    private Task<ShiftDto> OpenShift(decimal floatAmount = 500) => _pos.Send(new OpenShiftCommand(Guid.NewGuid(), floatAmount, TestPos.Cashier));

    [Fact]
    public async Task A_captain_sends_a_table_to_the_kitchen_each_station_printing_its_part_and_more_items_go_on_an_add_on()
    {
        var order = await TableCheck(_t1);
        Assert.Equal((1, "1"), (order.Number, order.TableLabel));
        var again = await Assert.ThrowsAsync<DomainException>(() => TableCheck(_t1));
        Assert.Contains("has a check open", again.Message);

        await Add(order.Id, _burger, 2);
        order = await Add(order.Id, _pizza, 1, send: true);
        Assert.All(order.Lines, l => Assert.Equal((LineStatus.Sent, 1), (l.Status, l.KitchenTicketNumber!.Value)));
        Assert.Equal([TicketKind.New], order.Tickets.Select(t => t.Kind));
        // Only the grill has a printer: the oven's part is on the kitchen screen alone.
        var print = Assert.Single(_pos.Printed.Requests);
        Assert.Equal((PrintDocumentKind.KitchenTicket, _grillPrinter.Id, _grill.Id), (print.Kind, print.PrinterId!.Value, print.StationId!.Value));
        Assert.Contains("kitchen", _pos.Told.Said);
        Assert.Contains("floor", _pos.Told.Said);

        order = await Add(order.Id, _burger, 1, send: true);
        Assert.Equal([TicketKind.New, TicketKind.AddOn], order.Tickets.Select(t => t.Kind));
        var addOn = _pos.Store.Tickets.All.Single(t => t.Kind == TicketKind.AddOn);
        Assert.Equal((2, 1), (addOn.Number, addOn.Lines.Single().Quantity));

        var floor = await _pos.Send(new GetFloorQuery());
        Assert.Equal(TableState.Occupied, floor.Tables.Single(t => t.Id == _t1.Id).State);
        Assert.Equal(TableState.Available, floor.Tables.Single(t => t.Id == _t2.Id).State);
    }

    [Fact]
    public async Task A_void_after_the_kitchen_needs_a_managers_pin_and_tells_the_kitchen_on_a_void_ticket()
    {
        var order = await TableCheck(_t1, TestPos.Cashier);
        var sentLine = Guid.NewGuid();
        await Add(order.Id, _burger, 2, send: true, lineId: sentLine, by: TestPos.Cashier);
        var draftLine = Guid.NewGuid();
        await Add(order.Id, _pizza, 1, lineId: draftLine, by: TestPos.Cashier);

        // A draft goes freely, as a void before the kitchen.
        order = await _pos.Send(new VoidItemsCommand(order.Id, [new VoidItem(Guid.NewGuid(), draftLine, 1)], null, StockOutcome.None, null, TestPos.Cashier));
        Assert.Equal(VoidKind.BeforeKitchen, order.Voids.Single().Kind);
        Assert.Single(order.Tickets);

        var item = new VoidItem(Guid.NewGuid(), sentLine, 1);
        await Assert.ThrowsAsync<ForbiddenException>(() =>
            _pos.Send(new VoidItemsCommand(order.Id, [item], "Late · تأخير", StockOutcome.Waste, null, TestPos.Cashier)));
        await Assert.ThrowsAsync<ForbiddenException>(() =>
            _pos.Send(new VoidItemsCommand(order.Id, [item], "Late · تأخير", StockOutcome.Waste, "2222", TestPos.Cashier)));
        order = await _pos.Send(new VoidItemsCommand(order.Id, [item], "Late · تأخير", StockOutcome.Waste, "1234", TestPos.Cashier));

        var after = order.Voids.Single(v => v.Kind == VoidKind.AfterKitchen);
        Assert.Equal(("Boss", StockOutcome.Waste, 100m, 2), (after.AuthorizedBy, after.Outcome, after.Amount, after.KitchenTicketNumber!.Value));
        var voidTicket = _pos.Store.Tickets.All.Single(t => t.Kind == TicketKind.Void);
        Assert.Contains("Late", voidTicket.Note);
        Assert.Contains(_pos.Printed.Requests, r => r.SubjectId == voidTicket.Id && r.PrinterId == _grillPrinter.Id);
        // Sent again after the answer was lost: one void, one ticket.
        await _pos.Send(new VoidItemsCommand(order.Id, [item], "Late · تأخير", StockOutcome.Waste, "1234", TestPos.Cashier));
        Assert.Single(_pos.Store.Tickets.All, t => t.Kind == TicketKind.Void);

        // A manager voids without a PIN.
        order = await _pos.Send(new VoidItemsCommand(order.Id, [new VoidItem(Guid.NewGuid(), sentLine, 1)], "Quality", StockOutcome.ReturnToStock, null,
            TestPos.Manager));
        Assert.Equal(0, order.Lines.Single(l => l.Id == sentLine).Quantity);
    }

    [Fact]
    public async Task A_table_is_split_moved_and_merged_and_the_kitchen_is_told_where_it_went()
    {
        var order = await TableCheck(_t1, TestPos.Cashier);
        var burgers = Guid.NewGuid();
        await Add(order.Id, _burger, 3, send: true, lineId: burgers, by: TestPos.Cashier);

        var split = await _pos.Send(new SplitCheckCommand(order.Id, Guid.NewGuid(), [new SplitMove(burgers, 1)], TestPos.Cashier));
        Assert.Equal(("A", "B", 2, 1), (split.Source.CheckLabel, split.Created.CheckLabel, split.Source.Lines.Single().Quantity, split.Created.Lines.Single().Quantity));
        Assert.Equal((OrderType.DineIn, "1", 2), (split.Created.Type, split.Created.TableLabel, split.Created.Number));

        var taken = await TableCheck(_t3, TestPos.Cashier);
        var refused = await Assert.ThrowsAsync<DomainException>(() => _pos.Send(new TransferTableCommand(_t1.Id, _t3.Id, TestPos.Cashier)));
        Assert.Contains("merge", refused.Message);
        var moved = await _pos.Send(new TransferTableCommand(_t1.Id, _t2.Id, TestPos.Cashier));
        Assert.Equal(["2", "2"], moved.Select(o => o.TableLabel));
        Assert.Equal(2, _pos.Store.Tickets.All.Count(t => t.Kind == TicketKind.Transfer));

        await Add(taken.Id, _burger, 1, send: true, by: TestPos.Cashier);
        var merged = await _pos.Send(new MergeChecksCommand(split.Created.Id, taken.Id, TestPos.Cashier));
        Assert.Equal((2, 3), (merged.Lines.Sum(l => l.Quantity), merged.Guests));
        Assert.Equal(OrderStatus.Merged, (await _pos.Send(new GetOrderQuery(taken.Id))).Status);
        var floor = await _pos.Send(new GetFloorQuery());
        Assert.Equal(TableState.Available, floor.Tables.Single(t => t.Id == _t3.Id).State);
    }

    [Fact]
    public async Task Paying_needs_an_open_shift_sends_any_new_items_first_and_earns_the_customer_points_queued_for_loyalty()
    {
        _pos.Store.Links.SwitchOn(LinkedSystem.Loyalty);
        var order = await _pos.Send(new OpenOrderCommand(Guid.NewGuid(), OrderType.Takeaway, null, 0, TestPos.Cashier));
        await Add(order.Id, _burger, 2, by: TestPos.Cashier);
        var customer = await _pos.Send(new RegisterCustomerCommand(Guid.NewGuid(), "Sara", "0100 123 4567", TestPos.Cashier));
        await _pos.Send(new AttachCustomerCommand(order.Id, customer.Id, TestPos.Cashier));
        var pay = new NewPayment(Guid.NewGuid(), PaymentMethod.Cash, 228, 300, null);

        var noShift = await Assert.ThrowsAsync<DomainException>(() => _pos.Send(new PayCommand(order.Id, [pay], true, TestPos.Cashier)));
        Assert.Contains("Open the shift", noShift.Message);
        await OpenShift();
        order = await _pos.Send(new PayCommand(order.Id, [pay], true, TestPos.Cashier));

        Assert.Equal((OrderStatus.Paid, LineStatus.Sent, 22), (order.Status, order.Lines.Single().Status, order.PointsEarned));
        Assert.Equal(72m, order.Payments.Single().Change);
        Assert.Contains(_pos.Printed.Requests, r => r.Kind == PrintDocumentKind.Receipt && r.SubjectId == order.Id);
        Assert.Equal(22, _pos.Store.Customers.All.Single().PointsBalance);
        Assert.Equal(["customer.registered", "order.paid"], _pos.Store.Queue.Items.Select(i => i.Kind));
        var paid = JsonDocument.Parse(_pos.Store.Queue.Items[1].Payload).RootElement;
        Assert.Equal(("order.paid", "BR1", 22), (paid.GetProperty("kind").GetString(), paid.GetProperty("branchCode").GetString(),
            paid.GetProperty("data").GetProperty("pointsEarned").GetInt32()));
        // Sent again after the answer was lost: one payment.
        await _pos.Send(new PayCommand(order.Id, [pay], true, TestPos.Cashier));
        Assert.Single((await _pos.Send(new GetOrderQuery(order.Id))).Payments);
    }

    [Fact]
    public async Task Points_are_redeemed_up_to_the_balance_and_a_discount_past_the_cashiers_limit_needs_a_manager()
    {
        _pos.Loyalty.IsEnabled = true;
        _pos.Loyalty.ByPhone["01001234567"] = new LoyaltyCustomer("loyal-1", "Sara Online", "01001234567", 300, "Gold");
        var found = await _pos.Send(new SearchCustomersQuery("01001234567"));
        var sara = Assert.Single(found);
        Assert.Equal(("Sara Online", 300, "Gold", true), (sara.Name, sara.Points, sara.Tier, sara.Linked));
        Assert.Equal(sara.Id, (await _pos.Send(new FindByCardQuery("loyal-1"))).Id);

        var order = await _pos.Send(new OpenOrderCommand(Guid.NewGuid(), OrderType.Takeaway, null, 0, TestPos.Cashier));
        await Add(order.Id, _burger, 2, by: TestPos.Cashier);
        await _pos.Send(new AttachCustomerCommand(order.Id, sara.Id, TestPos.Cashier));
        await Assert.ThrowsAsync<DomainException>(() => _pos.Send(new RedeemPointsCommand(order.Id, 500, TestPos.Cashier)));
        // The loyalty system offline: the balance last known.
        _pos.Loyalty.Offline = true;
        order = await _pos.Send(new RedeemPointsCommand(order.Id, 200, TestPos.Cashier));
        Assert.Equal((200, 20m), (order.PointsRedeemed, order.Totals.Redemption));

        await Assert.ThrowsAsync<ForbiddenException>(() => _pos.Send(new DiscountCommand(order.Id, null, 25, "Friend", null, TestPos.Cashier)));
        order = await _pos.Send(new DiscountCommand(order.Id, null, 5, "Regular", null, TestPos.Cashier));
        Assert.Equal(10m, order.Totals.BillDiscount);
        order = await _pos.Send(new DiscountCommand(order.Id, null, 25, "Friend", "1234", TestPos.Cashier));
        Assert.Equal(50m, order.Totals.BillDiscount);
    }

    [Fact]
    public async Task The_kitchen_bumps_a_ticket_and_its_items_are_prepared_on_the_check()
    {
        var order = await TableCheck(_t1);
        await Add(order.Id, _burger, 1);
        order = await Add(order.Id, _pizza, 1, send: true);
        var board = await _pos.Send(new GetKitchenBoardQuery(_grill.Id));
        var ticket = Assert.Single(board.Active);
        Assert.Equal(["Burger"], ticket.Lines.Where(l => l.StationId == _grill.Id).Select(l => l.Name));

        await _pos.Send(new BumpTicketCommand(ticket.Id, _grill.Id, false, TestPos.Cashier));
        order = await _pos.Send(new GetOrderQuery(order.Id));
        Assert.Equal([LineStatus.Prepared, LineStatus.Sent], order.Lines.Select(l => l.Status));
        Assert.Empty((await _pos.Send(new GetKitchenBoardQuery(_grill.Id))).Active);
        Assert.Single((await _pos.Send(new GetKitchenBoardQuery(_oven.Id))).Active);
        await _pos.Send(new RecallTicketCommand(ticket.Id, _grill.Id, TestPos.Cashier));
        Assert.Single((await _pos.Send(new GetKitchenBoardQuery(_grill.Id))).Active);
    }

    [Fact]
    public async Task The_z_report_counts_the_shifts_sales_tax_voids_and_cash_and_costing_is_sent_the_day()
    {
        _pos.Store.Links.SwitchOn(LinkedSystem.Costing);
        _pos.Store.Links.SwitchOn(LinkedSystem.Hr);
        var shift = await OpenShift(500);
        // A table: 2 burgers, one voided after the kitchen as waste; paid in cash.
        var table = await TableCheck(_t1, TestPos.Cashier);
        var burgers = Guid.NewGuid();
        await Add(table.Id, _burger, 2, send: true, lineId: burgers, by: TestPos.Cashier);
        await _pos.Send(new VoidItemsCommand(table.Id, [new VoidItem(Guid.NewGuid(), burgers, 1)], "Late · تأخير", StockOutcome.Waste, "1234", TestPos.Cashier));
        table = await _pos.Send(new GetOrderQuery(table.Id));
        // 100 + 12 service + 15.68 tax = 127.68.
        await _pos.Send(new PayCommand(table.Id, [new NewPayment(Guid.NewGuid(), PaymentMethod.Cash, table.Totals.Total, null, null)], false, TestPos.Cashier));
        // A takeaway pizza on a card, and one staff meal.
        var takeaway = await _pos.Send(new OpenOrderCommand(Guid.NewGuid(), OrderType.Takeaway, null, 0, TestPos.Cashier));
        await Add(takeaway.Id, _pizza, 1, by: TestPos.Cashier);
        await _pos.Send(new PayCommand(takeaway.Id, [new NewPayment(Guid.NewGuid(), PaymentMethod.Card, 228, null, "4411")], false, TestPos.Cashier));
        var meal = await _pos.Send(new OpenOrderCommand(Guid.NewGuid(), OrderType.Takeaway, null, 0, TestPos.Cashier));
        await Add(meal.Id, _burger, 1, by: TestPos.Cashier);
        await _pos.Send(new PayCommand(meal.Id, [new NewPayment(Guid.NewGuid(), PaymentMethod.StaffMeal, 114, null, "Hassan")], false, TestPos.Cashier));
        await _pos.Send(new PayOutCommand(Guid.NewGuid(), PaidOutKind.Expense, 40, "Ice", null, TestPos.Cashier));
        await _pos.Send(new PayOutCommand(Guid.NewGuid(), PaidOutKind.StaffAdvance, 100, "Advance", "Hassan", TestPos.Cashier));

        // A check still open stops the close.
        var open = await TableCheck(_t2, TestPos.Cashier);
        await Add(open.Id, _burger, 1, by: TestPos.Cashier);
        await Assert.ThrowsAsync<DomainException>(() => _pos.Send(new CloseShiftCommand(shift.Id, 600, false, TestPos.Cashier)));
        await _pos.Send(new CancelOrderCommand(open.Id, "Left", TestPos.Cashier));

        var z = await _pos.Send(new CloseShiftCommand(shift.Id, 600, true, TestPos.Cashier));
        Assert.Equal((3, 127.68m, 228m, 114m), (z.Checks, z.CashSales, z.CardSales, z.StaffMeals));
        Assert.Equal((412m, 15.68m + 28m + 14m), (z.NetSales, z.Tax));
        // The check cancelled with its draft: a void before the kitchen.
        Assert.Equal((1, 1, 100m), (z.VoidBeforeCount, z.VoidAfterCount, z.VoidAfterAmount));
        // 500 float + 127.68 cash − 140 paid out = 487.68; 600 counted.
        Assert.Equal((487.68m, 112.32m), (z.ExpectedCash, z.Variance!.Value));
        Assert.Equal(["Late · تأخير"], z.VoidAfterReasons.Select(r => r.Reason));
        Assert.Contains(_pos.Printed.Requests, r => r.Kind == PrintDocumentKind.ZReport);

        var day = _pos.Store.Queue.Items.Single(i => i.Kind == "day.closed");
        var data = JsonDocument.Parse(day.Payload).RootElement.GetProperty("data");
        Assert.Equal(2, data.GetProperty("soldItems").GetArrayLength());
        Assert.Equal(("Burger", 1), (data.GetProperty("waste")[0].GetProperty("name").GetString(), data.GetProperty("waste")[0].GetProperty("quantity").GetInt32()));
        Assert.Equal(57.68m, data.GetProperty("takings").GetProperty("tax").GetDecimal());
        Assert.Equal(["staff.meal", "staff.advance", "day.closed"], _pos.Store.Queue.Items.Select(i => i.Kind));
        // Closed: the same report, kept.
        Assert.Equal(z.ClosedAtUtc, (await _pos.Send(new GetZReportQuery(shift.Id))).ClosedAtUtc);
    }

    [Fact]
    public async Task Nothing_is_queued_for_a_system_switched_off_and_sync_now_sends_the_failed_again()
    {
        var shift = await OpenShift();
        await _pos.Send(new PayOutCommand(Guid.NewGuid(), PaidOutKind.StaffAdvance, 100, "Advance", "Hassan", TestPos.Cashier));
        Assert.Empty(_pos.Store.Queue.Items);

        _pos.Store.Links.SwitchOn(LinkedSystem.Hr);
        await _pos.Send(new PayOutCommand(Guid.NewGuid(), PaidOutKind.StaffAdvance, 50, "Advance", "Hassan", TestPos.Cashier));
        var item = Assert.Single(_pos.Store.Queue.Items);
        item.NotDelivered("refused", failed: true);
        var state = await _pos.Send(new SyncNowCommand(RetryFailed: true));
        Assert.Equal((1, 0), (state.Pending, state.Failed));
        Assert.Equal(1, (await _pos.Send(new ClockCommand("2222", TestPos.Manager))) is { ClockedIn: true } ? 1 : 0);
        Assert.False((await _pos.Send(new ClockCommand("2222", TestPos.Manager))).ClockedIn);
        Assert.Equal(3, _pos.Store.Queue.Items.Count);
        Assert.Equal(shift.Id, (await _pos.Send(new GetCurrentShiftQuery()))!.Id);
    }

    // What a terminal did while the server could not be reached arrives later, as it was done: the
    // bill it printed in its own browser and the payment it took, printed there too. Kept, never
    // printed a second time; and every open check is there whole for a terminal to keep.
    [Fact]
    public async Task A_bill_and_a_payment_taken_offline_are_kept_when_they_arrive_and_not_printed_again()
    {
        await OpenShift();
        var order = await TableCheck(_t1);
        await Add(order.Id, _burger, 2, send: true);
        var other = await TableCheck(_t2);
        await Add(other.Id, _pizza, 1);

        var open = await _pos.Send(new GetOpenOrderDetailsQuery());
        Assert.Equal([order.Id, other.Id], open.Select(o => o.Id));
        Assert.Equal([2, 1], open.Select(o => o.Lines.Single().Quantity));
        Assert.Equal(OrderStatus.Open, open[0].Status);
        _pos.Printed.Requests.Clear();

        order = await _pos.Send(new PrintBillCommand(order.Id, TestPos.Cashier, Print: false));
        Assert.Equal(OrderStatus.BillPrinted, order.Status);
        var pay = new NewPayment(Guid.NewGuid(), PaymentMethod.Cash, order.Totals.Total, 500, null);
        order = await _pos.Send(new PayCommand(order.Id, [pay], false, TestPos.Cashier));
        Assert.Equal(OrderStatus.Paid, order.Status);
        Assert.Empty(_pos.Printed.Requests);

        // Sent again (the answer was lost): the same payment, taken once.
        order = await _pos.Send(new PayCommand(order.Id, [pay], false, TestPos.Cashier));
        Assert.Single(order.Payments);
        Assert.Equal([other.Id], (await _pos.Send(new GetOpenOrderDetailsQuery())).Select(o => o.Id));
    }

    // The costing system linked, the menu is pulled from it: its categories and items by code, each
    // size with its code there; this POS's stations and modifiers kept; an item it no longer sells
    // taken off. A size sold then goes in the Z report by that code, so Costing takes its recipe.
    [Fact]
    public async Task The_menu_is_pulled_from_costing_and_a_size_sold_goes_to_costing_by_its_code()
    {
        var extra = _burger.Modifiers.Single();
        var largeHere = _pizza.Sizes.Single().Id;
        _pos.Store.Links.SwitchOn(LinkedSystem.Costing);
        _pos.Gateway.CostingMenu = new CostingMenu(
            [new("Food", "أكل", 1), new("Drinks", "مشروبات", 2)],
            [
                new(6101, "Margherita", "مارجريتا", "Food", 0, true, false, true,
                    [new("6101-17", "Large", "كبير", 210), new("6101-18", "Medium", "وسط", 160)]),
                new(9001, "Tea", "شاي", "Drinks", 25, true, false, false, []),
                new(5000, "Mixed grill kilo", null, "Food", 0, true, true, true, []),
            ]);

        var pulled = await _pos.Send(new PullCostingMenuCommand(TestPos.Manager));

        Assert.Equal(new MenuPullResult(2, 1, 3, 2, 1, 1, 2, 1), pulled);
        var pizza = _pos.Store.Items.All.Single(i => i.Code == 6101);
        Assert.Equal(("Margherita", _oven.Id), (pizza.Name, pizza.StationId));
        // The size named Large here keeps its id, now with its code there.
        Assert.Equal([("Large", "6101-17", 210m), ("Medium", "6101-18", 160m)], pizza.Sizes.Select(z => (z.Name, z.Code, z.Price)));
        Assert.Equal(largeHere, pizza.Sizes[0].Id);
        Assert.False(_pos.Store.Items.All.Single(i => i.Code == 7001).IsActive);
        Assert.Single(_pos.Store.Items.All.Single(i => i.Code == 7001).Modifiers, m => m.Id == extra.Id);
        Assert.False(_pos.Store.Items.All.Single(i => i.Code == 5000).IsActive);
        Assert.Equal("Drinks", _pos.Store.Categories.All.Single(c => c.Id == _pos.Store.Items.All.Single(i => i.Code == 9001).CategoryId).Name);

        // A large Margherita and a tea sold, a large one made and voided: by their codes there.
        var shift = await OpenShift();
        var order = await _pos.Send(new OpenOrderCommand(Guid.NewGuid(), OrderType.Takeaway, null, 0, TestPos.Cashier));
        var large = pizza.Sizes[0].Id;
        var lines = new[] { new NewLine(Guid.NewGuid(), pizza.Id, large, null, 2, null), new NewLine(Guid.NewGuid(), _pos.Store.Items.All.Single(i => i.Code == 9001).Id, null, null, 1, null) };
        order = await _pos.Send(new AddItemsCommand(order.Id, lines, true, TestPos.Cashier));
        order = await _pos.Send(new VoidItemsCommand(order.Id, [new VoidItem(Guid.NewGuid(), order.Lines[0].Id, 1)], "Burnt", StockOutcome.Waste, "1234", TestPos.Cashier));
        order = await _pos.Send(new PayCommand(order.Id, [new NewPayment(Guid.NewGuid(), PaymentMethod.Cash, order.Totals.Total, null, null)], false, TestPos.Cashier));
        await _pos.Send(new CloseShiftCommand(shift.Id, 1000, false, TestPos.Cashier));

        var data = JsonDocument.Parse(_pos.Store.Queue.Items.Single(i => i.Kind == "day.closed").Payload).RootElement.GetProperty("data");
        Assert.Equal([("6101-17", "Large", 1), ("9001", null, 1)],
            data.GetProperty("soldItems").EnumerateArray().Select(i => (i.GetProperty("itemCode").GetString(), i.GetProperty("size").GetString(), i.GetProperty("quantity").GetInt32())));
        var waste = data.GetProperty("waste").EnumerateArray().Single();
        Assert.Equal(("6101-17", "Large", "Burnt"), (waste.GetProperty("itemCode").GetString(), waste.GetProperty("size").GetString(), waste.GetProperty("reason").GetString()));
    }
}

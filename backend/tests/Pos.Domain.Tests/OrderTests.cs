using Pos.Domain.Catalog;
using Pos.Domain.Common;
using Pos.Domain.Floor;
using Pos.Domain.Integrations;
using Pos.Domain.Kitchen;
using Pos.Domain.Orders;
using Pos.Domain.Settings;
using Pos.Domain.Shifts;

namespace Pos.Domain.Tests;

public class OrderTests
{
    private static readonly DateOnly Today = new(2026, 11, 9);
    private static readonly Guid Shift = Guid.NewGuid();

    private static readonly MenuItem Pizza = MakePizza();
    private static readonly MenuItem Burger = new(Guid.NewGuid(), 7001, "Burger", "برجر", Guid.NewGuid(), 100, Guid.NewGuid());

    private static MenuItem MakePizza()
    {
        var item = new MenuItem(Guid.NewGuid(), 6101, "Margherita", "مارجريتا", Guid.NewGuid(), 140, Guid.NewGuid());
        item.SetOptions([new MenuOption(Guid.NewGuid(), "Medium", "وسط", 140), new MenuOption(Guid.NewGuid(), "Large", "كبير", 190)],
            [new MenuOption(Guid.NewGuid(), "Extra cheese", "جبنة زيادة", 25)]);
        return item;
    }

    private static DiningTable Table(string label = "7") => new(Guid.NewGuid(), Guid.NewGuid(), label, 4, 0, 0);

    private static Order Check(OrderType type = OrderType.DineIn, decimal service = 12, decimal tax = 14) =>
        new(Guid.NewGuid(), 1, Today, type, type == OrderType.DineIn ? Table() : null, 2, "u1", "Ali", service, tax);

    private static OrderLine AddBurger(Order order, int quantity = 1, string? notes = null) =>
        order.AddLine(Guid.NewGuid(), Burger, null, [], quantity, notes, "Grill", "Ali");

    [Fact]
    public void A_line_is_priced_by_its_size_and_modifiers_and_the_check_adds_service_then_tax()
    {
        var order = Check();
        var large = Pizza.Sizes[1];
        var line = order.AddLine(Guid.NewGuid(), Pizza, large, [Pizza.Modifiers[0]], 2, "Well done", "Pizza", "Ali");
        AddBurger(order);

        Assert.Equal((215m, LineStatus.Draft, "Extra cheese", "Large"), (line.UnitPrice, line.Status, line.Modifiers, line.SizeName));
        var t = order.Totals;
        // 2 × 215 + 100 = 530; service 12% = 63.60; tax 14% of 593.60 = 83.10.
        Assert.Equal((530m, 63.60m, 83.10m, 676.70m), (t.Gross, t.Service, t.Tax, t.Total));
        Assert.Throws<DomainException>(() => order.AddLine(Guid.NewGuid(), Pizza, null, [], 1, null, null, "Ali"));
    }

    [Fact]
    public void Only_a_tables_check_has_a_service_charge()
    {
        var takeaway = Check(OrderType.Takeaway);
        AddBurger(takeaway);
        Assert.Equal((0m, 14m, 114m), (takeaway.Totals.Service, takeaway.Totals.Tax, takeaway.Totals.Total));
        Assert.Throws<DomainException>(() => new Order(Guid.NewGuid(), 1, Today, OrderType.DineIn, null, 2, "u", "Ali", 12, 14));
    }

    [Fact]
    public void Sending_locks_the_drafts_on_a_ticket_and_only_what_is_new_goes_after()
    {
        var order = Check();
        var first = AddBurger(order);
        Assert.False(order.HasBeenToKitchen);
        var sent = order.SendToKitchen(1, DateTime.UtcNow);
        Assert.Equal((LineStatus.Sent, 1), (first.Status, first.KitchenTicketNumber!.Value));
        Assert.Single(sent);
        Assert.Throws<DomainException>(() => order.ChangeDraft(first.Id, 3, null));
        Assert.Throws<DomainException>(() => order.SendToKitchen(2, DateTime.UtcNow));

        var second = AddBurger(order, 2);
        Assert.True(order.HasBeenToKitchen);
        var addOn = order.SendToKitchen(2, DateTime.UtcNow);
        Assert.Equal([second.Id], addOn.Select(l => l.Id));
        Assert.Equal(2, second.KitchenTicketNumber);
    }

    [Fact]
    public void A_draft_is_voided_before_the_kitchen_freely_and_a_sent_item_only_with_a_manager_a_reason_and_its_outcome()
    {
        var order = Check();
        var draft = AddBurger(order, 2);
        var before = order.Void(Guid.NewGuid(), draft.Id, 1, null, StockOutcome.Waste, null, "Ali");
        Assert.Equal((VoidKind.BeforeKitchen, StockOutcome.None, 1, 100m), (before.Kind, before.Outcome, draft.Quantity, before.Amount));

        order.SendToKitchen(1, DateTime.UtcNow);
        Assert.Throws<ForbiddenException>(() => order.Void(Guid.NewGuid(), draft.Id, 1, "Late", StockOutcome.Waste, null, "Ali"));
        Assert.Throws<DomainException>(() => order.Void(Guid.NewGuid(), draft.Id, 1, null, StockOutcome.Waste, "Boss", "Ali"));
        Assert.Throws<DomainException>(() => order.Void(Guid.NewGuid(), draft.Id, 1, "Late", StockOutcome.None, "Boss", "Ali"));

        var id = Guid.NewGuid();
        var after = order.Void(id, draft.Id, 1, "Late · تأخير", StockOutcome.ReturnToStock, "Boss", "Ali", 2);
        Assert.Equal((VoidKind.AfterKitchen, StockOutcome.ReturnToStock, "Boss", 2), (after.Kind, after.Outcome, after.AuthorizedBy, after.KitchenTicketNumber!.Value));
        Assert.Equal((0, LineStatus.Voided), (draft.Quantity, draft.Status));
        // The same void sent again: once.
        Assert.Same(after, order.Void(id, draft.Id, 1, "Late", StockOutcome.Waste, "Boss", "Ali"));
        Assert.Equal(2, order.Voids.Count);
    }

    [Fact]
    public void A_printed_bill_waits_to_be_paid_until_the_check_changes()
    {
        var order = Check();
        AddBurger(order);
        order.SendToKitchen(1, DateTime.UtcNow);
        order.PrintBill(DateTime.UtcNow);
        Assert.Equal((OrderStatus.BillPrinted, 1), (order.Status, order.BillPrints));
        AddBurger(order);
        Assert.Equal(OrderStatus.Open, order.Status);
        Assert.Throws<DomainException>(() => Check().PrintBill(DateTime.UtcNow));
    }

    [Fact]
    public void Paid_in_parts_it_is_settled_into_the_shift_earning_its_customer_points()
    {
        var order = Check(OrderType.Takeaway);
        AddBurger(order, 2);
        Assert.Throws<DomainException>(() => order.Pay(Guid.NewGuid(), PaymentMethod.Cash, 10, 10, null, "Mona", Shift, 0.1m));
        order.SendToKitchen(1, DateTime.UtcNow);
        order.AttachCustomer(Guid.NewGuid(), "Sara", "01001234567", "loyalty-1");

        // 228 due: 100 in cash (200 handed over), the rest on a card.
        var cash = order.Pay(Guid.NewGuid(), PaymentMethod.Cash, 100, 200, null, "Mona", Shift, 0.1m);
        Assert.Equal((100m, OrderStatus.Open, 128m), (cash.Change, order.Status, order.Totals.Due));
        Assert.Throws<DomainException>(() => order.Pay(Guid.NewGuid(), PaymentMethod.Card, 200, null, null, "Mona", Shift, 0.1m));
        order.Pay(Guid.NewGuid(), PaymentMethod.Card, 128, null, "4411", "Mona", Shift, 0.1m);
        Assert.Equal((OrderStatus.Paid, 22, Shift), (order.Status, order.PointsEarned, order.ShiftId!.Value));
        Assert.Throws<DomainException>(() => AddBurger(order));
        Assert.Throws<DomainException>(() => order.Pay(Guid.NewGuid(), PaymentMethod.StaffMeal, 1, null, null, "Mona", Shift, 0));
    }

    [Fact]
    public void Discounts_and_redeemed_points_come_off_before_the_service_and_the_tax()
    {
        var order = Check(OrderType.Takeaway);
        AddBurger(order, 2);
        Assert.Throws<DomainException>(() => order.Redeem(100, 10));
        order.AttachCustomer(Guid.NewGuid(), "Sara", "01001234567", null);
        order.Discount(20, "Regular", "Mona");
        order.Redeem(100, 10);
        Assert.Equal((200m, 20m, 10m, 170m, 23.80m, 193.80m), (order.Totals.Gross, order.Totals.BillDiscount, order.Totals.Redemption, order.Totals.Net,
            order.Totals.Tax, order.Totals.Total));
        Assert.Throws<DomainException>(() => order.Discount(500, "Too much", "Mona"));
    }

    [Fact]
    public void A_check_splits_part_of_its_lines_onto_another_and_merges_another_into_it()
    {
        var a = Check();
        var burgers = AddBurger(a, 3);
        var pizza = a.AddLine(Guid.NewGuid(), Pizza, Pizza.Sizes[0], [], 1, null, "Pizza", "Ali");
        a.SendToKitchen(4, DateTime.UtcNow);
        var b = Check();
        a.Label("A");
        b.Label("B");

        a.SplitOnto(b, [(burgers.Id, 1), (pizza.Id, 1)]);
        Assert.Equal((2, 1), (a.Lines.Single().Quantity, b.Lines.Count(l => l.Code == 7001 && l.Quantity == 1)));
        Assert.All(b.Lines, l => Assert.Equal((LineStatus.Sent, 4), (l.Status, l.KitchenTicketNumber!.Value)));
        Assert.Equal(a.Id, b.SplitFromId);
        Assert.Throws<DomainException>(() => a.SplitOnto(Check(), [(a.Lines.Single().Id, 2)]));

        b.MergeFrom(a);
        Assert.Equal((OrderStatus.Merged, b.Id), (a.Status, a.MergedIntoId!.Value));
        Assert.Equal(3, b.Lines.Where(l => l.Code == 7001).Sum(l => l.Quantity));
        Assert.Throws<DomainException>(() => a.MergeFrom(b));
    }

    [Fact]
    public void A_check_with_nothing_in_the_kitchen_is_cancelled_its_drafts_kept_as_voids()
    {
        var order = Check();
        AddBurger(order, 2);
        order.Cancel("Guest left", "Ali");
        Assert.Equal((OrderStatus.Cancelled, 1, VoidKind.BeforeKitchen), (order.Status, order.Voids.Count, order.Voids[0].Kind));

        var sent = Check();
        AddBurger(sent);
        sent.SendToKitchen(1, DateTime.UtcNow);
        Assert.Throws<DomainException>(() => sent.Cancel(null, "Ali"));
    }

    [Fact]
    public void A_kitchen_ticket_is_bumped_a_station_at_a_time_and_its_items_are_prepared()
    {
        var order = Check();
        var burger = AddBurger(order);
        var pizza = order.AddLine(Guid.NewGuid(), Pizza, Pizza.Sizes[0], [], 1, null, "Pizza", "Ali");
        order.SendToKitchen(1, DateTime.UtcNow);
        var ticket = new KitchenTicket(Guid.NewGuid(), 1, Today, TicketKind.New, order, "Ali");
        ticket.Add(Guid.NewGuid(), burger, 1);
        ticket.Add(Guid.NewGuid(), pizza, 1);

        var made = ticket.Bump(Burger.StationId, DateTime.UtcNow);
        Assert.Equal([burger.Id], made);
        Assert.False(ticket.IsDone);
        order.Prepared(made, DateTime.UtcNow);
        Assert.Equal((LineStatus.Prepared, LineStatus.Sent), (burger.Status, pizza.Status));
        ticket.Bump(Pizza.StationId, DateTime.UtcNow);
        Assert.True(ticket.IsDone);
        ticket.Recall(Pizza.StationId);
        Assert.False(ticket.IsDone);
    }

    [Fact]
    public void A_shift_takes_paid_outs_while_open_and_keeps_its_report_once_closed()
    {
        var shift = new Shift(Guid.NewGuid(), 1, Today, 500, "u1", "Mona");
        shift.PayOut(Guid.NewGuid(), PaidOutKind.Expense, 40, "Ice", null, "Mona");
        Assert.Throws<DomainException>(() => shift.PayOut(Guid.NewGuid(), PaidOutKind.StaffAdvance, 100, "Advance", null, "Mona"));
        shift.PayOut(Guid.NewGuid(), PaidOutKind.StaffAdvance, 100, "Advance", "Hassan", "Mona");
        Assert.Equal(140m, shift.PaidOutTotal);
        Assert.Throws<DomainException>(() => shift.Keep("{}"));
        shift.Close(1000, "Mona");
        shift.Keep("{\"a\":1}");
        shift.Keep("{\"b\":2}");
        Assert.Equal((ShiftStatus.Closed, "{\"a\":1}"), (shift.Status, shift.ZReport));
        Assert.Throws<DomainException>(() => shift.PayOut(Guid.NewGuid(), PaidOutKind.Expense, 1, "x", null, "Mona"));
    }

    [Fact]
    public void A_sync_items_id_is_the_same_for_the_same_subject_and_it_backs_off_when_not_delivered()
    {
        var id = SyncItem.IdFor(LinkedSystem.Costing, "day.closed", "shift-1");
        Assert.Equal(id, SyncItem.IdFor(LinkedSystem.Costing, "day.closed", "shift-1"));
        Assert.NotEqual(id, SyncItem.IdFor(LinkedSystem.Loyalty, "day.closed", "shift-1"));
        Assert.Equal(5, id.ToString()[14] - '0');

        var item = new SyncItem(id, LinkedSystem.Costing, "day.closed", "Shift 1", "{}");
        item.NotDelivered("offline", failed: false);
        Assert.Equal((SyncStatus.Pending, 1), (item.Status, item.Attempts));
        Assert.True(item.NextAttemptAtUtc > DateTime.UtcNow.AddSeconds(10));
        item.NotDelivered("bad", failed: true);
        Assert.Equal(SyncStatus.Failed, item.Status);
        item.Retry();
        item.Delivered();
        Assert.Equal(SyncStatus.Sent, item.Status);
    }

    [Fact]
    public void The_settings_keep_their_limits_and_value_points()
    {
        var settings = PosSettings.Defaults();
        Assert.Equal(10m, settings.ValueOf(100));
        Assert.Throws<DomainException>(() => settings.Update(60, 12, null, null, null, 0.1m, 10, 10, ["Late"], [], "Boss"));
        Assert.Throws<DomainException>(() => settings.Update(14, 12, null, null, null, 0.1m, 10, 10, [], [], "Boss"));
        var link = new IntegrationLink(LinkedSystem.Costing);
        Assert.Throws<DomainException>(() => link.Update(true, null, null, null, "Boss"));
        Assert.Throws<DomainException>(() => link.Update(false, "ftp://x", null, null, "Boss"));
        link.Update(true, "https://costing.example.com/", "key-1", "BR1", "Boss");
        link.Update(true, "https://costing.example.com", "", "BR1", "Boss");
        Assert.Equal(("https://costing.example.com", "key-1", true), (link.BaseUrl, link.ApiKey, link.IsReady));
    }
}

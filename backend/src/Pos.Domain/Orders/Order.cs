using Pos.Domain.Catalog;
using Pos.Domain.Common;
using Pos.Domain.Floor;

namespace Pos.Domain.Orders;

public enum OrderType
{
    DineIn = 1,
    Takeaway = 2,
    Delivery = 3,
}

public enum OrderStatus
{
    // Being taken: items added, sent to the kitchen, more added.
    Open = 1,

    // Its bill printed for the guest (طباعة الشيك): the table waits to pay. Adding or voiding an
    // item takes it back to Open, the printed bill no longer being right.
    BillPrinted = 2,

    // Settled: paid in full. Fixed from then on.
    Paid = 3,

    // Taken off before anything reached the kitchen: nothing to pay.
    Cancelled = 4,

    // Merged into another check: its items carried over, it is kept only as the record.
    Merged = 5,
}

// Where an item is in the kitchen: a draft (لم يُرسل) is still only on the check, sent (أُرسل
// للمطبخ) is on a kitchen ticket, prepared is made. A line voided down to nothing is Voided.
public enum LineStatus
{
    Draft = 1,
    Sent = 2,
    Prepared = 3,
    Voided = 4,
}

// Which void it was. Decided by the line's state, never chosen by whoever voids it: an item the
// kitchen has seen can never be voided as "before the kitchen" to keep it off the waste.
public enum VoidKind
{
    // Still a draft: off the check, nothing made, nothing wasted (إلغاء قبل المطبخ).
    BeforeKitchen = 1,

    // On a kitchen ticket already: a manager's, with a reason, and a VOID ticket to the kitchen
    // (إلغاء بعد الإرسال للمطبخ).
    AfterKitchen = 2,
}

// What became of what a void after the kitchen took off.
public enum StockOutcome
{
    // A void before the kitchen: nothing was made.
    None = 1,

    // Made already: its ingredients are waste (تم تحضيره - يُسجل هالك).
    Waste = 2,

    // Not made yet: its ingredients go back to stock (لم يُحضر - يعود للمخزن).
    ReturnToStock = 3,
}

public enum PaymentMethod
{
    Cash = 1,
    Card = 2,

    // A mobile wallet or instant transfer (InstaPay, Vodafone Cash).
    Wallet = 3,

    // Eaten by a member of staff (وجبة عاملين): charged to them, sent to payroll.
    StaffMeal = 4,
}

// What a check came to: the items, less their own discounts and the bill's (the cashier's and the
// points redeemed), the service charge on a table's, then the tax on all of it.
public sealed record CheckTotals(
    decimal Gross,
    decimal LineDiscounts,
    decimal BillDiscount,
    decimal Redemption,
    decimal Service,
    decimal Tax,
    decimal Total,
    decimal Paid,
    decimal Due)
{
    // What the tax and the service are charged on.
    public decimal Net => Gross - LineDiscounts - BillDiscount - Redemption;
}

// A check (شيك): a table's, a takeaway's or a delivery's. Its id is made by the terminal or the
// captain's phone, and so is each line's, so a request sent twice (the network lost the answer)
// changes nothing the second time.
public sealed class Order : AggregateRoot
{
    public const int MaxGuests = 99;
    public const int MaxLines = 300;

    private readonly List<OrderLine> _lines = [];
    private readonly List<VoidEntry> _voids = [];
    private readonly List<Payment> _payments = [];

    private Order() { }

    public Order(
        Guid id, int number, DateOnly businessDate, OrderType type, DiningTable? table, int guests, string openedById, string openedBy,
        decimal servicePercent, decimal taxPercent)
    {
        if (!Enum.IsDefined(type))
            throw new DomainException("Choose the order type: dine-in, takeaway or delivery. · نوع الطلب.");
        if (type == OrderType.DineIn && table is null)
            throw new DomainException("A dine-in check is opened on a table. · اختر الترابيزة.");
        if (guests is < 0 or > MaxGuests)
            throw new DomainException("Guests are 0 to 99. · عدد الأفراد من 0 إلى 99.");
        Id = id;
        Number = number;
        BusinessDate = businessDate;
        Type = type;
        TableId = type == OrderType.DineIn ? table!.Id : null;
        TableLabel = type == OrderType.DineIn ? table!.Label : null;
        Guests = type == OrderType.DineIn ? Math.Max(guests, 1) : guests;
        Status = OrderStatus.Open;
        OpenedById = openedById;
        OpenedBy = openedBy;
        OpenedAtUtc = DateTime.UtcNow;
        // A service charge is a table's only.
        ServicePercent = type == OrderType.DineIn ? servicePercent : 0;
        TaxPercent = taxPercent;
    }

    // The day's own number, from 1: what the kitchen and the guest are told.
    public int Number { get; private set; }
    public DateOnly BusinessDate { get; private set; }
    public OrderType Type { get; private set; }
    public OrderStatus Status { get; private set; }
    public Guid? TableId { get; private set; }
    public string? TableLabel { get; private set; }
    public int Guests { get; private set; }

    // A split check's letter: A, B, C. None for a check never split.
    public string? CheckLabel { get; private set; }

    // The check it was split from, and the check it was merged into.
    public Guid? SplitFromId { get; private set; }
    public Guid? MergedIntoId { get; private set; }

    // How many guests share it evenly, when they do (تقسيم الحساب بالتساوي).
    public int? SplitWays { get; private set; }

    public string OpenedById { get; private set; } = string.Empty;
    public string OpenedBy { get; private set; } = string.Empty;
    public DateTime OpenedAtUtc { get; private set; }
    public string? Notes { get; private set; }

    // Who it is for: a customer of the loyalty programme, or a name and phone for a delivery.
    public Guid? CustomerId { get; private set; }
    public string? CustomerName { get; private set; }
    public string? CustomerPhone { get; private set; }
    public string? LoyaltyUserId { get; private set; }
    public string? DeliveryAddress { get; private set; }
    public string? DriverName { get; private set; }

    public decimal ServicePercent { get; private set; }
    public decimal TaxPercent { get; private set; }

    // The bill's own discount, and why.
    public decimal DiscountAmount { get; private set; }
    public string? DiscountReason { get; private set; }
    public string? DiscountBy { get; private set; }

    // Points redeemed off the bill, and what they took off.
    public int PointsRedeemed { get; private set; }
    public decimal RedemptionAmount { get; private set; }

    // What the bill earned, once it was paid.
    public int PointsEarned { get; private set; }

    public DateTime? BillPrintedAtUtc { get; private set; }
    public int BillPrints { get; private set; }
    public DateTime? PaidAtUtc { get; private set; }
    public string? SettledBy { get; private set; }
    public Guid? ShiftId { get; private set; }
    public DateTime? ClosedAtUtc { get; private set; }
    public string? CancelReason { get; private set; }

    public IReadOnlyList<OrderLine> Lines => _lines.OrderBy(l => l.AddedAtUtc).ThenBy(l => l.Position).ToList().AsReadOnly();
    public IReadOnlyList<VoidEntry> Voids => _voids.OrderBy(v => v.AtUtc).ToList().AsReadOnly();
    public IReadOnlyList<Payment> Payments => _payments.OrderBy(p => p.AtUtc).ToList().AsReadOnly();

    public bool IsClosed => Status is OrderStatus.Paid or OrderStatus.Cancelled or OrderStatus.Merged;
    public bool HasDrafts => _lines.Any(l => l.Status == LineStatus.Draft && l.Quantity > 0);

    // Anything the kitchen has had: what makes the next ticket an add-on (بون إلحاقي).
    public bool HasBeenToKitchen => _lines.Any(l => l.KitchenTicketNumber is not null);

    public CheckTotals Totals
    {
        get
        {
            var live = _lines.Where(l => l.Quantity > 0).ToList();
            var gross = Round(live.Sum(l => l.Quantity * l.UnitPrice));
            var lineDiscounts = Round(live.Sum(l => l.Discount));
            var afterLines = gross - lineDiscounts;
            var discount = Math.Min(DiscountAmount, afterLines);
            var redemption = Math.Min(RedemptionAmount, afterLines - discount);
            var net = afterLines - discount - redemption;
            var service = Round(net * ServicePercent / 100);
            var tax = Round((net + service) * TaxPercent / 100);
            var total = net + service + tax;
            var paid = Round(_payments.Sum(p => p.Amount));
            return new CheckTotals(gross, lineDiscounts, discount, redemption, service, tax, total, paid, Math.Max(0, total - paid));
        }
    }

    public OrderLine Line(Guid lineId) => _lines.SingleOrDefault(l => l.Id == lineId) ?? throw new NotFoundException("Order line", lineId);

    // An item onto the check, a draft until it is sent: its size, its modifiers and a note for
    // the kitchen; its price is the size's (or the item's) and what each modifier adds.
    public OrderLine AddLine(
        Guid lineId, MenuItem item, MenuItemSize? size, IReadOnlyList<MenuModifier> modifiers, int quantity, string? notes, string? stationName,
        string by)
    {
        EnsureOpen();
        if (_lines.Any(l => l.Id == lineId))
            return _lines.Single(l => l.Id == lineId);
        if (_lines.Count >= MaxLines)
            throw new DomainException($"A check holds {MaxLines} lines at most: split it. · قسّم الشيك.");
        if (!item.IsActive)
            throw new DomainException($"{item.Name} is off the menu. · الصنف غير متاح.");
        if (item.Sizes.Count > 0 && size is null)
            throw new DomainException($"Choose {item.Name}'s size. · اختر الحجم.");
        var line = new OrderLine(lineId, Id, item, size, modifiers, quantity, notes, stationName, by, _lines.Count);
        _lines.Add(line);
        Reopen();
        return line;
    }

    // A draft's quantity or note, before it goes to the kitchen.
    public void ChangeDraft(Guid lineId, int quantity, string? notes)
    {
        EnsureOpen();
        var line = Line(lineId);
        if (line.Status != LineStatus.Draft)
            throw new DomainException("It is with the kitchen already: void it to take it off. · أُرسل للمطبخ: ألغِه.");
        line.Change(quantity, notes);
    }

    // The drafts to the kitchen (إرسال للمطبخ): each locked, on the ticket numbered here. The first
    // ticket is the order's, any after it an add-on (بون إلحاقي) with only what is new.
    public IReadOnlyList<OrderLine> SendToKitchen(int ticketNumber, DateTime atUtc)
    {
        EnsureOpen();
        var drafts = _lines.Where(l => l.Status == LineStatus.Draft && l.Quantity > 0).ToList();
        if (drafts.Count == 0)
            throw new DomainException("Nothing new to send to the kitchen. · لا يوجد جديد للإرسال.");
        foreach (var line in drafts)
            line.Sent(ticketNumber, atUtc);
        return drafts;
    }

    // Taken off the check, all of a line or some of its quantity. A draft goes as a void before the
    // kitchen, with nothing more asked; an item the kitchen has goes as a void after it, only with
    // a manager's say, a reason, and whether it was made (waste) or not (back to stock).
    public VoidEntry Void(
        Guid voidId, Guid lineId, int quantity, string? reason, StockOutcome outcome, string? authorizedBy, string by, int? ticketNumber = null)
    {
        if (_voids.SingleOrDefault(v => v.Id == voidId) is { } done)
            return done;
        EnsureOpen();
        var line = Line(lineId);
        if (quantity < 1 || quantity > line.Quantity)
            throw new DomainException($"Void 1 to {line.Quantity} of {line.Name}. · الكمية من 1 إلى {line.Quantity}.");
        var kind = line.Status == LineStatus.Draft ? VoidKind.BeforeKitchen : VoidKind.AfterKitchen;
        if (kind == VoidKind.AfterKitchen)
        {
            if (string.IsNullOrWhiteSpace(authorizedBy))
                throw new ForbiddenException("A void after the kitchen needs a manager's PIN. · يلزم رقم المدير السري.");
            if (string.IsNullOrWhiteSpace(reason))
                throw new DomainException("Say why it is voided. · سبب الإلغاء.");
            if (outcome is not (StockOutcome.Waste or StockOutcome.ReturnToStock))
                throw new DomainException("Say whether it was made (waste) or not (back to stock). · هالك أم يعود للمخزن.");
        }
        else
        {
            outcome = StockOutcome.None;
        }

        var amount = Round(quantity * line.UnitPrice - (line.Quantity == quantity ? line.Discount : 0));
        var entry = new VoidEntry(
            voidId, Id, line, quantity, amount, kind, reason, outcome, kind == VoidKind.AfterKitchen ? authorizedBy!.Trim() : null, by,
            kind == VoidKind.AfterKitchen ? ticketNumber : null);
        line.TakeOff(quantity);
        _voids.Add(entry);
        Reopen();
        return entry;
    }

    // The bill for the guest (طباعة الشيك): the table now waits to pay.
    public void PrintBill(DateTime atUtc)
    {
        EnsureOpen();
        if (!_lines.Any(l => l.Quantity > 0))
            throw new DomainException("The check is empty. · الشيك فارغ.");
        Status = OrderStatus.BillPrinted;
        BillPrintedAtUtc = atUtc;
        BillPrints++;
    }

    public void SetGuests(int guests)
    {
        EnsureOpen();
        if (guests is < 0 or > MaxGuests)
            throw new DomainException("Guests are 0 to 99. · عدد الأفراد من 0 إلى 99.");
        Guests = guests;
    }

    public void SetNotes(string? notes)
    {
        EnsureOpen();
        Notes = Names.Optional(notes, 300);
    }

    public void SetDelivery(string? address, string? driverName)
    {
        EnsureOpen();
        if (Type != OrderType.Delivery)
            throw new DomainException("Only a delivery has an address and a driver.");
        DeliveryAddress = Names.Optional(address, 300);
        DriverName = Names.Optional(driverName, 120);
    }

    // The bill's discount, at most what the items come to after their own discounts.
    public void Discount(decimal amount, string? reason, string by)
    {
        EnsureOpen();
        if (amount < 0)
            throw new DomainException("A discount is zero or more. · الخصم صفر أو أكثر.");
        var totals = Totals;
        if (amount > totals.Gross - totals.LineDiscounts)
            throw new DomainException("The discount is more than the check. · الخصم أكبر من الشيك.");
        DiscountAmount = Round(amount);
        DiscountReason = amount == 0 ? null : Names.Optional(reason, 200);
        DiscountBy = amount == 0 ? null : by;
        Reopen();
    }

    public void AttachCustomer(Guid? customerId, string? name, string? phone, string? loyaltyUserId)
    {
        if (IsClosed)
            throw new DomainException("This check is closed. · الشيك مغلق.");
        CustomerId = customerId;
        CustomerName = Names.Optional(name, 120);
        CustomerPhone = Names.Optional(phone, 32);
        LoyaltyUserId = Names.Optional(loyaltyUserId, 64);
        if (customerId is null && PointsRedeemed > 0)
            Redeem(0, 0);
    }

    // Points off the bill (استبدال النقاط), never more than it comes to before tax.
    public void Redeem(int points, decimal value)
    {
        EnsureOpen();
        if (points < 0 || value < 0)
            throw new DomainException("Redeem zero points or more.");
        if (points > 0 && CustomerId is null)
            throw new DomainException("Attach the customer first. · سجّل العميل أولاً.");
        var totals = Totals;
        if (value > totals.Gross - totals.LineDiscounts - totals.BillDiscount)
            throw new DomainException("The points are worth more than the check. · قيمة النقاط أكبر من الشيك.");
        PointsRedeemed = points;
        RedemptionAmount = Round(value);
        Reopen();
    }

    // Shared evenly by this many guests, each paying a part.
    public void SplitEvenly(int ways)
    {
        EnsureOpen();
        if (ways is < 2 or > 20)
            throw new DomainException("Split between 2 and 20 guests. · من 2 إلى 20.");
        SplitWays = ways;
    }

    // A payment toward the check (دفع): cash (what was handed over too, for the change), a card, a
    // wallet, or a staff meal. Paid in full, the check is settled into the shift, and what it
    // earned in points is worked out at the rate given.
    public Payment Pay(Guid paymentId, PaymentMethod method, decimal amount, decimal? tendered, string? reference, string by, Guid shiftId, decimal pointsPerUnit)
    {
        if (_payments.SingleOrDefault(p => p.Id == paymentId) is { } made)
            return made;
        EnsureOpen();
        if (HasDrafts)
            throw new DomainException("Send the new items to the kitchen first. · أرسل الأصناف الجديدة أولاً.");
        if (!Enum.IsDefined(method))
            throw new DomainException("Choose how it is paid. · طريقة الدفع.");
        var due = Totals.Due;
        if (amount <= 0 || Round(amount) > due)
            throw new DomainException($"Pay more than nothing and no more than what is due. · المبلغ المستحق {due:N2}.");
        if (method == PaymentMethod.Cash && tendered is { } handed && handed < amount)
            throw new DomainException("The cash handed over is less than the payment. · المبلغ المدفوع أقل.");
        if (method == PaymentMethod.StaffMeal && string.IsNullOrWhiteSpace(reference))
            throw new DomainException("Say whose meal it is. · اسم الموظف.");

        var payment = new Payment(paymentId, Id, method, Round(amount), method == PaymentMethod.Cash ? tendered : null, reference, by, shiftId);
        _payments.Add(payment);
        if (Totals.Due == 0)
        {
            Status = OrderStatus.Paid;
            PaidAtUtc = ClosedAtUtc = DateTime.UtcNow;
            SettledBy = by;
            ShiftId = shiftId;
            PointsEarned = CustomerId is null ? 0 : (int)Math.Floor(Totals.Total * pointsPerUnit);
        }
        return payment;
    }

    // Off before anything reached the kitchen or was paid: nothing to charge.
    public void Cancel(string? reason, string by)
    {
        EnsureOpen();
        if (_lines.Any(l => l.Quantity > 0 && l.Status != LineStatus.Draft))
            throw new DomainException("The kitchen has items of this check: void them first. · ألغِ الأصناف المرسلة أولاً.");
        if (_payments.Count > 0)
            throw new DomainException("Part of it is paid. · تم دفع جزء منه.");
        foreach (var line in _lines.Where(l => l.Quantity > 0))
            _voids.Add(new VoidEntry(Guid.NewGuid(), Id, line, line.Quantity, Round(line.Quantity * line.UnitPrice), VoidKind.BeforeKitchen,
                reason ?? "Check cancelled", StockOutcome.None, null, by, null));
        foreach (var line in _lines)
            line.TakeOff(line.Quantity);
        Status = OrderStatus.Cancelled;
        CancelReason = Names.Optional(reason, 200);
        ClosedAtUtc = DateTime.UtcNow;
    }

    // To another table (نقل ترابيزة), its items as they are.
    public void MoveTo(DiningTable table)
    {
        EnsureOpen();
        if (Type != OrderType.DineIn)
            throw new DomainException("Only a table's check moves to another table.");
        TableId = table.Id;
        TableLabel = table.Label;
    }

    public void Label(string? checkLabel) => CheckLabel = checkLabel;

    // Part of this check onto a new one (فصل الشيك): each line's quantity given moves over as it is,
    // drafts as drafts, what the kitchen has under its ticket; a line moved whole leaves this one.
    public void SplitOnto(Order other, IReadOnlyList<(Guid LineId, int Quantity)> moves)
    {
        EnsureOpen();
        other.EnsureOpen();
        if (moves.Count == 0)
            throw new DomainException("Choose what goes on the new check. · اختر الأصناف.");
        if (_payments.Count > 0)
            throw new DomainException("Part of this check is paid: settle it as it is. · تم دفع جزء منه.");
        // Checked whole before anything moves: a refused split leaves both checks as they were.
        var moving = moves.GroupBy(m => m.LineId).Select(g => (Line: Line(g.Key), Quantity: g.Sum(m => m.Quantity))).ToList();
        foreach (var (line, quantity) in moving)
            if (quantity < 1 || quantity > line.Quantity)
                throw new DomainException($"Move 1 to {line.Quantity} of {line.Name}. · الكمية من 1 إلى {line.Quantity}.");
        if (_lines.Sum(l => l.Quantity) == moving.Sum(m => m.Quantity))
            throw new DomainException("Leave something on this check: move only part of it. · اترك صنفاً على الشيك.");
        foreach (var (line, quantity) in moving)
        {
            other._lines.Add(line.CopyTo(other.Id, quantity, other._lines.Count));
            if (quantity == line.Quantity)
                _lines.Remove(line);
            else
                line.MoveOff(quantity);
        }
        other.SplitFromId = Id;
        other.CustomerId ??= CustomerId;
        Reopen();
        other.Reopen();
    }

    // Another check's items onto this one (دمج ترابيزات): that check is kept as merged into this.
    public void MergeFrom(Order other)
    {
        EnsureOpen();
        other.EnsureOpen();
        if (other.Id == Id)
            throw new DomainException("A check is not merged into itself.");
        if (other._payments.Count > 0 || _payments.Count > 0)
            throw new DomainException("Part of a check is paid: settle it first. · تم دفع جزء منه.");
        foreach (var line in other._lines.Where(l => l.Quantity > 0))
            _lines.Add(line.CopyTo(Id, line.Quantity, _lines.Count));
        Guests += other.Guests;
        other.Status = OrderStatus.Merged;
        other.MergedIntoId = Id;
        other.ClosedAtUtc = DateTime.UtcNow;
        Reopen();
    }

    // The kitchen made these.
    public void Prepared(IReadOnlyCollection<Guid> lineIds, DateTime atUtc)
    {
        foreach (var line in _lines.Where(l => lineIds.Contains(l.Id)))
            line.Made(atUtc);
    }

    private void EnsureOpen()
    {
        if (Status is OrderStatus.Paid)
            throw new DomainException("This check is paid. · الشيك مدفوع.");
        if (Status is OrderStatus.Cancelled or OrderStatus.Merged)
            throw new DomainException("This check is closed. · الشيك مغلق.");
    }

    // A change after the bill was printed: the bill no longer says what is owed.
    private void Reopen()
    {
        if (Status == OrderStatus.BillPrinted)
            Status = OrderStatus.Open;
    }

    public static decimal Round(decimal value) => Math.Round(value, 2, MidpointRounding.AwayFromZero);
}

// An item on a check, as it was when added: its names, size, modifiers and price are kept, so a
// menu changed since never changes what was sold.
public sealed class OrderLine : Entity
{
    private OrderLine() { }

    internal OrderLine(
        Guid id, Guid orderId, MenuItem item, MenuItemSize? size, IReadOnlyList<MenuModifier> modifiers, int quantity, string? notes,
        string? stationName, string by, int position)
    {
        Id = id;
        OrderId = orderId;
        MenuItemId = item.Id;
        Code = item.Code;
        Name = item.Name;
        NameAr = item.NameAr;
        SizeId = size?.Id;
        SizeName = size?.Name;
        SizeNameAr = size?.NameAr;
        Modifiers = string.Join(", ", modifiers.Select(m => m.Name));
        ModifiersAr = modifiers.Any(m => m.NameAr is not null) ? string.Join("، ", modifiers.Select(m => m.NameAr ?? m.Name)) : null;
        UnitPrice = Order.Round((size?.Price ?? item.Price) + modifiers.Sum(m => m.Price));
        StationId = item.StationId;
        StationName = stationName;
        Status = LineStatus.Draft;
        AddedBy = by;
        AddedAtUtc = DateTime.UtcNow;
        Position = position;
        Change(quantity, notes);
    }

    public Guid OrderId { get; private set; }
    public Guid MenuItemId { get; private set; }
    public int Code { get; private set; }
    public string Name { get; private set; } = string.Empty;
    public string? NameAr { get; private set; }
    public Guid? SizeId { get; private set; }
    public string? SizeName { get; private set; }
    public string? SizeNameAr { get; private set; }

    // "Extra cheese, No onions": as the ticket and the bill print them.
    public string Modifiers { get; private set; } = string.Empty;
    public string? ModifiersAr { get; private set; }

    // The note for the kitchen (بدون بصل، تسوية زيادة).
    public string? Notes { get; private set; }

    public decimal UnitPrice { get; private set; }

    // What is still on the check; what was voided is in the check's voids.
    public int Quantity { get; private set; }
    public decimal Discount { get; private set; }
    public Guid? StationId { get; private set; }
    public string? StationName { get; private set; }
    public LineStatus Status { get; private set; }
    public int? KitchenTicketNumber { get; private set; }
    public DateTime? SentAtUtc { get; private set; }
    public DateTime? PreparedAtUtc { get; private set; }
    public string AddedBy { get; private set; } = string.Empty;
    public DateTime AddedAtUtc { get; private set; }
    public int Position { get; private set; }

    public decimal Total => Order.Round(Quantity * UnitPrice - Discount);

    internal void Change(int quantity, string? notes)
    {
        if (quantity is < 1 or > 999)
            throw new DomainException("A quantity is 1 to 999. · الكمية من 1 إلى 999.");
        Quantity = quantity;
        Notes = Names.Optional(notes, 200);
    }

    internal void Sent(int ticketNumber, DateTime atUtc)
    {
        Status = LineStatus.Sent;
        KitchenTicketNumber = ticketNumber;
        SentAtUtc = atUtc;
    }

    internal void Made(DateTime atUtc)
    {
        if (Status == LineStatus.Sent)
        {
            Status = LineStatus.Prepared;
            PreparedAtUtc = atUtc;
        }
    }

    internal void TakeOff(int quantity)
    {
        if (quantity == Quantity)
            Discount = 0;
        Quantity -= quantity;
        if (Quantity == 0)
            Status = LineStatus.Voided;
    }

    internal void MoveOff(int quantity) => Quantity -= quantity;

    // This line's quantity given, onto another check, as it stands in the kitchen.
    internal OrderLine CopyTo(Guid orderId, int quantity, int position) => new()
    {
        Id = Guid.NewGuid(),
        OrderId = orderId,
        MenuItemId = MenuItemId,
        Code = Code,
        Name = Name,
        NameAr = NameAr,
        SizeId = SizeId,
        SizeName = SizeName,
        SizeNameAr = SizeNameAr,
        Modifiers = Modifiers,
        ModifiersAr = ModifiersAr,
        Notes = Notes,
        UnitPrice = UnitPrice,
        Quantity = quantity,
        StationId = StationId,
        StationName = StationName,
        Status = Status,
        KitchenTicketNumber = KitchenTicketNumber,
        SentAtUtc = SentAtUtc,
        PreparedAtUtc = PreparedAtUtc,
        AddedBy = AddedBy,
        AddedAtUtc = AddedAtUtc,
        Position = position,
    };
}

// A void, kept for the audit and the Z report: what, how many, for how much, which kind, why, who
// voided it and which manager said so, and what became of it.
public sealed class VoidEntry : Entity
{
    private VoidEntry() { }

    internal VoidEntry(
        Guid id, Guid orderId, OrderLine line, int quantity, decimal amount, VoidKind kind, string? reason, StockOutcome outcome,
        string? authorizedBy, string by, int? ticketNumber)
    {
        Id = id;
        OrderId = orderId;
        LineId = line.Id;
        MenuItemId = line.MenuItemId;
        Code = line.Code;
        ItemName = line.Name;
        Quantity = quantity;
        Amount = amount;
        Kind = kind;
        Reason = Names.Optional(reason, 200) ?? (kind == VoidKind.BeforeKitchen ? "Removed before the kitchen" : null);
        Outcome = outcome;
        AuthorizedBy = authorizedBy;
        VoidedBy = by;
        AtUtc = DateTime.UtcNow;
        KitchenTicketNumber = ticketNumber;
    }

    public Guid OrderId { get; private set; }
    public Guid LineId { get; private set; }
    public Guid MenuItemId { get; private set; }
    public int Code { get; private set; }
    public string ItemName { get; private set; } = string.Empty;
    public int Quantity { get; private set; }
    public decimal Amount { get; private set; }
    public VoidKind Kind { get; private set; }
    public string? Reason { get; private set; }
    public StockOutcome Outcome { get; private set; }
    public string? AuthorizedBy { get; private set; }
    public string VoidedBy { get; private set; } = string.Empty;
    public DateTime AtUtc { get; private set; }

    // The VOID ticket that told the kitchen.
    public int? KitchenTicketNumber { get; private set; }
}

public sealed class Payment : Entity
{
    private Payment() { }

    internal Payment(Guid id, Guid orderId, PaymentMethod method, decimal amount, decimal? tendered, string? reference, string by, Guid shiftId)
    {
        Id = id;
        OrderId = orderId;
        Method = method;
        Amount = amount;
        Tendered = tendered is { } t ? Order.Round(t) : null;
        Reference = Names.Optional(reference, 120);
        By = by;
        ShiftId = shiftId;
        AtUtc = DateTime.UtcNow;
    }

    public Guid OrderId { get; private set; }
    public PaymentMethod Method { get; private set; }
    public decimal Amount { get; private set; }

    // The cash handed over; the change is what it is over the payment.
    public decimal? Tendered { get; private set; }
    public decimal Change => Tendered is { } t ? Math.Max(0, t - Amount) : 0;

    // A card's slip number, or the employee a staff meal is charged to.
    public string? Reference { get; private set; }
    public string By { get; private set; } = string.Empty;
    public Guid ShiftId { get; private set; }
    public DateTime AtUtc { get; private set; }
}

// Returns orders with their lines, voids and payments loaded.
public interface IOrderRepository : IRepository<Order>
{
    // Every check not closed: the floor, the kitchen and the till's open list.
    Task<IReadOnlyList<Order>> GetOpenAsync(CancellationToken cancellationToken = default);

    Task<IReadOnlyList<Order>> GetOpenOnTableAsync(Guid tableId, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<Order>> GetForDayAsync(DateOnly businessDate, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<Order>> GetForShiftAsync(Guid shiftId, CancellationToken cancellationToken = default);

    // The day's next check number, and the next kitchen ticket number: each counted from 1 a day.
    Task<int> NextNumberAsync(DateOnly businessDate, CancellationToken cancellationToken = default);
}

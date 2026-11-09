using Pos.Domain.Catalog;
using Pos.Domain.Common;

namespace Pos.Domain.Customers;

// A guest the restaurant knows (عميل): found by phone, name or their loyalty card's QR code, and
// registered with a name and a phone. Their points are the loyalty programme's: the balance here is
// what it last said, shown on the check; the loyalty system keeps the real one.
public sealed class Customer : AggregateRoot
{
    private Customer() { }

    public Customer(Guid id, string name, string phone)
    {
        Id = id;
        Update(name, phone);
        CreatedAtUtc = DateTime.UtcNow;
    }

    public string Name { get; private set; } = string.Empty;

    // Digits only, as typed or scanned: "01001234567".
    public string Phone { get; private set; } = string.Empty;

    // Their id in the online ordering & loyalty system: what their card's QR code holds.
    public string? LoyaltyUserId { get; private set; }
    public int PointsBalance { get; private set; }
    public string? Tier { get; private set; }
    public DateTime? PointsUpdatedAtUtc { get; private set; }
    public DateTime CreatedAtUtc { get; private set; }

    public void Update(string name, string phone)
    {
        Name = Names.Required(name, 120, "Enter the customer's name. · اسم العميل.");
        Phone = NormalizePhone(phone);
    }

    public void Linked(string? loyaltyUserId, int? points, string? tier)
    {
        LoyaltyUserId = Names.Optional(loyaltyUserId, 64) ?? LoyaltyUserId;
        if (points is { } balance)
        {
            PointsBalance = Math.Max(0, balance);
            PointsUpdatedAtUtc = DateTime.UtcNow;
        }
        Tier = Names.Optional(tier, 40) ?? Tier;
    }

    // Earned or redeemed here, before the loyalty system says the new balance.
    public void Moved(int points)
    {
        PointsBalance = Math.Max(0, PointsBalance + points);
        PointsUpdatedAtUtc = DateTime.UtcNow;
    }

    public static string NormalizePhone(string? phone)
    {
        var digits = new string((phone ?? string.Empty).Where(char.IsDigit).Select(c => (char)('0' + (int)char.GetNumericValue(c))).ToArray());
        if (digits.Length is < 7 or > 15)
            throw new DomainException("Enter the phone number: 7 to 15 digits. · رقم الهاتف.");
        return digits;
    }
}

public interface ICustomerRepository : IRepository<Customer>
{
    Task<Customer?> GetByPhoneAsync(string phone, CancellationToken cancellationToken = default);

    Task<Customer?> GetByLoyaltyIdAsync(string loyaltyUserId, CancellationToken cancellationToken = default);

    // By phone digits or name, the closest first.
    Task<IReadOnlyList<Customer>> SearchAsync(string text, int take, CancellationToken cancellationToken = default);
}

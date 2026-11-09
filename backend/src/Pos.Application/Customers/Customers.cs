using MediatR;
using Pos.Application.Common;
using Pos.Application.Integrations;
using Pos.Domain.Common;
using Pos.Domain.Customers;
using Pos.Domain.Integrations;

namespace Pos.Application.Customers;

// The customer & loyalty bar (تسجيل عميل / نقاط الولاء): a guest found by phone, name or their
// loyalty card's QR code, or registered with a name and phone. When the loyalty system is linked and
// reachable a phone is looked up there too, and the points come from it; when it is not, the till
// goes on with the customers and balances it knows.

public sealed record CustomerDto(Guid Id, string Name, string Phone, string? LoyaltyUserId, int Points, string? Tier, DateTime? PointsUpdatedAtUtc,
    bool Linked);

internal static class CustomerMapping
{
    public static CustomerDto Dto(Customer c) =>
        new(c.Id, c.Name, c.Phone, c.LoyaltyUserId, c.PointsBalance, c.Tier, c.PointsUpdatedAtUtc, c.LoyaltyUserId is not null);
}

// The loyalty system's word on a customer, kept here: found by their phone, linked and given its
// balance. Unreachable, nothing changes.
internal sealed class LoyaltyLookup(ILoyaltyGateway loyalty, ICustomerRepository customers)
{
    public async Task<Customer?> ByPhoneAsync(string phone, Customer? known, CancellationToken cancellationToken)
    {
        if (!loyalty.IsEnabled)
            return known;
        LoyaltyCustomer? remote;
        try
        {
            remote = await loyalty.FindByPhoneAsync(phone, cancellationToken);
        }
        catch (LinkUnavailableException)
        {
            return known;
        }
        if (remote is null)
            return known;
        if (known is null)
            customers.Add(known = new Customer(Guid.NewGuid(), remote.Name ?? phone, remote.Phone ?? phone));
        known.Linked(remote.UserId, remote.Points, remote.Tier);
        return known;
    }
}

public sealed record SearchCustomersQuery(string Text) : IRequest<IReadOnlyList<CustomerDto>>;

internal sealed class SearchCustomersHandler(ICustomerRepository customers, LoyaltyLookup lookup, IUnitOfWork unitOfWork)
    : IRequestHandler<SearchCustomersQuery, IReadOnlyList<CustomerDto>>
{
    public async Task<IReadOnlyList<CustomerDto>> Handle(SearchCustomersQuery request, CancellationToken cancellationToken)
    {
        var text = request.Text?.Trim() ?? string.Empty;
        if (text.Length < 2)
            return [];
        var found = (await customers.SearchAsync(text, 12, cancellationToken)).ToList();
        var digits = new string(text.Where(char.IsDigit).ToArray());
        // A whole phone number: the loyalty system's customer too, and their points now.
        if (digits.Length >= 10 && digits.Length == text.Count(c => !char.IsWhiteSpace(c) && c != '+' && c != '-'))
        {
            var phone = Customer.NormalizePhone(digits);
            var known = found.FirstOrDefault(c => c.Phone == phone);
            if (await lookup.ByPhoneAsync(phone, known, cancellationToken) is { } linked && !found.Contains(linked))
                found.Insert(0, linked);
            await unitOfWork.SaveChangesAsync(cancellationToken);
        }
        return found.Select(CustomerMapping.Dto).ToList();
    }
}

// A loyalty card scanned: its QR code holds the customer's loyalty id; a phone number typed or
// scanned is looked up as a phone.
public sealed record FindByCardQuery(string Code) : IRequest<CustomerDto>;

internal sealed class FindByCardHandler(ICustomerRepository customers, LoyaltyLookup lookup, ILoyaltyGateway loyalty, IUnitOfWork unitOfWork)
    : IRequestHandler<FindByCardQuery, CustomerDto>
{
    public async Task<CustomerDto> Handle(FindByCardQuery request, CancellationToken cancellationToken)
    {
        var code = request.Code?.Trim() ?? string.Empty;
        if (code.Length == 0)
            throw new DomainException("Scan the card's QR code. · امسح كود الكارت.");
        var customer = await customers.GetByLoyaltyIdAsync(code, cancellationToken);
        if (customer is null && code.All(char.IsDigit) && code.Length is >= 7 and <= 15)
            customer = await lookup.ByPhoneAsync(code, await customers.GetByPhoneAsync(code, cancellationToken), cancellationToken);
        if (customer is null)
            throw new DomainException("This card is not known here yet: find the customer by their phone once. · ابحث برقم الهاتف أول مرة.");
        if (customer.LoyaltyUserId is { } id && loyalty.IsEnabled)
        {
            try
            {
                customer.Linked(null, await loyalty.PointsAsync(id, cancellationToken), null);
            }
            catch (LinkUnavailableException)
            {
                // The balance last known.
            }
        }
        await unitOfWork.SaveChangesAsync(cancellationToken);
        return CustomerMapping.Dto(customer);
    }
}

// A new customer (عميل جديد): a name and a phone. A phone already known is that customer; the loyalty
// system is told about a new one.
public sealed record RegisterCustomerCommand(Guid Id, string Name, string Phone, Actor By) : IRequest<CustomerDto>;

internal sealed class RegisterCustomerHandler(ICustomerRepository customers, LoyaltyLookup lookup, Outbox outbox, IUnitOfWork unitOfWork)
    : IRequestHandler<RegisterCustomerCommand, CustomerDto>
{
    public async Task<CustomerDto> Handle(RegisterCustomerCommand request, CancellationToken cancellationToken)
    {
        var phone = Customer.NormalizePhone(request.Phone);
        var customer = await customers.GetByIdAsync(request.Id, cancellationToken) ?? await customers.GetByPhoneAsync(phone, cancellationToken);
        if (customer is null)
        {
            customers.Add(customer = new Customer(request.Id, request.Name, phone));
            await outbox.QueueAsync(LinkedSystem.Loyalty, "customer.registered", customer.Id.ToString(), $"New customer {customer.Name}",
                new { customer.Id, customer.Name, customer.Phone, RegisteredBy = request.By.Name, customer.CreatedAtUtc }, cancellationToken);
        }
        await lookup.ByPhoneAsync(phone, customer, cancellationToken);
        await unitOfWork.SaveChangesAsync(cancellationToken);
        return CustomerMapping.Dto(customer);
    }
}

public sealed record GetCustomerQuery(Guid Id) : IRequest<CustomerDto>;

internal sealed class GetCustomerHandler(ICustomerRepository customers) : IRequestHandler<GetCustomerQuery, CustomerDto>
{
    public async Task<CustomerDto> Handle(GetCustomerQuery request, CancellationToken cancellationToken) =>
        CustomerMapping.Dto(await customers.GetRequiredAsync(request.Id, cancellationToken));
}

using Pos.Domain.Common;

namespace Pos.Domain.Integrations;

// The systems the till can be linked to. It needs none of them: each is switched on, and set up,
// on its own (Settings → Ecosystem integrations).
public enum LinkedSystem
{
    // Costing & Financials: the day's sales for recipe deduction, the waste, the takings.
    Costing = 1,

    // Online ordering & loyalty: customers, their points, and online orders.
    Loyalty = 2,

    // HR & Payroll: staff and their PINs, attendance, advances and staff meals.
    Hr = 3,
}

// One system's link: on or off, where it is, the key it was given, the branch this till is.
public sealed class IntegrationLink
{
    private IntegrationLink() { }

    public IntegrationLink(LinkedSystem system)
    {
        System = system;
    }

    public LinkedSystem System { get; private set; }
    public bool Enabled { get; private set; }
    public string? BaseUrl { get; private set; }
    public string? ApiKey { get; private set; }
    public string? BranchCode { get; private set; }
    public DateTime? LastTestedAtUtc { get; private set; }
    public bool? LastTestOk { get; private set; }
    public string? LastTestMessage { get; private set; }
    public string? UpdatedBy { get; private set; }
    public DateTime? UpdatedAtUtc { get; private set; }

    public bool IsReady => Enabled && !string.IsNullOrWhiteSpace(BaseUrl);

    // A key left empty keeps the one there was: the screen never shows it again once saved.
    public void Update(bool enabled, string? baseUrl, string? apiKey, string? branchCode, string by)
    {
        var url = baseUrl?.Trim().TrimEnd('/');
        if (!string.IsNullOrEmpty(url) && (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")))
            throw new DomainException("Enter the system's address: https://costing.example.com. · عنوان النظام.");
        if (enabled && string.IsNullOrEmpty(url))
            throw new DomainException("Enter the system's address to switch it on. · أدخل العنوان أولاً.");
        Enabled = enabled;
        BaseUrl = string.IsNullOrEmpty(url) ? null : url;
        if (!string.IsNullOrWhiteSpace(apiKey))
            ApiKey = apiKey.Trim();
        BranchCode = string.IsNullOrWhiteSpace(branchCode) ? null : branchCode.Trim()[..Math.Min(branchCode.Trim().Length, 40)];
        UpdatedBy = by;
        UpdatedAtUtc = DateTime.UtcNow;
    }

    public void Tested(bool ok, string message)
    {
        LastTestedAtUtc = DateTime.UtcNow;
        LastTestOk = ok;
        LastTestMessage = message.Length > 300 ? message[..300] : message;
    }
}

public enum SyncStatus
{
    // Waiting to be sent: the system is off, unreachable, or it has not been tried yet.
    Pending = 1,

    Sent = 2,

    // Refused by the system for a reason trying again will not fix; kept to be looked at.
    Failed = 3,
}

// What the till owes a linked system (the outbox): a paid check's points, a day's close, a staff
// meal. Its id is worked out from what it is about, so the same thing is never queued twice, and
// the system receives it with that id to take it once. Sent in order, retried until it goes.
public sealed class SyncItem
{
    public const int MaxPayloadLength = 2_000_000;

    private SyncItem() { }

    public SyncItem(Guid id, LinkedSystem system, string kind, string summary, string payload)
    {
        Id = id;
        System = system;
        Kind = kind;
        Summary = summary.Length > 200 ? summary[..200] : summary;
        Payload = payload;
        Status = SyncStatus.Pending;
        CreatedAtUtc = NextAttemptAtUtc = DateTime.UtcNow;
    }

    public Guid Id { get; private set; }
    public LinkedSystem System { get; private set; }

    // What it is: "order.paid", "day.closed", "staff.meal".
    public string Kind { get; private set; } = string.Empty;
    public string Summary { get; private set; } = string.Empty;
    public string Payload { get; private set; } = string.Empty;
    public SyncStatus Status { get; private set; }
    public int Attempts { get; private set; }
    public DateTime NextAttemptAtUtc { get; private set; }
    public string? LastError { get; private set; }
    public DateTime CreatedAtUtc { get; private set; }
    public DateTime? SentAtUtc { get; private set; }

    public void Delivered()
    {
        Status = SyncStatus.Sent;
        SentAtUtc = DateTime.UtcNow;
        LastError = null;
    }

    // Not through: tried again later, a little later each time up to every ten minutes; or given up
    // on when the system refused it outright (failed).
    public void NotDelivered(string error, bool failed)
    {
        Attempts++;
        LastError = error.Length > 500 ? error[..500] : error;
        if (failed)
        {
            Status = SyncStatus.Failed;
            return;
        }
        var wait = TimeSpan.FromSeconds(Math.Min(600, 15 * Math.Pow(2, Math.Min(Attempts - 1, 6))));
        NextAttemptAtUtc = DateTime.UtcNow + wait;
    }

    // Now: "Sync now", or a failed one sent again.
    public void Retry()
    {
        Status = SyncStatus.Pending;
        NextAttemptAtUtc = DateTime.UtcNow;
    }

    // An id for what an item is about, the same each time: a UUID made from its system, its kind
    // and its subject (RFC 4122 version 5).
    public static Guid IdFor(LinkedSystem system, string kind, string subject)
    {
        var name = global::System.Text.Encoding.UTF8.GetBytes($"{system}:{kind}:{subject}");
        var space = new Guid("5b0b3a1c-8f0e-4c55-9f4e-1d2a3c4b5e6f").ToByteArray();
        SwapBytes(space);
        var hash = global::System.Security.Cryptography.SHA1.HashData([.. space, .. name]);
        var bytes = hash[..16];
        bytes[6] = (byte)((bytes[6] & 0x0F) | 0x50);
        bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);
        SwapBytes(bytes);
        return new Guid(bytes);
    }

    // .NET's Guid bytes put the first three fields little-endian; RFC 4122 network order is big-endian.
    private static void SwapBytes(byte[] guid)
    {
        (guid[0], guid[3]) = (guid[3], guid[0]);
        (guid[1], guid[2]) = (guid[2], guid[1]);
        (guid[4], guid[5]) = (guid[5], guid[4]);
        (guid[6], guid[7]) = (guid[7], guid[6]);
    }
}

public interface IIntegrationStore
{
    Task<IntegrationLink> GetAsync(LinkedSystem system, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<IntegrationLink>> GetAllAsync(CancellationToken cancellationToken = default);
}

public interface ISyncQueue
{
    // Queued with the unit of work, unless it is queued already.
    Task EnqueueAsync(SyncItem item, CancellationToken cancellationToken = default);

    Task<SyncItem?> GetAsync(Guid id, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<SyncItem>> GetDueAsync(int take, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<SyncItem>> GetRecentAsync(int take, CancellationToken cancellationToken = default);

    Task<(int Pending, int Failed)> CountAsync(CancellationToken cancellationToken = default);
}

using System.Text.Json;
using System.Text.Json.Serialization;
using Pos.Domain.Integrations;

namespace Pos.Application.Integrations;

// The event a linked system receives: the id it keeps it once by, what it is, which branch, when,
// and what it carries. Every system gets the same envelope at POST /api/integrations/pos/events.
public sealed record PosEvent(Guid Id, string Kind, string? BranchCode, DateTime OccurredAtUtc, object Data);

// Queues what a linked system is owed, in the same unit of work as what caused it: nothing is
// queued for a system that is switched off, so switching one on later does not send it the past.
public sealed class Outbox(IIntegrationStore links, ISyncQueue queue)
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

    public async Task<bool> QueueAsync(LinkedSystem system, string kind, string subject, string summary, object data, CancellationToken cancellationToken)
    {
        var link = await links.GetAsync(system, cancellationToken);
        if (!link.IsReady)
            return false;
        var id = SyncItem.IdFor(system, kind, subject);
        var envelope = new PosEvent(id, kind, link.BranchCode, DateTime.UtcNow, data);
        await queue.EnqueueAsync(new SyncItem(id, system, kind, summary, JsonSerializer.Serialize(envelope, Json)), cancellationToken);
        return true;
    }
}

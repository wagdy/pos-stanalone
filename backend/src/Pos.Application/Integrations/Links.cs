using MediatR;
using Pos.Application.Common;
using Pos.Domain.Common;
using Pos.Domain.Integrations;

namespace Pos.Application.Integrations;

// Settings → Ecosystem integrations: each linked system switched on or off and set up, tested, and
// what is queued for them (the sync queue), sent again on demand. The till works with none of them.

public sealed record LinkDto(LinkedSystem System, bool Enabled, string? BaseUrl, bool HasApiKey, string? ApiKeyHint, string? BranchCode,
    DateTime? LastTestedAtUtc, bool? LastTestOk, string? LastTestMessage, int Pending, int Failed, string? UpdatedBy, DateTime? UpdatedAtUtc);

public sealed record SyncItemDto(Guid Id, LinkedSystem System, string Kind, string Summary, SyncStatus Status, int Attempts, string? LastError,
    DateTime CreatedAtUtc, DateTime NextAttemptAtUtc, DateTime? SentAtUtc);

// The header's light: online and all synced, or how much waits.
public sealed record SyncStateDto(int Pending, int Failed, bool AnyLinked, bool LastSendFailed, DateTime? LastSentAtUtc);

// The last time the queue was worked: what it found. Kept in memory by the sender.
public interface ISyncHealth
{
    bool LastSendFailed { get; }

    DateTime? LastSentAtUtc { get; }

    // Work the queue now, not at its next turn.
    void Wake();
}

internal static class LinkMapping
{
    public static LinkDto Dto(IntegrationLink l, IReadOnlyList<SyncItem> recent) => new(
        l.System, l.Enabled, l.BaseUrl, !string.IsNullOrEmpty(l.ApiKey), Hint(l.ApiKey), l.BranchCode, l.LastTestedAtUtc, l.LastTestOk,
        l.LastTestMessage, recent.Count(i => i.System == l.System && i.Status == SyncStatus.Pending),
        recent.Count(i => i.System == l.System && i.Status == SyncStatus.Failed), l.UpdatedBy, l.UpdatedAtUtc);

    // The key is never shown again once saved: only its last four characters.
    private static string? Hint(string? key) => string.IsNullOrEmpty(key) ? null : key.Length <= 4 ? "••••" : $"••••{key[^4..]}";

    public static SyncItemDto Dto(SyncItem i) =>
        new(i.Id, i.System, i.Kind, i.Summary, i.Status, i.Attempts, i.LastError, i.CreatedAtUtc, i.NextAttemptAtUtc, i.SentAtUtc);
}

public sealed record GetLinksQuery : IRequest<IReadOnlyList<LinkDto>>;

internal sealed class GetLinksHandler(IIntegrationStore links, ISyncQueue queue) : IRequestHandler<GetLinksQuery, IReadOnlyList<LinkDto>>
{
    public async Task<IReadOnlyList<LinkDto>> Handle(GetLinksQuery request, CancellationToken cancellationToken)
    {
        var recent = await queue.GetRecentAsync(1000, cancellationToken);
        return (await links.GetAllAsync(cancellationToken)).OrderBy(l => l.System).Select(l => LinkMapping.Dto(l, recent)).ToList();
    }
}

public sealed record SaveLinkCommand(LinkedSystem System, bool Enabled, string? BaseUrl, string? ApiKey, string? BranchCode, Actor By) : IRequest<LinkDto>;

internal sealed class SaveLinkHandler(IIntegrationStore links, ISyncQueue queue, IPosNotifier notifier, IUnitOfWork unitOfWork)
    : IRequestHandler<SaveLinkCommand, LinkDto>
{
    public async Task<LinkDto> Handle(SaveLinkCommand request, CancellationToken cancellationToken)
    {
        if (!Enum.IsDefined(request.System))
            throw new DomainException("Choose the system.");
        var link = await links.GetAsync(request.System, cancellationToken);
        link.Update(request.Enabled, request.BaseUrl, request.ApiKey, request.BranchCode, request.By.Name);
        await unitOfWork.SaveChangesAsync(cancellationToken);
        await notifier.SyncChangedAsync(cancellationToken);
        return LinkMapping.Dto(link, await queue.GetRecentAsync(1000, cancellationToken));
    }
}

// Reaches the system with the address and key saved, and says what it found.
public sealed record TestLinkCommand(LinkedSystem System) : IRequest<LinkDto>;

internal sealed class TestLinkHandler(IIntegrationStore links, ISyncQueue queue, ILinkGateway gateway, IUnitOfWork unitOfWork)
    : IRequestHandler<TestLinkCommand, LinkDto>
{
    public async Task<LinkDto> Handle(TestLinkCommand request, CancellationToken cancellationToken)
    {
        var link = await links.GetAsync(request.System, cancellationToken);
        if (string.IsNullOrEmpty(link.BaseUrl))
            throw new DomainException("Enter the system's address first. · أدخل العنوان أولاً.");
        var result = await gateway.TestAsync(link, cancellationToken);
        link.Tested(result.Ok, result.Message);
        await unitOfWork.SaveChangesAsync(cancellationToken);
        return LinkMapping.Dto(link, await queue.GetRecentAsync(1000, cancellationToken));
    }
}

public sealed record GetSyncStateQuery : IRequest<SyncStateDto>;

internal sealed class GetSyncStateHandler(IIntegrationStore links, ISyncQueue queue, ISyncHealth health) : IRequestHandler<GetSyncStateQuery, SyncStateDto>
{
    public async Task<SyncStateDto> Handle(GetSyncStateQuery request, CancellationToken cancellationToken)
    {
        var (pending, failed) = await queue.CountAsync(cancellationToken);
        var anyLinked = (await links.GetAllAsync(cancellationToken)).Any(l => l.IsReady);
        return new SyncStateDto(pending, failed, anyLinked, health.LastSendFailed, health.LastSentAtUtc);
    }
}

public sealed record GetSyncQueueQuery(int Take = 100) : IRequest<IReadOnlyList<SyncItemDto>>;

internal sealed class GetSyncQueueHandler(ISyncQueue queue) : IRequestHandler<GetSyncQueueQuery, IReadOnlyList<SyncItemDto>>
{
    public async Task<IReadOnlyList<SyncItemDto>> Handle(GetSyncQueueQuery request, CancellationToken cancellationToken) =>
        (await queue.GetRecentAsync(Math.Clamp(request.Take, 1, 500), cancellationToken)).Select(LinkMapping.Dto).ToList();
}

// "Sync now" (مزامنة الآن): everything waiting, and anything failed when asked, sent at once.
public sealed record SyncNowCommand(bool RetryFailed, Guid? ItemId = null) : IRequest<SyncStateDto>;

internal sealed class SyncNowHandler(ISyncQueue queue, ISyncHealth health, IUnitOfWork unitOfWork, ISender sender) : IRequestHandler<SyncNowCommand, SyncStateDto>
{
    public async Task<SyncStateDto> Handle(SyncNowCommand request, CancellationToken cancellationToken)
    {
        if (request.ItemId is { } id)
        {
            var item = await queue.GetAsync(id, cancellationToken) ?? throw new NotFoundException("Sync item", id);
            item.Retry();
        }
        else
        {
            foreach (var item in await queue.GetRecentAsync(500, cancellationToken))
                if (item.Status == SyncStatus.Pending || (request.RetryFailed && item.Status == SyncStatus.Failed))
                    item.Retry();
        }
        await unitOfWork.SaveChangesAsync(cancellationToken);
        health.Wake();
        return await sender.Send(new GetSyncStateQuery(), cancellationToken);
    }
}

using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Pos.Application.Common;
using Pos.Application.Integrations;
using Pos.Domain.Integrations;
using Pos.Infrastructure.Persistence;

namespace Pos.Infrastructure.Integrations;

// The POS integration contract every linked system implements (docs/integrations.md):
//   GET  {base}/api/integrations/pos/ping     200 when the key is good
//   POST {base}/api/integrations/pos/events   a PosEvent: { id, kind, branchCode, occurredAtUtc, data };
//                                             2xx taken, 409 had it already; kept once per id
//   GET  {base}/api/integrations/pos/staff    the HR system's staff and their PINs
// The key goes as X-Api-Key, and as X-Pos-Node-Key too, which the online ordering system's own
// till endpoints (api/pos-sync) read. A system not answering, or answering 5xx, is unavailable
// and tried again; one refusing what it was sent (400, 422) is refused, and the item failed.
internal sealed class LinkGateway(IHttpClientFactory http) : ILinkGateway
{
    public const string ClientName = "links";

    public async Task<LinkTestResult> TestAsync(IntegrationLink link, CancellationToken cancellationToken = default)
    {
        try
        {
            using var ping = await SendAsync(link, HttpMethod.Get, "api/integrations/pos/ping", null, cancellationToken);
            if (ping.IsSuccessStatusCode)
                return new LinkTestResult(true, $"Connected: {(int)ping.StatusCode} from {link.BaseUrl}. · متصل.");
            if (ping.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                return new LinkTestResult(false, "Reached, but the API key was refused. · المفتاح مرفوض.");
            using var health = await SendAsync(link, HttpMethod.Get, "health", null, cancellationToken);
            return health.IsSuccessStatusCode
                ? new LinkTestResult(false, $"Reachable, but it does not take POS events yet (ping answered {(int)ping.StatusCode}). · النظام لا يستقبل بيانات نقطة البيع بعد.")
                : new LinkTestResult(false, $"It answered {(int)ping.StatusCode}. · رد غير متوقع.");
        }
        catch (LinkUnavailableException ex)
        {
            return new LinkTestResult(false, $"{ex.Message} · تعذر الاتصال.");
        }
    }

    public async Task SendAsync(IntegrationLink link, SyncItem item, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(link, HttpMethod.Post, "api/integrations/pos/events", item.Payload, cancellationToken, item.Id);
        if (response.IsSuccessStatusCode || response.StatusCode == HttpStatusCode.Conflict)
            return;
        var body = await ErrorOf(response, cancellationToken);
        if (response.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.UnprocessableEntity)
            throw new LinkRefusedException($"Refused ({(int)response.StatusCode}): {body}");
        throw new LinkUnavailableException($"Not taken ({(int)response.StatusCode}){(body is null ? "" : $": {body}")}");
    }

    public async Task<IReadOnlyList<HrStaffMember>> HrStaffAsync(IntegrationLink link, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(link, HttpMethod.Get, "api/integrations/pos/staff", null, cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new LinkUnavailableException($"The HR system answered {(int)response.StatusCode}.");
        return await response.Content.ReadFromJsonAsync<List<HrStaffMember>>(Outbox.Json, cancellationToken) ?? [];
    }

    public async Task<CostingMenu> CostingMenuAsync(IntegrationLink link, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(link, HttpMethod.Get, "api/integrations/pos/menu", null, cancellationToken);
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new LinkRefusedException("The costing system refused the key: make a key on its Settings → POS Integration and paste it here.");
        if (!response.IsSuccessStatusCode)
            throw new LinkUnavailableException($"The costing system answered {(int)response.StatusCode}.");
        return await response.Content.ReadFromJsonAsync<CostingMenu>(Outbox.Json, cancellationToken)
            ?? throw new LinkUnavailableException("The costing system sent no menu.");
    }

    internal async Task<HttpResponseMessage> SendAsync(IntegrationLink link, HttpMethod method, string path, string? json, CancellationToken cancellationToken,
        Guid? idempotencyKey = null)
    {
        if (string.IsNullOrEmpty(link.BaseUrl))
            throw new LinkUnavailableException($"{link.System} has no address set.");
        using var request = new HttpRequestMessage(method, new Uri(new Uri(link.BaseUrl + "/"), path));
        if (json is not null)
            request.Content = new StringContent(json, Encoding.UTF8, "application/json");
        if (!string.IsNullOrEmpty(link.ApiKey))
        {
            request.Headers.Add("X-Api-Key", link.ApiKey);
            request.Headers.Add("X-Pos-Node-Key", link.ApiKey);
        }
        if (idempotencyKey is { } key)
            request.Headers.Add("Idempotency-Key", key.ToString());
        try
        {
            var response = await http.CreateClient(ClientName).SendAsync(request, cancellationToken);
            if ((int)response.StatusCode >= 500 || response.StatusCode == HttpStatusCode.RequestTimeout)
            {
                response.Dispose();
                throw new LinkUnavailableException($"{link.System} is not responding properly ({(int)response.StatusCode}).");
            }
            return response;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !cancellationToken.IsCancellationRequested)
        {
            throw new LinkUnavailableException($"{link.System} cannot be reached at {link.BaseUrl}.", ex);
        }
    }

    private static async Task<string?> ErrorOf(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        try
        {
            var text = await response.Content.ReadAsStringAsync(cancellationToken);
            return text.Length > 300 ? text[..300] : text;
        }
        catch (HttpRequestException)
        {
            return null;
        }
    }
}

// The online ordering & loyalty system's till endpoints, live (api/pos-sync): a customer by phone,
// their points, a redemption. Its link is read fresh each time, so a change in Settings counts at once.
internal sealed class LoyaltyGateway(IServiceScopeFactory scopes, LinkGateway links) : ILoyaltyGateway
{
    private sealed record Profile(string UserId, string? FullName, string? PhoneNumber, int PointsBalance);

    private sealed record Points(int Value);

    public bool IsEnabled => Link().IsReady;

    public async Task<LoyaltyCustomer?> FindByPhoneAsync(string phone, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(HttpMethod.Get, $"api/pos-sync/customers/by-phone/{Uri.EscapeDataString(phone)}", null, cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
            return null;
        Ensure(response);
        var profile = await response.Content.ReadFromJsonAsync<Profile>(Outbox.Json, cancellationToken);
        return profile is null ? null : new LoyaltyCustomer(profile.UserId, profile.FullName, profile.PhoneNumber, profile.PointsBalance, null);
    }

    public async Task<int> PointsAsync(string loyaltyUserId, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(HttpMethod.Get, $"api/pos-sync/customers/{Uri.EscapeDataString(loyaltyUserId)}/points", null, cancellationToken);
        Ensure(response);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(Outbox.Json, cancellationToken);
        return body.TryGetProperty("points", out var points) ? points.GetInt32() : 0;
    }

    public async Task RedeemAsync(string loyaltyUserId, int points, Guid orderId, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(HttpMethod.Post, "api/pos-sync/loyalty/redemptions",
            JsonSerializer.Serialize(new { customerUserId = loyaltyUserId, points, orderPublicId = orderId }, Outbox.Json), cancellationToken);
        Ensure(response);
    }

    private IntegrationLink Link()
    {
        using var scope = scopes.CreateScope();
        var store = scope.ServiceProvider.GetRequiredService<IIntegrationStore>();
        return store.GetAsync(LinkedSystem.Loyalty).GetAwaiter().GetResult();
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, string? json, CancellationToken cancellationToken)
    {
        var link = Link();
        if (!link.IsReady)
            throw new LinkUnavailableException("The loyalty system is not switched on.");
        return await links.SendAsync(link, method, path, json, cancellationToken);
    }

    private static void Ensure(HttpResponseMessage response)
    {
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new LinkUnavailableException("The loyalty system refused the API key.");
        if (!response.IsSuccessStatusCode)
            throw new LinkUnavailableException($"The loyalty system answered {(int)response.StatusCode}.");
    }
}

// How the sending went last, for the header's light; and a nudge to send now.
internal sealed class SyncHealth : ISyncHealth
{
    private readonly SemaphoreSlim _wake = new(0);

    public bool LastSendFailed { get; set; }

    public DateTime? LastSentAtUtc { get; set; }

    public void Wake()
    {
        if (_wake.CurrentCount == 0)
            _wake.Release();
    }

    public Task WaitAsync(TimeSpan timeout, CancellationToken cancellationToken) => _wake.WaitAsync(timeout, cancellationToken);
}

// Sends the sync queue to the linked systems, oldest first, every few seconds or when nudged: a
// system switched off keeps its items waiting; one not reachable has them tried again later, a little
// later each time; one refusing an item has it failed, to be looked at and sent again by hand.
internal sealed class OutboxSender(IServiceScopeFactory scopes, SyncHealth health, ILogger<OutboxSender> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await SendDueAsync(stoppingToken);
            }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
            {
                logger.LogError(ex, "The sync queue could not be worked");
            }

            try
            {
                await health.WaitAsync(TimeSpan.FromSeconds(10), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private async Task SendDueAsync(CancellationToken cancellationToken)
    {
        await using var scope = scopes.CreateAsyncScope();
        var queue = scope.ServiceProvider.GetRequiredService<ISyncQueue>();
        var links = scope.ServiceProvider.GetRequiredService<IIntegrationStore>();
        var gateway = scope.ServiceProvider.GetRequiredService<ILinkGateway>();
        var db = scope.ServiceProvider.GetRequiredService<PosDbContext>();
        var notifier = scope.ServiceProvider.GetRequiredService<IPosNotifier>();

        var due = await queue.GetDueAsync(50, cancellationToken);
        if (due.Count == 0)
            return;
        var byLink = (await links.GetAllAsync(cancellationToken)).ToDictionary(l => l.System);
        var down = new HashSet<LinkedSystem>();
        var changed = false;
        foreach (var item in due)
        {
            var link = byLink[item.System];
            if (!link.IsReady || down.Contains(item.System))
                continue;
            try
            {
                await gateway.SendAsync(link, item, cancellationToken);
                item.Delivered();
                health.LastSendFailed = false;
                health.LastSentAtUtc = DateTime.UtcNow;
            }
            catch (LinkUnavailableException ex)
            {
                item.NotDelivered(ex.Message, failed: false);
                // The rest of its items wait their turn behind it: their order is kept.
                down.Add(item.System);
                health.LastSendFailed = true;
            }
            catch (LinkRefusedException ex)
            {
                item.NotDelivered(ex.Message, failed: true);
                logger.LogWarning("Sync item {Item} ({Kind}) refused by {System}: {Error}", item.Id, item.Kind, item.System, ex.Message);
            }
            changed = true;
        }
        if (changed)
        {
            await db.SaveChangesAsync(cancellationToken);
            await notifier.SyncChangedAsync(cancellationToken);
        }
    }
}

using Microsoft.AspNetCore.SignalR;
using Pos.Application.Common;

namespace Pos.Api.Hubs;

// The live line to every terminal, captain's phone and kitchen screen (/hubs/pos): whoever is
// signed in hears what changed and reloads what it shows of it. Nothing is sent to the hub; it only
// tells.
public sealed class PosHub : Hub
{
    public const string Path = "/hubs/pos";
}

// What changed, said on the hub. Messages: OrdersChanged(ids), FloorChanged, KitchenChanged,
// ShiftChanged, SyncChanged, MenuChanged, PrintRequested(job).
internal sealed class SignalRNotifier(IHubContext<PosHub> hub) : IPosNotifier
{
    public Task OrdersChangedAsync(IReadOnlyCollection<Guid> orderIds, CancellationToken cancellationToken = default) =>
        hub.Clients.All.SendAsync("OrdersChanged", orderIds, cancellationToken);

    public Task FloorChangedAsync(CancellationToken cancellationToken = default) => hub.Clients.All.SendAsync("FloorChanged", cancellationToken);

    public Task KitchenChangedAsync(CancellationToken cancellationToken = default) => hub.Clients.All.SendAsync("KitchenChanged", cancellationToken);

    public Task ShiftChangedAsync(CancellationToken cancellationToken = default) => hub.Clients.All.SendAsync("ShiftChanged", cancellationToken);

    public Task SyncChangedAsync(CancellationToken cancellationToken = default) => hub.Clients.All.SendAsync("SyncChanged", cancellationToken);

    public Task MenuChangedAsync(CancellationToken cancellationToken = default) => hub.Clients.All.SendAsync("MenuChanged", cancellationToken);

    public Task PrintRequestedAsync(BrowserPrintJob job, CancellationToken cancellationToken = default) =>
        hub.Clients.All.SendAsync("PrintRequested", job, cancellationToken);
}

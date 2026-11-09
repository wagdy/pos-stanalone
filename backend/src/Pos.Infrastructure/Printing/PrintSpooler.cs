using System.Net.Sockets;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Pos.Application.Common;
using Pos.Domain.Printing;
using Pos.Infrastructure.Persistence;

namespace Pos.Infrastructure.Printing;

// Where each document goes: the printer asked for, else the cashier's (the first active cashier
// printer). A network printer is sent ESC/POS through the print queue; a browser printer, or no
// printer at all, asks the terminals to print it themselves.
internal sealed class PrintSpooler(PosDbContext db, Receipts receipts, IPosNotifier notifier, PrintSignal signal, ILogger<PrintSpooler> logger)
    : IPrintSpooler
{
    public async Task PrintAsync(IReadOnlyList<PrintRequest> requests, CancellationToken cancellationToken = default)
    {
        var printers = await db.Printers.AsNoTracking().Where(p => p.IsActive).ToListAsync(cancellationToken);
        var queued = false;
        foreach (var request in requests)
        {
            var printer = request.PrinterId is { } id
                ? printers.FirstOrDefault(p => p.Id == id)
                : printers.Where(p => p.Role == PrinterRole.Cashier).OrderBy(p => p.Name).FirstOrDefault();
            if (printer is { Connection: PrinterConnection.Network, Host: { } host })
            {
                try
                {
                    var (title, bytes) = await receipts.RenderAsync(request, printer.CharactersPerLine, printer.Name, cancellationToken);
                    db.PrintJobs.Add(new PrintJob(Guid.NewGuid(), request.Kind, request.SubjectId, printer.Id, printer.Name, host, printer.Port, title, bytes));
                    queued = true;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogError(ex, "Could not render {Kind} {Subject} for {Printer}", request.Kind, request.SubjectId, printer.Name);
                }
            }
            else
            {
                await notifier.PrintRequestedAsync(
                    new BrowserPrintJob(Guid.NewGuid(), request.Kind, request.SubjectId, printer?.Id, printer?.Name, request.StationId), cancellationToken);
            }
        }
        if (queued)
        {
            await db.SaveChangesAsync(cancellationToken);
            signal.Wake();
        }
    }
}

// Wakes the print worker at once rather than at its next turn.
public sealed class PrintSignal
{
    private readonly SemaphoreSlim _wake = new(0);

    public void Wake()
    {
        if (_wake.CurrentCount == 0)
            _wake.Release();
    }

    public Task WaitAsync(TimeSpan timeout, CancellationToken cancellationToken) => _wake.WaitAsync(timeout, cancellationToken);
}

// Sends the print queue to the network printers: each job's bytes to its printer's raw port, tried
// again a few times when the printer does not answer, then left failed to print again from Settings.
internal sealed class PrintWorker(IServiceScopeFactory scopes, PrintSignal signal, ILogger<PrintWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                var db = scope.ServiceProvider.GetRequiredService<PosDbContext>();
                var now = DateTime.UtcNow;
                var due = await db.PrintJobs.Where(j => j.Status == PrintJobStatus.Pending && j.NextAttemptAtUtc <= now)
                    .OrderBy(j => j.CreatedAtUtc).Take(20).ToListAsync(stoppingToken);
                foreach (var job in due)
                {
                    try
                    {
                        await SendAsync(job.Host, job.Port, job.Payload, stoppingToken);
                        job.Printed();
                    }
                    catch (Exception ex) when (ex is SocketException or IOException or TimeoutException or OperationCanceledException && !stoppingToken.IsCancellationRequested)
                    {
                        job.NotPrinted(ex.Message);
                        logger.LogWarning("Print job {Job} to {Printer} not printed: {Error}", job.Id, job.PrinterName, ex.Message);
                    }
                }
                if (due.Count > 0)
                    await db.SaveChangesAsync(stoppingToken);
            }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
            {
                logger.LogError(ex, "The print queue could not be worked");
            }

            try
            {
                await signal.WaitAsync(TimeSpan.FromSeconds(3), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    public static async Task SendAsync(string host, int port, byte[] payload, CancellationToken cancellationToken)
    {
        using var client = new TcpClient();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(5));
        await client.ConnectAsync(host, port, timeout.Token);
        await using var stream = client.GetStream();
        await stream.WriteAsync(payload, timeout.Token);
        await stream.FlushAsync(timeout.Token);
    }
}

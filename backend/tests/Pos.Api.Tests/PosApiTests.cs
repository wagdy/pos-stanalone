using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using ClosedXML.Excel;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using Pos.Domain.Access;

namespace Pos.Api.Tests;

// The till over HTTP, as the terminals, the captains' phones and the kitchen screens use it: on its
// own PostgreSQL database, with a network thermal printer and a linked system played by listeners
// on this machine.
public class PosApiTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static async Task<JsonElement> Json(HttpResponseMessage response)
    {
        Assert.True(response.IsSuccessStatusCode, $"{(int)response.StatusCode}: {await response.Content.ReadAsStringAsync(Cancel)}");
        return await response.Content.ReadFromJsonAsync<JsonElement>(Cancel);
    }

    private sealed record Restaurant(JsonElement Menu, JsonElement Floor)
    {
        public JsonElement Item(int code) => Menu.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("code").GetInt32() == code);

        public Guid Table(string label) =>
            Floor.GetProperty("tables").EnumerateArray().Single(t => t.GetProperty("label").GetString() == label).GetProperty("id").GetGuid();

        public Guid Station(string name) =>
            Menu.GetProperty("stations").EnumerateArray().Single(s => s.GetProperty("name").GetString() == name).GetProperty("id").GetGuid();
    }

    private static async Task<Restaurant> SampleAsync(HttpClient manager)
    {
        Assert.Equal(HttpStatusCode.NoContent, (await manager.PostAsync("/api/setup/sample", null, Cancel)).StatusCode);
        return new Restaurant(await Json(await manager.GetAsync("/api/menu", Cancel)), await Json(await manager.GetAsync("/api/floor", Cancel)));
    }

    private static object Line(JsonElement item, int quantity, string? size = null) => new
    {
        lineId = Guid.NewGuid(),
        menuItemId = item.GetProperty("id").GetGuid(),
        sizeId = size is null ? (Guid?)null
            : item.GetProperty("sizes").EnumerateArray().Single(s => s.GetProperty("name").GetString() == size).GetProperty("id").GetGuid(),
        quantity,
    };

    [Fact]
    public async Task Each_role_signs_in_with_its_pin_and_does_its_own_work_only()
    {
        await using var api = await TestApi.StartAsync();
        var boss = await api.PinAsync(TestApi.BossPin);
        var r = await SampleAsync(boss);
        var captain = await api.StaffAsync(boss, "Ali", UserRole.Captain, "3333");
        var kitchen = await api.StaffAsync(boss, "Chef", UserRole.Kitchen, "4444");
        var cashier = await api.StaffAsync(boss, "Mona", UserRole.Cashier, "2222");

        Assert.Equal(HttpStatusCode.Unauthorized, (await api.Anonymous().PostAsJsonAsync("/api/auth/pin", new { pin = "9999" }, Cancel)).StatusCode);
        var taken = await boss.PostAsJsonAsync("/api/users", new { fullName = "Copy", role = "Captain", pin = "3333" }, Cancel);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, taken.StatusCode);
        var me = await Json(await captain.GetAsync("/api/auth/me", Cancel));
        Assert.Equal(["orders.take"], me.GetProperty("permissions").EnumerateArray().Select(p => p.GetString()));

        // The captain opens a table, takes the order and sends it; the floor shows it taken.
        var order = Guid.NewGuid();
        await Json(await captain.PostAsJsonAsync("/api/orders", new { orderId = order, type = "DineIn", tableId = r.Table("5"), guests = 4 }, Cancel));
        var sent = await Json(await captain.PostAsJsonAsync($"/api/orders/{order}/items",
            new { items = new[] { Line(r.Item(7001), 2), Line(r.Item(9001), 2) }, sendToKitchen = true }, Cancel));
        Assert.All(sent.GetProperty("lines").EnumerateArray(), l => Assert.Equal("Sent", l.GetProperty("status").GetString()));
        var floor = await Json(await captain.GetAsync("/api/floor", Cancel));
        Assert.Equal("Occupied", floor.GetProperty("tables").EnumerateArray().Single(t => t.GetProperty("label").GetString() == "5").GetProperty("state").GetString());

        // Not the captain's: paying, the shift, the setup. Not the kitchen's: taking orders.
        Assert.Equal(HttpStatusCode.Forbidden, (await captain.PostAsJsonAsync($"/api/orders/{order}/pay", new { payments = Array.Empty<object>() }, Cancel)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await captain.PostAsJsonAsync("/api/shifts", new { shiftId = Guid.NewGuid(), openingFloat = 0 }, Cancel)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await cashier.PostAsync("/api/setup/sample", null, Cancel)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await kitchen.PostAsJsonAsync("/api/orders", new { orderId = Guid.NewGuid(), type = "Takeaway", guests = 0 }, Cancel)).StatusCode);
        var board = await Json(await kitchen.GetAsync($"/api/kitchen?stationId={r.Station("Grill")}", Cancel));
        Assert.Equal("Classic burger", board.GetProperty("active")[0].GetProperty("lines").EnumerateArray()
            .Single(l => l.GetProperty("stationName").GetString() == "Grill").GetProperty("name").GetString());

        // A void after the kitchen: the captain needs a manager's PIN.
        var burgerLine = sent.GetProperty("lines").EnumerateArray().First().GetProperty("id").GetGuid();
        var voiding = new { items = new[] { new { voidId = Guid.NewGuid(), lineId = burgerLine, quantity = 1 } }, reason = "Late · تأخير", outcome = "Waste" };
        Assert.Equal(HttpStatusCode.Forbidden, (await captain.PostAsJsonAsync($"/api/orders/{order}/voids", voiding, Cancel)).StatusCode);
        var voided = await Json(await captain.PostAsJsonAsync($"/api/orders/{order}/voids", new { voiding.items, voiding.reason, voiding.outcome, managerPin = "1234" }, Cancel));
        Assert.Equal("Boss", voided.GetProperty("voids")[0].GetProperty("authorizedBy").GetString());
    }

    [Fact]
    public async Task A_station_with_a_network_printer_gets_its_kitchen_ticket_as_escpos()
    {
        await using var api = await TestApi.StartAsync();
        var boss = await api.PinAsync(TestApi.BossPin);
        var r = await SampleAsync(boss);

        // The grill's thermal printer: a listener on this machine's raw port.
        var printer = new TcpListener(IPAddress.Loopback, 0);
        printer.Start();
        var port = ((IPEndPoint)printer.LocalEndpoint).Port;
        var printerId = Guid.NewGuid();
        Assert.True((await boss.PutAsJsonAsync($"/api/setup/printers/{printerId}",
            new { name = "Grill printer", connection = "Network", role = "Kitchen", host = "127.0.0.1", port, charactersPerLine = 48 }, Cancel)).IsSuccessStatusCode);
        var grill = r.Menu.GetProperty("stations").EnumerateArray().Single(s => s.GetProperty("name").GetString() == "Grill");
        await Json(await boss.PutAsJsonAsync($"/api/menu/stations/{grill.GetProperty("id").GetGuid()}",
            new { name = "Grill", nameAr = "مشويات", sortOrder = 1, printerId }, Cancel));

        var order = Guid.NewGuid();
        await Json(await boss.PostAsJsonAsync("/api/orders", new { orderId = order, type = "DineIn", tableId = r.Table("3"), guests = 2 }, Cancel));
        var receiving = ReceiveAsync(printer);
        await Json(await boss.PostAsJsonAsync($"/api/orders/{order}/items", new { items = new[] { Line(r.Item(7001), 2) }, sendToKitchen = true }, Cancel));

        var ticket = await receiving.WaitAsync(TimeSpan.FromSeconds(15), Cancel);
        var text = Encoding.Latin1.GetString(ticket);
        Assert.StartsWith("\u001b@", text);
        Assert.Contains("KOT 1  GRILL", text);
        Assert.Contains("TABLE 3", text);
        Assert.Contains("2 x Classic burger", text);
        Assert.Contains("\u001dVB", text);
        printer.Stop();
    }

    private static async Task<byte[]> ReceiveAsync(TcpListener listener)
    {
        using var client = await listener.AcceptTcpClientAsync();
        using var buffer = new MemoryStream();
        await client.GetStream().CopyToAsync(buffer);
        return buffer.ToArray();
    }

    [Fact]
    public async Task A_shift_is_closed_its_day_sent_to_costing_by_the_outbox_and_given_as_costings_sheet()
    {
        // Costing, played by a listener: it takes the POS's events and answers its ping.
        var costing = new HttpListener();
        var costingPort = FreePort();
        costing.Prefixes.Add($"http://localhost:{costingPort}/");
        costing.Start();
        var received = new List<(string Path, string? Key, string Body)>();
        _ = Task.Run(async () =>
        {
            while (costing.IsListening)
            {
                HttpListenerContext context;
                try
                {
                    context = await costing.GetContextAsync();
                }
                catch (Exception)
                {
                    return;
                }
                using var reader = new StreamReader(context.Request.InputStream);
                lock (received)
                    received.Add((context.Request.Url!.AbsolutePath, context.Request.Headers["X-Api-Key"], reader.ReadToEnd()));
                context.Response.StatusCode = 200;
                context.Response.Close();
            }
        }, Cancel);

        await using var api = await TestApi.StartAsync();
        var boss = await api.PinAsync(TestApi.BossPin);
        var r = await SampleAsync(boss);
        var link = await Json(await boss.PutAsJsonAsync("/api/integrations/links/Costing",
            new { enabled = true, baseUrl = $"http://localhost:{costingPort}", apiKey = "secret-key-1", branchCode = "MAADI" }, Cancel));
        Assert.Equal(("••••ey-1", true), (link.GetProperty("apiKeyHint").GetString(), link.GetProperty("hasApiKey").GetBoolean()));
        var tested = await Json(await boss.PostAsync("/api/integrations/links/Costing/test", null, Cancel));
        Assert.True(tested.GetProperty("lastTestOk").GetBoolean());

        var shift = Guid.NewGuid();
        await Json(await boss.PostAsJsonAsync("/api/shifts", new { shiftId = shift, openingFloat = 300 }, Cancel));
        var order = Guid.NewGuid();
        await Json(await boss.PostAsJsonAsync("/api/orders", new { orderId = order, type = "Takeaway", guests = 0 }, Cancel));
        var check = await Json(await boss.PostAsJsonAsync($"/api/orders/{order}/items", new { items = new[] { Line(r.Item(6101), 1, "Large"), Line(r.Item(9003), 2) } }, Cancel));
        var due = check.GetProperty("totals").GetProperty("total").GetDecimal();
        // (190 + 60) + 14% tax.
        Assert.Equal(285m, due);
        var paid = await Json(await boss.PostAsJsonAsync($"/api/orders/{order}/pay",
            new { payments = new[] { new { paymentId = Guid.NewGuid(), method = "Cash", amount = due, tendered = 300 } }, printReceipt = false }, Cancel));
        Assert.Equal(("Paid", 15m), (paid.GetProperty("status").GetString(), paid.GetProperty("payments")[0].GetProperty("change").GetDecimal()));

        var z = await Json(await boss.PostAsJsonAsync($"/api/shifts/{shift}/close", new { countedCash = 585, print = false }, Cancel));
        Assert.Equal((285m, 35m, 0m), (z.GetProperty("cashSales").GetDecimal(), z.GetProperty("tax").GetDecimal(), z.GetProperty("variance").GetDecimal()));

        Assert.True(await TestApi.WaitFor(() => Task.FromResult(received.Any(e => e.Path.EndsWith("/events")))), "Costing was never sent the day.");
        var sentDay = received.First(e => e.Path.EndsWith("/events"));
        Assert.Equal("secret-key-1", sentDay.Key);
        var envelope = JsonDocument.Parse(sentDay.Body).RootElement;
        Assert.Equal(("day.closed", "MAADI"), (envelope.GetProperty("kind").GetString(), envelope.GetProperty("branchCode").GetString()));
        Assert.Equal(2, envelope.GetProperty("data").GetProperty("soldItems").GetArrayLength());
        Assert.True(await TestApi.WaitFor(async () => (await Json(await boss.GetAsync("/api/integrations/sync", Cancel))).GetProperty("pending").GetInt32() == 0));

        var sheet = await boss.GetAsync($"/api/integrations/costing/sheet?date={z.GetProperty("businessDate").GetString()}", Cancel);
        Assert.Equal("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sheet.Content.Headers.ContentType!.MediaType);
        using var book = new XLWorkbook(await sheet.Content.ReadAsStreamAsync(Cancel));
        var sales = book.Worksheet("Daily Sales");
        Assert.Equal(("Item · الصنف", "Quantity Sold · الكمية المباعة"), (sales.Cell(1, 1).GetString(), sales.Cell(1, 2).GetString()));
        Assert.Equal(("6101 · Margherita (Large)", 1d), (sales.Cell(2, 1).GetString(), sales.Cell(2, 2).GetDouble()));
        Assert.Equal(("9003 · Soft drink", 2d), (sales.Cell(3, 1).GetString(), sales.Cell(3, 2).GetDouble()));
        costing.Stop();
    }

    [Fact]
    public async Task Every_screen_hears_at_once_when_a_check_changes()
    {
        await using var api = await TestApi.StartAsync();
        var boss = await api.PinAsync(TestApi.BossPin);
        var r = await SampleAsync(boss);

        var heard = new TaskCompletionSource<Guid[]>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var hub = new HubConnectionBuilder()
            .WithUrl(new Uri(api.Factory.Server.BaseAddress, "hubs/pos"), o =>
            {
                o.HttpMessageHandlerFactory = _ => api.Factory.Server.CreateHandler();
                o.Transports = HttpTransportType.LongPolling;
                o.AccessTokenProvider = () => Task.FromResult<string?>(api.Tokens[boss]);
            })
            .Build();
        hub.On<Guid[]>("OrdersChanged", ids => heard.TrySetResult(ids));
        await hub.StartAsync(Cancel);

        var order = Guid.NewGuid();
        await Json(await boss.PostAsJsonAsync("/api/orders", new { orderId = order, type = "DineIn", tableId = r.Table("7"), guests = 2 }, Cancel));
        Assert.Contains(order, await heard.Task.WaitAsync(TimeSpan.FromSeconds(10), Cancel));
    }

    private static int FreePort()
    {
        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        return port;
    }
}

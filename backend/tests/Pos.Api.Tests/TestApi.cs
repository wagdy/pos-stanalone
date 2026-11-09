using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Pos.Api.Controllers;
using Pos.Domain.Access;
using Pos.Infrastructure.Persistence;

// How money is written is the process's own (CompanyMoney: one company per deployment), and each
// test's API sets it as it starts: the tests run one at a time, so none reads another's currency.
[assembly: Xunit.v3.Parallelization(Mode = Xunit.Sdk.ParallelMode.None)]

namespace Pos.Api.Tests;

// The API exactly as Program.cs builds it, in process, on its own database. On start it has
// migrated and created the first manager, "Boss".
public sealed class TestApi : IAsyncDisposable
{
    public const string BossEmail = "boss@example.com", BossPassword = "boss-password";
    public const string BossPin = "1234";

    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

    private WebApplicationFactory<Program> _factory = null!;
    private string _connectionString = null!;

    public static string? DatabaseServer => Environment.GetEnvironmentVariable("POS_TEST_DB");

    public IServiceProvider Services => _factory.Services;

    // `settings`: more of the API's settings, for a test that needs one.
    public static Task<TestApi> StartAsync(IReadOnlyDictionary<string, string>? settings = null)
    {
        if (DatabaseServer is null)
            Assert.Skip("Set POS_TEST_DB to a PostgreSQL 15+ connection string (without Database=) to run the API tests.");

        var api = new TestApi { _connectionString = $"{DatabaseServer};Database=pos_api_test_{Guid.NewGuid():N}" };

        // UseSetting, not ConfigureAppConfiguration: Program reads the connection string and the
        // signing key while building, before anything added later would be seen. "Testing", so
        // appsettings.Development.json and its database stay out of it.
        api._factory = new WebApplicationFactory<Program>().WithWebHostBuilder(web =>
        {
            web.UseEnvironment("Testing");
            web.UseSetting($"ConnectionStrings:{Pos.Infrastructure.DependencyInjection.ConnectionStringName}", api._connectionString);
            // Never a hosting platform's database, whatever this machine's environment says.
            web.UseSetting(Pos.Infrastructure.Persistence.DatabaseConnection.UrlVariable, string.Empty);
            web.UseSetting("Auth:SigningKey", "test-only-signing-key-0123456789-0123456789");
            web.UseSetting("Auth:FirstManager:Email", BossEmail);
            web.UseSetting("Auth:FirstManager:Name", "Boss");
            web.UseSetting("Auth:FirstManager:Password", BossPassword);
            web.UseSetting("Auth:FirstManager:Pin", BossPin);
            foreach (var (key, value) in settings ?? new Dictionary<string, string>())
                web.UseSetting(key, value);
            web.ConfigureLogging(logging => logging.ClearProviders());
        });

        // Starts the host: migration, then the first manager.
        _ = api._factory.Server;
        return Task.FromResult(api);
    }

    public HttpClient Anonymous() => _factory.CreateClient();

    public HttpClient Anonymous(WebApplicationFactoryClientOptions options) => _factory.CreateClient(options);

    public async Task<HttpClient> SignInAsync(string email, string password)
    {
        var client = _factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/auth/sign-in", new SignInRequest(email, password));
        Assert.True(response.IsSuccessStatusCode, $"Sign-in as {email} failed: {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        var signedIn = (await response.Content.ReadFromJsonAsync<SignInResponse>(Json))!;
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", signedIn.Token);
        Tokens[client] = signedIn.Token;
        return client;
    }

    public Task<HttpClient> ManagerAsync() => SignInAsync(BossEmail, BossPassword);

    // A member of staff of the role with their PIN, added by the manager, signed in at a terminal.
    public async Task<HttpClient> StaffAsync(HttpClient manager, string name, UserRole role, string pin)
    {
        var response = await manager.PostAsJsonAsync("/api/users", new CreateUserRequest(null, name, role, null, pin), Json);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        return await PinAsync(pin);
    }

    public async Task<HttpClient> PinAsync(string pin)
    {
        var client = _factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/auth/pin", new PinSignInRequest(pin));
        Assert.True(response.IsSuccessStatusCode, $"PIN sign-in failed: {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        var signedIn = (await response.Content.ReadFromJsonAsync<SignInResponse>(Json))!;
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", signedIn.Token);
        Tokens[client] = signedIn.Token;
        return client;
    }

    // Each client's token, for the live hub.
    public Dictionary<HttpClient, string> Tokens { get; } = [];

    public WebApplicationFactory<Program> Factory => _factory;

    public async Task<T> Db<T>(Func<PosDbContext, Task<T>> query)
    {
        await using var scope = Services.CreateAsyncScope();
        return await query(scope.ServiceProvider.GetRequiredService<PosDbContext>());
    }

    // On the Stopwatch, which a laptop's sleep does not move.
    public static async Task<bool> WaitFor(Func<Task<bool>> condition, int seconds = 15)
    {
        var waited = Stopwatch.StartNew();
        while (waited.Elapsed < TimeSpan.FromSeconds(seconds))
        {
            if (await condition())
                return true;
            await Task.Delay(100);
        }
        return false;
    }

    public async ValueTask DisposeAsync()
    {
        await _factory.DisposeAsync();

        var options = new DbContextOptionsBuilder<PosDbContext>().UseNpgsql(_connectionString).Options;
        await using var db = new PosDbContext(options);
        await db.Database.EnsureDeletedAsync();
    }
}

public static class HttpAssertions
{
    // What the app would show: errors[0] of the ProblemDetails.
    public static async Task<string?> ErrorOf(HttpResponseMessage response)
    {
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.TryGetProperty("errors", out var errors) && errors.ValueKind == JsonValueKind.Array
            ? errors[0].GetString()
            : null;
    }
}

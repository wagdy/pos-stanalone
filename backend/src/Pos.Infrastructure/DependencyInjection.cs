using MediatR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Pos.Application.Common;
using Pos.Application.Integrations;
using Pos.Domain.Catalog;
using Pos.Domain.Common;
using Pos.Domain.Company;
using Pos.Domain.Customers;
using Pos.Domain.Floor;
using Pos.Domain.Integrations;
using Pos.Domain.Kitchen;
using Pos.Domain.Orders;
using Pos.Domain.Printing;
using Pos.Domain.Settings;
using Pos.Domain.Shifts;
using Pos.Infrastructure.Common;
using Pos.Infrastructure.Identity;
using Pos.Infrastructure.Integrations;
using Pos.Infrastructure.Persistence;
using Pos.Infrastructure.Printing;
using Pos.Infrastructure.Setup;

namespace Pos.Infrastructure;

public static class DependencyInjection
{
    public const string ConnectionStringName = "Pos";

    // Every port of the application, except the live notifications, which come from the API's hub.
    public static IServiceCollection AddPosInfrastructure(this IServiceCollection services, IConfiguration configuration)
    {
        // DATABASE_URL first (a hosting platform's), else ConnectionStrings:Pos.
        var connectionString = DatabaseConnection.Resolve(configuration);

        services.Configure<CompanyOptions>(configuration.GetSection(CompanyOptions.Section));
        services.AddSingleton<ICompanyProfile, CompanyProfileStore>();
        services.AddSingleton<BusinessCalendar>();
        services.AddSingleton<IBusinessCalendar>(sp => sp.GetRequiredService<BusinessCalendar>());
        services.TryAddSingleton(TimeProvider.System);

        services.AddDbContext<PosDbContext>(o => o.UseNpgsql(connectionString, PosDbContext.ConfigureNpgsql));
        services.AddScoped<IUnitOfWork>(sp => sp.GetRequiredService<PosDbContext>());
        services.AddTransient(typeof(IPipelineBehavior<,>), typeof(RetryOnConflictBehavior<,>));

        services.AddScoped<ICompanySettingsStore, Company.CompanySettingsStore>();
        services.AddScoped<IPosSettingsStore, PosSettingsStore>();

        // The menu, the floor, the checks and the kitchen.
        services.AddScoped<IKitchenStationRepository, KitchenStationRepository>();
        services.AddScoped<IMenuCategoryRepository, MenuCategoryRepository>();
        services.AddScoped<IMenuItemRepository, MenuItemRepository>();
        services.AddScoped<IDiningZoneRepository, DiningZoneRepository>();
        services.AddScoped<IDiningTableRepository, DiningTableRepository>();
        services.AddScoped<IOrderRepository, OrderRepository>();
        services.AddScoped<IKitchenTicketRepository, KitchenTicketRepository>();
        services.AddScoped<ICustomerRepository, CustomerRepository>();
        services.AddScoped<IShiftRepository, ShiftRepository>();
        services.AddScoped<IClockEventRepository, ClockEventRepository>();

        // Printing: the printers, the documents, the queue to the network printers.
        services.AddScoped<IPrinterRepository, PrinterRepository>();
        services.AddScoped<Receipts>();
        services.AddScoped<IPrintSpooler, PrintSpooler>();
        services.AddSingleton<PrintSignal>();
        services.AddHostedService<PrintWorker>();

        // The linked systems and what is queued for them.
        services.AddScoped<IIntegrationStore, IntegrationStore>();
        services.AddScoped<ISyncQueue, SyncQueue>();
        services.AddHttpClient(LinkGateway.ClientName, c => c.Timeout = TimeSpan.FromSeconds(8));
        services.AddScoped<LinkGateway>();
        services.AddScoped<ILinkGateway>(sp => sp.GetRequiredService<LinkGateway>());
        services.AddScoped<ILoyaltyGateway, LoyaltyGateway>();
        services.AddSingleton<SyncHealth>();
        services.AddSingleton<ISyncHealth>(sp => sp.GetRequiredService<SyncHealth>());
        services.AddHostedService<OutboxSender>();

        // The system's users, and who a PIN belongs to.
        var pinKey = configuration["Auth:PinKey"] is { Length: > 0 } key ? key : configuration["Auth:SigningKey"] ?? "pos-pin-key";
        services.AddSingleton(new PinHasher(pinKey));
        services.AddScoped<UserDirectory>();
        services.AddScoped<IStaffDirectory>(sp => sp.GetRequiredService<UserDirectory>());

        services.AddScoped<SampleRestaurant>();

        return services;
    }
}

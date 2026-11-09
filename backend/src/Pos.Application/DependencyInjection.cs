using Microsoft.Extensions.DependencyInjection;

namespace Pos.Application;

public static class DependencyInjection
{
    // Infrastructure supplies the repositories, the unit of work, the clock and the gateways.
    public static IServiceCollection AddPosApplication(this IServiceCollection services)
    {
        services.AddMediatR(config => config.RegisterServicesFromAssembly(typeof(DependencyInjection).Assembly));
        services.AddScoped<Integrations.Outbox>();
        services.AddScoped<Orders.KitchenDesk>();
        services.AddScoped<Orders.ManagerAuthority>();
        services.AddScoped<Orders.OrderReader>();
        services.AddScoped<Orders.OrderDesk>();
        services.AddScoped<Customers.LoyaltyLookup>();
        services.AddScoped<Shifts.ZReportBuilder>();
        return services;
    }
}

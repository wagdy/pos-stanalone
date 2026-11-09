using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Pos.Infrastructure.Persistence;

// Used only by `dotnet ef`, so migrations can be added before the API exists:
//   dotnet ef migrations add <Name> --project backend/src/Pos.Infrastructure --startup-project backend/src/Pos.Infrastructure --output-dir Persistence/Migrations
// Adding a migration never connects to the database. Applying one reads the connection string
// from COSTING_CONNECTION.
internal sealed class PosDbContextFactory : IDesignTimeDbContextFactory<PosDbContext>
{
    public PosDbContext CreateDbContext(string[] args)
    {
        var connectionString = Environment.GetEnvironmentVariable("COSTING_CONNECTION")
            ?? "Host=localhost;Port=5437;Database=pos_standalone;Username=pos;Password=pos-dev";

        return new PosDbContext(new DbContextOptionsBuilder<PosDbContext>().UseNpgsql(connectionString, PosDbContext.ConfigureNpgsql).Options);
    }
}

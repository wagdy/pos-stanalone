using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using Npgsql.EntityFrameworkCore.PostgreSQL.Infrastructure;
using Pos.Domain.Catalog;
using Pos.Domain.Common;
using Pos.Domain.Customers;
using Pos.Domain.Floor;
using Pos.Domain.Integrations;
using Pos.Domain.Kitchen;
using Pos.Domain.Orders;
using Pos.Domain.Printing;
using Pos.Domain.Settings;
using Pos.Domain.Shifts;
using Pos.Infrastructure.Identity;
using Pos.Infrastructure.Printing;

namespace Pos.Infrastructure.Persistence;

// The restaurant's database (pos_standalone): the menu and its stations, the floor, the checks and
// their kitchen tickets, customers, shifts, printers and their queue, the links to the other systems
// and what is owed them, and the system's users.
public sealed class PosDbContext(DbContextOptions<PosDbContext> options) : DbContext(options), IUnitOfWork
{
    // Everything in one schema; the system's users apart.
    public const string PosSchema = "pos";
    public const string IdentitySchema = "identity";

    // The app's and the design-time tools' own setup. The history of migrations is kept in the pos
    // schema by name, so a database user named after the schema never finds none and applies them
    // all again.
    public static void ConfigureNpgsql(NpgsqlDbContextOptionsBuilder npgsql) => npgsql
        .UseQuerySplittingBehavior(QuerySplittingBehavior.SplitQuery)
        .MigrationsHistoryTable(HistoryRepository.DefaultTableName, PosSchema);

    public DbSet<KitchenStation> KitchenStations => Set<KitchenStation>();
    public DbSet<MenuCategory> MenuCategories => Set<MenuCategory>();
    public DbSet<MenuItem> MenuItems => Set<MenuItem>();
    public DbSet<DiningZone> DiningZones => Set<DiningZone>();
    public DbSet<DiningTable> DiningTables => Set<DiningTable>();
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<KitchenTicket> KitchenTickets => Set<KitchenTicket>();
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<Shift> Shifts => Set<Shift>();
    public DbSet<ClockEvent> ClockEvents => Set<ClockEvent>();
    public DbSet<PosSettings> PosSettings => Set<PosSettings>();
    public DbSet<Printer> Printers => Set<Printer>();
    public DbSet<PrintJob> PrintJobs => Set<PrintJob>();
    public DbSet<IntegrationLink> IntegrationLinks => Set<IntegrationLink>();
    public DbSet<SyncItem> SyncQueue => Set<SyncItem>();

    public DbSet<Domain.Company.CompanySettings> CompanySettings => Set<Domain.Company.CompanySettings>();
    public DbSet<Company.CompanyLogo> CompanyLogos => Set<Company.CompanyLogo>();

    public DbSet<UserAccount> Users => Set<UserAccount>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(PosDbContext).Assembly);

        // The domain's aggregates: ids generated in the domain, domain events never stored, and
        // optimistic concurrency on PostgreSQL's xmin.
        foreach (var entityType in modelBuilder.Model.GetEntityTypes().Where(t => typeof(Entity).IsAssignableFrom(t.ClrType)))
        {
            var entity = modelBuilder.Entity(entityType.ClrType);
            entity.Property(nameof(Entity.Id)).ValueGeneratedNever();

            if (typeof(AggregateRoot).IsAssignableFrom(entityType.ClrType))
            {
                entity.Ignore(nameof(AggregateRoot.DomainEvents));
                entity.Property<uint>("Version").IsRowVersion();
            }
        }
    }

    // Money, to two decimal places.
    protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder) =>
        configurationBuilder.Properties<decimal>().HavePrecision(18, 2);

    public override async Task<int> SaveChangesAsync(bool acceptAllChangesOnSuccess, CancellationToken cancellationToken = default)
    {
        ChangeTracker.DetectChanges();
        TouchRootsOfChangedChildren();
        try
        {
            return await base.SaveChangesAsync(acceptAllChangesOnSuccess, cancellationToken);
        }
        catch (Exception ex) when (ToConflict(ex) is { } conflict)
        {
            throw conflict;
        }
    }

    // The xmin check guards a row, but an aggregate spans several: a check's lines are rows of their
    // own. Marking the aggregate modified whenever one of its children changes puts its row, and its
    // check, into every save that touches it.
    private void TouchRootsOfChangedChildren()
    {
        var changedChildren = ChangeTracker.Entries()
            .Where(e => e.Entity is Entity and not AggregateRoot
                && e.State is EntityState.Added or EntityState.Modified or EntityState.Deleted)
            .ToList();

        foreach (var child in changedChildren)
        {
            foreach (var foreignKey in child.Metadata.GetForeignKeys()
                         .Where(fk => fk.PrincipalToDependent is not null
                             && typeof(AggregateRoot).IsAssignableFrom(fk.PrincipalEntityType.ClrType)))
            {
                var property = child.Property(foreignKey.Properties[0].Name);
                var rootId = (Guid?)(child.State == EntityState.Deleted ? property.OriginalValue : property.CurrentValue);
                var root = ChangeTracker.Entries<AggregateRoot>().FirstOrDefault(r => r.Entity.Id == rootId);
                if (root is { State: EntityState.Unchanged })
                    root.State = EntityState.Modified;
            }
        }
    }

    // The save failures a caller can act on, translated so no layer above this one ever handles an
    // EF Core or Npgsql type.
    private static ConflictException? ToConflict(Exception ex) => ex switch
    {
        DbUpdateConcurrencyException =>
            new ConflictException("Someone else changed this at the same time. Reload it and try again.", ex),
        DbUpdateException { InnerException: PostgresException { SqlState: PostgresErrorCodes.UniqueViolation } } =>
            new ConflictException("This conflicts with a record that already exists.", ex),
        DbUpdateException { InnerException: PostgresException { SqlState: PostgresErrorCodes.ForeignKeyViolation } } =>
            new ConflictException("It was put to use at the same time. Reload and try again.", ex),
        _ => null,
    };
}

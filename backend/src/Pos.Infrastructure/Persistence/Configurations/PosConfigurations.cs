using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Pos.Domain.Catalog;
using Pos.Domain.Customers;
using Pos.Domain.Floor;
using Pos.Domain.Integrations;
using Pos.Domain.Kitchen;
using Pos.Domain.Orders;
using Pos.Domain.Printing;
using Pos.Domain.Settings;
using Pos.Domain.Shifts;
using Pos.Infrastructure.Printing;

namespace Pos.Infrastructure.Persistence.Configurations;

internal sealed class KitchenStationConfiguration : IEntityTypeConfiguration<KitchenStation>
{
    public void Configure(EntityTypeBuilder<KitchenStation> builder)
    {
        builder.ToTable("KitchenStations", PosDbContext.PosSchema);
        builder.Property(s => s.Name).HasMaxLength(KitchenStation.MaxNameLength);
        builder.Property(s => s.NameAr).HasMaxLength(KitchenStation.MaxNameLength);
        builder.HasOne<Printer>().WithMany().HasForeignKey(s => s.PrinterId).OnDelete(DeleteBehavior.SetNull);
    }
}

internal sealed class MenuCategoryConfiguration : IEntityTypeConfiguration<MenuCategory>
{
    public void Configure(EntityTypeBuilder<MenuCategory> builder)
    {
        builder.ToTable("MenuCategories", PosDbContext.PosSchema);
        builder.Property(c => c.Name).HasMaxLength(MenuCategory.MaxNameLength);
        builder.Property(c => c.NameAr).HasMaxLength(MenuCategory.MaxNameLength);
        builder.Property(c => c.Color).HasMaxLength(16);
    }
}

internal sealed class MenuItemConfiguration : IEntityTypeConfiguration<MenuItem>
{
    public void Configure(EntityTypeBuilder<MenuItem> builder)
    {
        builder.ToTable("MenuItems", PosDbContext.PosSchema);
        builder.Property(i => i.Name).HasMaxLength(MenuItem.MaxNameLength);
        builder.Property(i => i.NameAr).HasMaxLength(MenuItem.MaxNameLength);
        builder.HasIndex(i => i.Code).IsUnique();
        builder.HasOne<MenuCategory>().WithMany().HasForeignKey(i => i.CategoryId).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<KitchenStation>().WithMany().HasForeignKey(i => i.StationId).OnDelete(DeleteBehavior.SetNull);
        builder.HasMany(i => i.Sizes).WithOne().HasForeignKey(s => s.MenuItemId).OnDelete(DeleteBehavior.Cascade);
        builder.Navigation(i => i.Sizes).HasField("_sizes").UsePropertyAccessMode(PropertyAccessMode.Field);
        builder.HasMany(i => i.Modifiers).WithOne().HasForeignKey(m => m.MenuItemId).OnDelete(DeleteBehavior.Cascade);
        builder.Navigation(i => i.Modifiers).HasField("_modifiers").UsePropertyAccessMode(PropertyAccessMode.Field);
    }
}

internal sealed class MenuItemSizeConfiguration : IEntityTypeConfiguration<MenuItemSize>
{
    public void Configure(EntityTypeBuilder<MenuItemSize> builder)
    {
        builder.ToTable("MenuItemSizes", PosDbContext.PosSchema);
        builder.Property(s => s.Name).HasMaxLength(MenuItem.MaxNameLength);
        builder.Property(s => s.NameAr).HasMaxLength(MenuItem.MaxNameLength);
    }
}

internal sealed class MenuModifierConfiguration : IEntityTypeConfiguration<MenuModifier>
{
    public void Configure(EntityTypeBuilder<MenuModifier> builder)
    {
        builder.ToTable("MenuModifiers", PosDbContext.PosSchema);
        builder.Property(m => m.Name).HasMaxLength(MenuItem.MaxNameLength);
        builder.Property(m => m.NameAr).HasMaxLength(MenuItem.MaxNameLength);
    }
}

internal sealed class DiningZoneConfiguration : IEntityTypeConfiguration<DiningZone>
{
    public void Configure(EntityTypeBuilder<DiningZone> builder)
    {
        builder.ToTable("DiningZones", PosDbContext.PosSchema);
        builder.Property(z => z.Name).HasMaxLength(80);
        builder.Property(z => z.NameAr).HasMaxLength(80);
    }
}

internal sealed class DiningTableConfiguration : IEntityTypeConfiguration<DiningTable>
{
    public void Configure(EntityTypeBuilder<DiningTable> builder)
    {
        builder.ToTable("DiningTables", PosDbContext.PosSchema);
        builder.Property(t => t.Label).HasMaxLength(16);
        builder.HasIndex(t => t.Label).IsUnique();
        builder.Property(t => t.Shape).IsEnumName();
        builder.HasOne<DiningZone>().WithMany().HasForeignKey(t => t.ZoneId).OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class OrderConfiguration : IEntityTypeConfiguration<Order>
{
    public void Configure(EntityTypeBuilder<Order> builder)
    {
        builder.ToTable("Orders", PosDbContext.PosSchema);
        builder.Property(o => o.Type).IsEnumName();
        builder.Property(o => o.Status).IsEnumName();
        builder.Property(o => o.TableLabel).HasMaxLength(16);
        builder.Property(o => o.CheckLabel).HasMaxLength(2);
        builder.Property(o => o.OpenedById).HasMaxLength(64);
        builder.Property(o => o.OpenedBy).HasMaxLength(200);
        builder.Property(o => o.Notes).HasMaxLength(300);
        builder.Property(o => o.CustomerName).HasMaxLength(120);
        builder.Property(o => o.CustomerPhone).HasMaxLength(32);
        builder.Property(o => o.LoyaltyUserId).HasMaxLength(64);
        builder.Property(o => o.DeliveryAddress).HasMaxLength(300);
        builder.Property(o => o.DriverName).HasMaxLength(120);
        builder.Property(o => o.DiscountReason).HasMaxLength(200);
        builder.Property(o => o.DiscountBy).HasMaxLength(200);
        builder.Property(o => o.SettledBy).HasMaxLength(200);
        builder.Property(o => o.CancelReason).HasMaxLength(200);
        builder.Ignore(o => o.Totals);
        builder.Ignore(o => o.IsClosed);
        builder.Ignore(o => o.HasDrafts);
        builder.Ignore(o => o.HasBeenToKitchen);
        builder.HasMany(o => o.Lines).WithOne().HasForeignKey(l => l.OrderId).OnDelete(DeleteBehavior.Cascade);
        builder.Navigation(o => o.Lines).HasField("_lines").UsePropertyAccessMode(PropertyAccessMode.Field);
        builder.HasMany(o => o.Voids).WithOne().HasForeignKey(v => v.OrderId).OnDelete(DeleteBehavior.Cascade);
        builder.Navigation(o => o.Voids).HasField("_voids").UsePropertyAccessMode(PropertyAccessMode.Field);
        builder.HasMany(o => o.Payments).WithOne().HasForeignKey(p => p.OrderId).OnDelete(DeleteBehavior.Cascade);
        builder.Navigation(o => o.Payments).HasField("_payments").UsePropertyAccessMode(PropertyAccessMode.Field);
        // Each day counts its checks from 1.
        builder.HasIndex(o => new { o.BusinessDate, o.Number }).IsUnique();
        builder.HasIndex(o => o.Status);
        builder.HasIndex(o => o.ShiftId);
        builder.HasIndex(o => o.TableId);
    }
}

internal sealed class OrderLineConfiguration : IEntityTypeConfiguration<OrderLine>
{
    public void Configure(EntityTypeBuilder<OrderLine> builder)
    {
        builder.ToTable("OrderLines", PosDbContext.PosSchema);
        builder.Property(l => l.Name).HasMaxLength(MenuItem.MaxNameLength);
        builder.Property(l => l.NameAr).HasMaxLength(MenuItem.MaxNameLength);
        builder.Property(l => l.SizeName).HasMaxLength(MenuItem.MaxNameLength);
        builder.Property(l => l.SizeNameAr).HasMaxLength(MenuItem.MaxNameLength);
        builder.Property(l => l.Modifiers).HasMaxLength(1000);
        builder.Property(l => l.ModifiersAr).HasMaxLength(1000);
        builder.Property(l => l.Notes).HasMaxLength(200);
        builder.Property(l => l.StationName).HasMaxLength(KitchenStation.MaxNameLength);
        builder.Property(l => l.Status).IsEnumName();
        builder.Property(l => l.AddedBy).HasMaxLength(200);
        builder.Ignore(l => l.Total);
    }
}

internal sealed class VoidEntryConfiguration : IEntityTypeConfiguration<VoidEntry>
{
    public void Configure(EntityTypeBuilder<VoidEntry> builder)
    {
        builder.ToTable("OrderVoids", PosDbContext.PosSchema);
        builder.Property(v => v.ItemName).HasMaxLength(MenuItem.MaxNameLength);
        builder.Property(v => v.Kind).IsEnumName();
        builder.Property(v => v.Outcome).IsEnumName();
        builder.Property(v => v.Reason).HasMaxLength(200);
        builder.Property(v => v.AuthorizedBy).HasMaxLength(200);
        builder.Property(v => v.VoidedBy).HasMaxLength(200);
    }
}

internal sealed class PaymentConfiguration : IEntityTypeConfiguration<Payment>
{
    public void Configure(EntityTypeBuilder<Payment> builder)
    {
        builder.ToTable("OrderPayments", PosDbContext.PosSchema);
        builder.Property(p => p.Method).IsEnumName();
        builder.Property(p => p.Reference).HasMaxLength(120);
        builder.Property(p => p.By).HasMaxLength(200);
        builder.Ignore(p => p.Change);
        builder.HasIndex(p => p.ShiftId);
    }
}

internal sealed class KitchenTicketConfiguration : IEntityTypeConfiguration<KitchenTicket>
{
    public void Configure(EntityTypeBuilder<KitchenTicket> builder)
    {
        builder.ToTable("KitchenTickets", PosDbContext.PosSchema);
        builder.Property(t => t.Kind).IsEnumName();
        builder.Property(t => t.OrderType).IsEnumName();
        builder.Property(t => t.TableLabel).HasMaxLength(16);
        builder.Property(t => t.CheckLabel).HasMaxLength(2);
        builder.Property(t => t.CreatedBy).HasMaxLength(200);
        builder.Property(t => t.Note).HasMaxLength(300);
        builder.Ignore(t => t.IsDone);
        builder.HasMany(t => t.Lines).WithOne().HasForeignKey(l => l.TicketId).OnDelete(DeleteBehavior.Cascade);
        builder.Navigation(t => t.Lines).HasField("_lines").UsePropertyAccessMode(PropertyAccessMode.Field);
        // Each day counts its tickets from 1.
        builder.HasIndex(t => new { t.BusinessDate, t.Number }).IsUnique();
        builder.HasIndex(t => t.OrderId);
    }
}

internal sealed class KitchenTicketLineConfiguration : IEntityTypeConfiguration<KitchenTicketLine>
{
    public void Configure(EntityTypeBuilder<KitchenTicketLine> builder)
    {
        builder.ToTable("KitchenTicketLines", PosDbContext.PosSchema);
        builder.Property(l => l.Name).HasMaxLength(MenuItem.MaxNameLength);
        builder.Property(l => l.NameAr).HasMaxLength(MenuItem.MaxNameLength);
        builder.Property(l => l.SizeName).HasMaxLength(MenuItem.MaxNameLength);
        builder.Property(l => l.Modifiers).HasMaxLength(1000);
        builder.Property(l => l.Notes).HasMaxLength(200);
        builder.Property(l => l.StationName).HasMaxLength(KitchenStation.MaxNameLength);
        builder.HasIndex(l => l.DoneAtUtc);
    }
}

internal sealed class CustomerConfiguration : IEntityTypeConfiguration<Customer>
{
    public void Configure(EntityTypeBuilder<Customer> builder)
    {
        builder.ToTable("Customers", PosDbContext.PosSchema);
        builder.Property(c => c.Name).HasMaxLength(120);
        builder.Property(c => c.Phone).HasMaxLength(15);
        builder.HasIndex(c => c.Phone).IsUnique();
        builder.Property(c => c.LoyaltyUserId).HasMaxLength(64);
        builder.HasIndex(c => c.LoyaltyUserId).IsUnique().HasFilter("\"LoyaltyUserId\" IS NOT NULL");
        builder.Property(c => c.Tier).HasMaxLength(40);
    }
}

internal sealed class ShiftConfiguration : IEntityTypeConfiguration<Shift>
{
    public void Configure(EntityTypeBuilder<Shift> builder)
    {
        builder.ToTable("Shifts", PosDbContext.PosSchema);
        builder.Property(s => s.Status).IsEnumName();
        builder.Property(s => s.OpenedById).HasMaxLength(64);
        builder.Property(s => s.OpenedBy).HasMaxLength(200);
        builder.Property(s => s.ClosedBy).HasMaxLength(200);
        builder.Property(s => s.ZReport).HasColumnType("jsonb");
        builder.Ignore(s => s.PaidOutTotal);
        builder.HasIndex(s => s.Number).IsUnique();
        // One shift open at a time: the drawer is one.
        builder.HasIndex(s => s.Status).IsUnique().HasFilter("\"Status\" = 'Open'");
        builder.HasMany(s => s.PaidOuts).WithOne().HasForeignKey(p => p.ShiftId).OnDelete(DeleteBehavior.Cascade);
        builder.Navigation(s => s.PaidOuts).HasField("_paidOuts").UsePropertyAccessMode(PropertyAccessMode.Field);
    }
}

internal sealed class PaidOutConfiguration : IEntityTypeConfiguration<PaidOut>
{
    public void Configure(EntityTypeBuilder<PaidOut> builder)
    {
        builder.ToTable("ShiftPaidOuts", PosDbContext.PosSchema);
        builder.Property(p => p.Kind).IsEnumName();
        builder.Property(p => p.Reason).HasMaxLength(200);
        builder.Property(p => p.StaffName).HasMaxLength(120);
        builder.Property(p => p.By).HasMaxLength(200);
    }
}

internal sealed class ClockEventConfiguration : IEntityTypeConfiguration<ClockEvent>
{
    public void Configure(EntityTypeBuilder<ClockEvent> builder)
    {
        builder.ToTable("ClockEvents", PosDbContext.PosSchema);
        builder.Property(c => c.UserId).HasMaxLength(64);
        builder.Property(c => c.Name).HasMaxLength(200);
        builder.HasIndex(c => new { c.UserId, c.AtUtc });
    }
}

internal sealed class PosSettingsConfiguration : IEntityTypeConfiguration<PosSettings>
{
    public void Configure(EntityTypeBuilder<PosSettings> builder)
    {
        builder.ToTable("PosSettings", PosDbContext.PosSchema, t => t.HasCheckConstraint("CK_PosSettings_Single", $"\"Id\" = {PosSettings.SingletonId}"));
        builder.HasKey(s => s.Id);
        builder.Property(s => s.Id).ValueGeneratedNever();
        builder.Property(s => s.TaxPercent).HasPrecision(6, 3);
        builder.Property(s => s.ServicePercent).HasPrecision(6, 3);
        builder.Property(s => s.PointsPerCurrencyUnit).HasPrecision(10, 4);
        builder.Property(s => s.CashierDiscountLimitPercent).HasPrecision(6, 3);
        builder.Property(s => s.ReceiptHeader).HasMaxLength(300);
        builder.Property(s => s.ReceiptFooter).HasMaxLength(300);
        builder.Property(s => s.TaxNumber).HasMaxLength(40);
        builder.Property(s => s.UpdatedBy).HasMaxLength(200);
        builder.Property(s => s.VoidReasons).HasConversion(StringList.Converter, StringList.Comparer).HasColumnType("jsonb");
        builder.Property(s => s.QuickNotes).HasConversion(StringList.Converter, StringList.Comparer).HasColumnType("jsonb");
    }
}

internal sealed class PrinterConfiguration : IEntityTypeConfiguration<Printer>
{
    public void Configure(EntityTypeBuilder<Printer> builder)
    {
        builder.ToTable("Printers", PosDbContext.PosSchema);
        builder.Property(p => p.Name).HasMaxLength(80);
        builder.Property(p => p.Connection).IsEnumName();
        builder.Property(p => p.Role).IsEnumName();
        builder.Property(p => p.Host).HasMaxLength(255);
    }
}

internal sealed class PrintJobConfiguration : IEntityTypeConfiguration<PrintJob>
{
    public void Configure(EntityTypeBuilder<PrintJob> builder)
    {
        builder.ToTable("PrintJobs", PosDbContext.PosSchema);
        builder.HasKey(j => j.Id);
        builder.Property(j => j.Id).ValueGeneratedNever();
        builder.Property(j => j.Kind).IsEnumName();
        builder.Property(j => j.Status).IsEnumName();
        builder.Property(j => j.PrinterName).HasMaxLength(80);
        builder.Property(j => j.Host).HasMaxLength(255);
        builder.Property(j => j.Title).HasMaxLength(200);
        builder.Property(j => j.LastError).HasMaxLength(500);
        builder.HasIndex(j => new { j.Status, j.NextAttemptAtUtc });
    }
}

internal sealed class IntegrationLinkConfiguration : IEntityTypeConfiguration<IntegrationLink>
{
    public void Configure(EntityTypeBuilder<IntegrationLink> builder)
    {
        builder.ToTable("IntegrationLinks", PosDbContext.PosSchema);
        builder.HasKey(l => l.System);
        builder.Property(l => l.System).IsEnumName();
        builder.Property(l => l.BaseUrl).HasMaxLength(300);
        builder.Property(l => l.ApiKey).HasMaxLength(300);
        builder.Property(l => l.BranchCode).HasMaxLength(40);
        builder.Property(l => l.LastTestMessage).HasMaxLength(300);
        builder.Property(l => l.UpdatedBy).HasMaxLength(200);
        builder.Ignore(l => l.IsReady);
    }
}

internal sealed class SyncItemConfiguration : IEntityTypeConfiguration<SyncItem>
{
    public void Configure(EntityTypeBuilder<SyncItem> builder)
    {
        builder.ToTable("SyncQueue", PosDbContext.PosSchema);
        builder.HasKey(i => i.Id);
        builder.Property(i => i.Id).ValueGeneratedNever();
        builder.Property(i => i.System).IsEnumName();
        builder.Property(i => i.Kind).HasMaxLength(40);
        builder.Property(i => i.Summary).HasMaxLength(200);
        builder.Property(i => i.Payload).HasColumnType("jsonb");
        builder.Property(i => i.Status).IsEnumName();
        builder.Property(i => i.LastError).HasMaxLength(500);
        builder.HasIndex(i => new { i.Status, i.NextAttemptAtUtc });
        builder.HasIndex(i => i.CreatedAtUtc);
    }
}

// A list of short texts kept as a JSON array.
internal static class StringList
{
    public static readonly Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<List<string>, string> Converter = new(
        v => JsonSerializer.Serialize(v, (JsonSerializerOptions?)null),
        v => JsonSerializer.Deserialize<List<string>>(v, (JsonSerializerOptions?)null) ?? new List<string>());

    public static readonly ValueComparer<List<string>> Comparer = new(
        (a, b) => (a ?? new List<string>()).SequenceEqual(b ?? new List<string>()),
        v => v.Aggregate(0, (h, s) => HashCode.Combine(h, s.GetHashCode())),
        v => v.ToList());
}

using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Microsoft.Extensions.Logging;
using Pos.Application.Common;
using Pos.Domain.Access;
using Pos.Domain.Common;
using Pos.Infrastructure.Persistence;
using Pos.Infrastructure.Persistence.Configurations;

namespace Pos.Infrastructure.Identity;

// Someone who works in the restaurant: a manager signs in with their email and password (the back
// office) or their PIN (a terminal); a cashier, a captain or the kitchen with their PIN alone.
public sealed class UserAccount
{
    public const int MaxEmailLength = 256;
    public const int MaxNameLength = 200;
    public const int MinPasswordLength = 8;

    public string Id { get; set; } = string.Empty;

    public string? Email { get; set; }

    // Upper case, for finding an email however it is typed.
    public string? NormalizedEmail { get; set; }

    public string FullName { get; set; } = string.Empty;

    public UserRole Role { get; set; }

    public bool IsActive { get; set; } = true;

    public string? PasswordHash { get; set; }

    // The PIN as a keyed hash: never kept as typed, and found by what it hashes to, so two people
    // never share one.
    public string? PinDigest { get; set; }

    // When the password or PIN was last set: a new one signs them out wherever they are signed in.
    public DateTime PasswordSetAtUtc { get; set; }

    public int FailedSignInAttempts { get; set; }

    public DateTime? LockedUntilUtc { get; set; }

    public DateTime CreatedAtUtc { get; set; }

    public DateTime? LastSignInAtUtc { get; set; }

    // Their id in the HR system, for staff it sent.
    public string? EmployeeId { get; set; }

    public bool HasPin => PinDigest is not null;
}

internal sealed class UserAccountConfiguration : IEntityTypeConfiguration<UserAccount>
{
    public void Configure(EntityTypeBuilder<UserAccount> builder)
    {
        builder.ToTable("Users", PosDbContext.IdentitySchema);
        builder.HasKey(u => u.Id);
        builder.Property(u => u.Id).HasMaxLength(64);
        builder.Property(u => u.Email).HasMaxLength(UserAccount.MaxEmailLength);
        builder.Property(u => u.NormalizedEmail).HasMaxLength(UserAccount.MaxEmailLength);
        builder.HasIndex(u => u.NormalizedEmail).IsUnique().HasFilter("\"NormalizedEmail\" IS NOT NULL");
        builder.Property(u => u.FullName).HasMaxLength(UserAccount.MaxNameLength);
        builder.Property(u => u.Role).IsEnumName();
        builder.Property(u => u.PasswordHash).HasMaxLength(200);
        builder.Property(u => u.PinDigest).HasMaxLength(64);
        builder.HasIndex(u => u.PinDigest).IsUnique().HasFilter("\"PinDigest\" IS NOT NULL");
        builder.Property(u => u.EmployeeId).HasMaxLength(64);
        builder.HasIndex(u => u.EmployeeId).IsUnique().HasFilter("\"EmployeeId\" IS NOT NULL");
        builder.Ignore(u => u.HasPin);
    }
}

// A PIN's keyed hash: the same for the same PIN, unreadable without the server's key.
public sealed class PinHasher(string key)
{
    private readonly byte[] _key = SHA256.HashData(Encoding.UTF8.GetBytes("pos-pin:" + key));

    public string Digest(string pin) => Convert.ToBase64String(HMACSHA256.HashData(_key, Encoding.UTF8.GetBytes(pin)));

    public static string Check(string? pin)
    {
        var digits = (pin ?? string.Empty).Trim();
        if (digits.Length != 4 || !digits.All(char.IsAsciiDigit))
            throw new DomainException("A PIN is four digits. · الرقم السري 4 أرقام.");
        return digits;
    }
}

public sealed record SignInOutcome(UserAccount? User, DateTime? LockedUntilUtc);

// Who may sign in, and with what. Email and password: five misses lock the account for five
// minutes. A PIN finds its holder by itself, so the API limits how fast an address may try them. A
// manager adds the staff, changes their role, deactivates them, resets their passwords and PINs;
// there is always at least one active manager.
public sealed class UserDirectory(PosDbContext db, PinHasher pins, ILogger<UserDirectory> logger) : IStaffDirectory
{
    private const int MaxFailedAttempts = 5;
    private static readonly TimeSpan LockoutDuration = TimeSpan.FromMinutes(5);
    private static readonly PasswordHasher<UserAccount> Hasher = new();

    // A hash to check a password against when no user has the email, so a wrong email takes as
    // long as a wrong password and does not say which emails are known.
    private static readonly Lazy<string> Nobody = new(() => Hasher.HashPassword(new UserAccount(), Guid.NewGuid().ToString("N")));

    public async Task<IReadOnlyList<UserAccount>> GetAllAsync(CancellationToken cancellationToken) =>
        await db.Users.AsNoTracking().OrderBy(u => u.FullName).ToListAsync(cancellationToken);

    public Task<UserAccount?> GetAsync(string id, CancellationToken cancellationToken) =>
        db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Id == id, cancellationToken);

    // Null when the user is gone or deactivated. Checked on every request, so a deactivation, a
    // new role or a new password takes effect at once rather than when a token expires.
    public async Task<(UserRole Role, DateTime PasswordSetAtUtc)?> GetActiveAsync(string id, CancellationToken cancellationToken) =>
        await db.Users.AsNoTracking()
            .Where(u => u.Id == id && u.IsActive)
            .Select(u => new { u.Role, u.PasswordSetAtUtc })
            .SingleOrDefaultAsync(cancellationToken) is { } found
            ? (found.Role, found.PasswordSetAtUtc)
            : null;

    public async Task<SignInOutcome> SignInAsync(string? email, string? password, CancellationToken cancellationToken)
    {
        var normalized = Normalize(email);
        var user = normalized.Length == 0 ? null
            : await db.Users.SingleOrDefaultAsync(u => u.NormalizedEmail == normalized && u.IsActive && u.PasswordHash != null, cancellationToken);
        if (user is null)
        {
            Hasher.VerifyHashedPassword(new UserAccount(), Nobody.Value, password ?? string.Empty);
            return new SignInOutcome(null, null);
        }
        if (user.LockedUntilUtc > DateTime.UtcNow)
            return new SignInOutcome(null, user.LockedUntilUtc);

        var result = Hasher.VerifyHashedPassword(user, user.PasswordHash!, password ?? string.Empty);
        if (result == PasswordVerificationResult.Failed)
        {
            if (++user.FailedSignInAttempts >= MaxFailedAttempts)
            {
                user.FailedSignInAttempts = 0;
                user.LockedUntilUtc = DateTime.UtcNow + LockoutDuration;
                logger.LogWarning("User {UserId} locked after {Attempts} wrong passwords", user.Id, MaxFailedAttempts);
            }
            await db.SaveChangesAsync(cancellationToken);
            return new SignInOutcome(null, user.LockedUntilUtc);
        }

        if (result == PasswordVerificationResult.SuccessRehashNeeded)
            user.PasswordHash = Hasher.HashPassword(user, password!);
        user.FailedSignInAttempts = 0;
        user.LockedUntilUtc = null;
        user.LastSignInAtUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(cancellationToken);
        return new SignInOutcome(user, null);
    }

    // A terminal's sign-in: the active member of staff whose PIN it is, or no one.
    public async Task<UserAccount?> SignInByPinAsync(string? pin, CancellationToken cancellationToken)
    {
        string digits;
        try
        {
            digits = PinHasher.Check(pin);
        }
        catch (DomainException)
        {
            return null;
        }
        var digest = pins.Digest(digits);
        var user = await db.Users.SingleOrDefaultAsync(u => u.PinDigest == digest && u.IsActive, cancellationToken);
        if (user is null)
            return null;
        user.LastSignInAtUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(cancellationToken);
        return user;
    }

    public async Task<StaffMember?> ByPinAsync(string? pin, CancellationToken cancellationToken = default)
    {
        try
        {
            var digest = pins.Digest(PinHasher.Check(pin));
            return await db.Users.AsNoTracking().Where(u => u.PinDigest == digest && u.IsActive)
                .Select(u => new StaffMember(u.Id, u.FullName, u.Role)).SingleOrDefaultAsync(cancellationToken);
        }
        catch (DomainException)
        {
            return null;
        }
    }

    public async Task<IReadOnlyList<StaffMember>> ActiveAsync(CancellationToken cancellationToken = default) =>
        await db.Users.AsNoTracking().Where(u => u.IsActive).OrderBy(u => u.FullName)
            .Select(u => new StaffMember(u.Id, u.FullName, u.Role)).ToListAsync(cancellationToken);

    // A manager needs an email and a password, for the back office; anyone else a PIN at least.
    public async Task<UserAccount> CreateAsync(string? email, string fullName, UserRole role, string? password, string? pin,
        CancellationToken cancellationToken, string? employeeId = null)
    {
        var user = new UserAccount { Id = Guid.NewGuid().ToString("N"), CreatedAtUtc = DateTime.UtcNow, IsActive = true, EmployeeId = employeeId };
        await SetDetailsAsync(user, email, fullName, role, cancellationToken);
        if (!string.IsNullOrEmpty(password))
            SetPassword(user, password);
        if (!string.IsNullOrEmpty(pin))
            await SetPinAsync(user, pin, cancellationToken);
        if (role == UserRole.Manager && (user.Email is null || user.PasswordHash is null))
            throw new DomainException("A manager signs in to the back office: give them an email and a password. · البريد وكلمة المرور.");
        if (user.PasswordHash is null && user.PinDigest is null)
            throw new DomainException("Give them a PIN to sign in at the terminals. · الرقم السري.");
        db.Users.Add(user);
        await db.SaveChangesAsync(cancellationToken);
        return user;
    }

    public async Task<UserAccount> UpdateAsync(string id, string? email, string fullName, UserRole role, bool isActive, CancellationToken cancellationToken)
    {
        var user = await db.Users.SingleOrDefaultAsync(u => u.Id == id, cancellationToken) ?? throw new NotFoundException("User", id);
        if ((role != UserRole.Manager || !isActive) && user is { Role: UserRole.Manager, IsActive: true }
            && !await db.Users.AnyAsync(u => u.Id != id && u.IsActive && u.Role == UserRole.Manager, cancellationToken))
            throw new DomainException("This is the only active manager: make someone else a manager first.");
        await SetDetailsAsync(user, email, fullName, role, cancellationToken);
        if (role == UserRole.Manager && (user.Email is null || user.PasswordHash is null))
            throw new DomainException("A manager signs in to the back office: give them an email and set their password.");
        user.IsActive = isActive;
        await db.SaveChangesAsync(cancellationToken);
        return user;
    }

    // A manager's reset, or their own change: either lifts a lockout and signs them out elsewhere.
    public async Task SetPasswordAsync(string id, string password, CancellationToken cancellationToken)
    {
        var user = await db.Users.SingleOrDefaultAsync(u => u.Id == id, cancellationToken) ?? throw new NotFoundException("User", id);
        SetPassword(user, password);
        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task SetPinAsync(string id, string pin, CancellationToken cancellationToken)
    {
        var user = await db.Users.SingleOrDefaultAsync(u => u.Id == id, cancellationToken) ?? throw new NotFoundException("User", id);
        await SetPinAsync(user, pin, cancellationToken);
        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task ChangeOwnPasswordAsync(string id, string current, string password, CancellationToken cancellationToken)
    {
        var user = await db.Users.SingleOrDefaultAsync(u => u.Id == id, cancellationToken) ?? throw new NotFoundException("User", id);
        if (user.PasswordHash is null
            || Hasher.VerifyHashedPassword(user, user.PasswordHash, current ?? string.Empty) == PasswordVerificationResult.Failed)
            throw new DomainException("Your current password is not right.");
        SetPassword(user, password);
        await db.SaveChangesAsync(cancellationToken);
    }

    // The HR system's staff, as it sends them: each matched by their employee id, added or
    // changed, their PIN set when it sends one; a manager is never changed from here.
    public async Task<(int Added, int Updated, int Skipped)> SyncFromHrAsync(IReadOnlyList<HrStaffMember> staff, CancellationToken cancellationToken)
    {
        var (added, updated, skipped) = (0, 0, 0);
        foreach (var member in staff)
        {
            var role = member.Role?.Trim().ToLowerInvariant() switch
            {
                "cashier" => UserRole.Cashier,
                "kitchen" or "chef" or "cook" => UserRole.Kitchen,
                _ => UserRole.Captain,
            };
            try
            {
                var user = await db.Users.SingleOrDefaultAsync(u => u.EmployeeId == member.EmployeeId, cancellationToken);
                if (user is null)
                {
                    if (!member.IsActive || string.IsNullOrEmpty(member.Pin))
                    {
                        skipped++;
                        continue;
                    }
                    await CreateAsync(null, member.Name, role, null, member.Pin, cancellationToken, member.EmployeeId);
                    added++;
                    continue;
                }
                if (user.Role == UserRole.Manager)
                {
                    skipped++;
                    continue;
                }
                user.FullName = member.Name.Trim()[..Math.Min(member.Name.Trim().Length, UserAccount.MaxNameLength)];
                user.Role = role;
                user.IsActive = member.IsActive;
                if (!string.IsNullOrEmpty(member.Pin) && user.PinDigest != pins.Digest(member.Pin.Trim()))
                    await SetPinAsync(user, member.Pin, cancellationToken);
                await db.SaveChangesAsync(cancellationToken);
                updated++;
            }
            catch (DomainException ex)
            {
                logger.LogWarning("HR staff member {EmployeeId} not synced: {Reason}", member.EmployeeId, ex.Message);
                db.ChangeTracker.Clear();
                skipped++;
            }
        }
        return (added, updated, skipped);
    }

    // First run: with no user at all, nobody could sign in to add anyone. So the first manager
    // comes from configuration; once there is a user, the configuration is not read again, and
    // the password should be taken out of it.
    public async Task EnsureFirstManagerAsync(string? email, string? name, string? password, string? pin, CancellationToken cancellationToken)
    {
        if (await db.Users.AnyAsync(cancellationToken))
            return;
        if (string.IsNullOrWhiteSpace(email) || string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(password))
        {
            logger.LogWarning("There is no user yet. Set Auth:FirstManager:Email, Name and Password to create the first manager.");
            return;
        }

        await CreateAsync(email, name, UserRole.Manager, password, string.IsNullOrWhiteSpace(pin) ? null : pin, cancellationToken);
        logger.LogWarning("Created the first manager, {Email}, from Auth:FirstManager. Take the password out of the configuration now.", email.Trim());
    }

    private async Task SetDetailsAsync(UserAccount user, string? email, string fullName, UserRole role, CancellationToken cancellationToken)
    {
        var trimmed = email?.Trim() ?? string.Empty;
        if (trimmed.Length > 0 && (trimmed.Length > UserAccount.MaxEmailLength || !trimmed.Contains('@') || trimmed.StartsWith('@') || trimmed.EndsWith('@')))
            throw new DomainException("Enter their email address: name@restaurant.com.");
        var name = fullName?.Trim() ?? string.Empty;
        if (name.Length is 0 or > UserAccount.MaxNameLength)
            throw new DomainException("Enter their full name. · الاسم.");
        if (!Enum.IsDefined(role))
            throw new DomainException("Choose their role: manager, cashier, captain or kitchen.");
        var normalized = trimmed.Length == 0 ? null : Normalize(trimmed);
        if (normalized is not null && await db.Users.AnyAsync(u => u.Id != user.Id && u.NormalizedEmail == normalized, cancellationToken))
            throw new DomainException($"{trimmed} is someone else's already.");
        user.Email = trimmed.Length == 0 ? null : trimmed;
        user.NormalizedEmail = normalized;
        user.FullName = name;
        user.Role = role;
    }

    private async Task SetPinAsync(UserAccount user, string pin, CancellationToken cancellationToken)
    {
        var digest = pins.Digest(PinHasher.Check(pin));
        if (await db.Users.AnyAsync(u => u.Id != user.Id && u.PinDigest == digest, cancellationToken))
            throw new DomainException("Someone else has this PIN: choose another. · الرقم السري مستخدم.");
        user.PinDigest = digest;
        user.PasswordSetAtUtc = DateTime.UtcNow;
    }

    private static void SetPassword(UserAccount user, string password)
    {
        if ((password ?? string.Empty).Length < UserAccount.MinPasswordLength)
            throw new DomainException($"A password is {UserAccount.MinPasswordLength} characters at least.");
        user.PasswordHash = Hasher.HashPassword(user, password!);
        user.PasswordSetAtUtc = DateTime.UtcNow;
        user.FailedSignInAttempts = 0;
        user.LockedUntilUtc = null;
    }

    private static string Normalize(string? email) => (email ?? string.Empty).Trim().ToUpperInvariant();
}

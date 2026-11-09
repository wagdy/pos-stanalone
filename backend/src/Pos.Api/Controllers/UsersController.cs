using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Pos.Api.Auth;
using Pos.Domain.Access;
using Pos.Infrastructure.Identity;

namespace Pos.Api.Controllers;

// The staff, a manager's: added (a manager with an email and password, anyone with a PIN), changed
// (name, email, role, active), their password or PIN reset. There is always an active manager.
[ApiController]
[Route("api/users")]
[Authorize(Policy = Permissions.UsersManage)]
public sealed class UsersController(UserDirectory users) : ControllerBase
{
    [HttpGet]
    public async Task<IReadOnlyList<UserDto>> GetAll(CancellationToken cancellationToken) =>
        (await users.GetAllAsync(cancellationToken)).Select(UserDto.From).ToList();

    [HttpPost]
    public async Task<UserDto> Create(CreateUserRequest request, CancellationToken cancellationToken) =>
        UserDto.From(await users.CreateAsync(request.Email, request.FullName, request.Role, request.Password, request.Pin, cancellationToken));

    [HttpPut("{userId}")]
    public async Task<UserDto> Update(string userId, UpdateUserRequest request, CancellationToken cancellationToken)
    {
        if (userId == UserClaims.IdOf(User) && (!request.IsActive || request.Role != UserRole.Manager))
            throw new Pos.Domain.Common.DomainException("You cannot take your own manager's rights away: another manager does that.");
        return UserDto.From(await users.UpdateAsync(userId, request.Email, request.FullName, request.Role, request.IsActive, cancellationToken));
    }

    // Also lifts a lockout, and signs them out wherever they are signed in.
    [HttpPut("{userId}/password")]
    public async Task<IActionResult> ResetPassword(string userId, ResetPasswordRequest request, CancellationToken cancellationToken)
    {
        await users.SetPasswordAsync(userId, request.Password, cancellationToken);
        return NoContent();
    }

    // A new PIN: four digits no one else has. Signs them out at the terminals.
    [HttpPut("{userId}/pin")]
    public async Task<IActionResult> ResetPin(string userId, ResetPinRequest request, CancellationToken cancellationToken)
    {
        await users.SetPinAsync(userId, request.Pin, cancellationToken);
        return NoContent();
    }
}

public sealed record UserDto(string Id, string? Email, string FullName, UserRole Role, bool IsActive, bool HasPin, bool HasPassword, string? EmployeeId,
    DateTime CreatedAtUtc, DateTime? LastSignInAtUtc, bool IsLocked)
{
    public static UserDto From(UserAccount u) =>
        new(u.Id, u.Email, u.FullName, u.Role, u.IsActive, u.HasPin, u.PasswordHash is not null, u.EmployeeId, u.CreatedAtUtc, u.LastSignInAtUtc,
            u.LockedUntilUtc > DateTime.UtcNow);
}

public sealed record CreateUserRequest(string? Email, string FullName, UserRole Role, string? Password, string? Pin);

public sealed record UpdateUserRequest(string? Email, string FullName, UserRole Role, bool IsActive);

public sealed record ResetPasswordRequest(string Password);

public sealed record ResetPinRequest(string Pin);

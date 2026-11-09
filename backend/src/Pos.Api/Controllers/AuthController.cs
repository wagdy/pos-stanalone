using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Pos.Api.Auth;
using Pos.Domain.Access;
using Pos.Infrastructure.Common;
using Pos.Infrastructure.Identity;

namespace Pos.Api.Controllers;

// Signing in: the back office with an email and password, a terminal (the till, a captain's phone,
// the kitchen screen) with a four-digit PIN.
[ApiController]
[Route("api/auth")]
public sealed class AuthController(UserDirectory users, TokenService tokens, BusinessCalendar clock) : ControllerBase
{
    public const string SignInRateLimit = "sign-in";

    // One answer for an email nobody has and a wrong password, so it does not say whose emails
    // are known.
    [AllowAnonymous]
    [EnableRateLimiting(SignInRateLimit)]
    [HttpPost("sign-in")]
    public async Task<ActionResult<SignInResponse>> SignIn(SignInRequest request, CancellationToken cancellationToken)
    {
        var outcome = await users.SignInAsync(request.Email, request.Password, cancellationToken);
        if (outcome.User is not { } user)
        {
            var detail = outcome.LockedUntilUtc is { } lockedUntil
                ? $"Too many wrong passwords. Try again after {clock.ToLocal(lockedUntil):HH:mm}."
                : "Wrong email or password.";
            return Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Sign-in failed.", detail: detail);
        }
        return Issue(user);
    }

    // A PIN finds its holder by itself: the address is limited in how fast it may try them.
    [AllowAnonymous]
    [EnableRateLimiting(SignInRateLimit)]
    [HttpPost("pin")]
    public async Task<ActionResult<SignInResponse>> SignInByPin(PinSignInRequest request, CancellationToken cancellationToken)
    {
        if (await users.SignInByPinAsync(request.Pin, cancellationToken) is not { } user)
            return Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Sign-in failed.", detail: "Wrong PIN. · الرقم السري غير صحيح.");
        return Issue(user);
    }

    // Who is signed in, and what they may do: the permissions come from RolePermissions, so the
    // app shows and hides buttons by the same rules the API enforces.
    [HttpGet("me")]
    public async Task<Me> GetMe(CancellationToken cancellationToken)
    {
        var id = UserClaims.IdOf(User)!;
        var user = await users.GetAsync(id, cancellationToken);
        return Me.For(id, user?.FullName ?? UserClaims.NameOf(User), user?.Email, UserClaims.RoleOf(User)!.Value, user?.HasPin ?? false);
    }

    // Their own password changed, with the one they have now. Signs them out elsewhere; this
    // answer brings them a new token for here.
    [HttpPost("password")]
    public async Task<SignInResponse> ChangePassword(ChangePasswordRequest request, CancellationToken cancellationToken)
    {
        var id = UserClaims.IdOf(User)!;
        await users.ChangeOwnPasswordAsync(id, request.CurrentPassword, request.NewPassword, cancellationToken);
        return Issue((await users.GetAsync(id, cancellationToken))!);
    }

    private SignInResponse Issue(UserAccount user)
    {
        var (token, expiresAtUtc) = tokens.Issue(user);
        return new SignInResponse(token, expiresAtUtc, Me.For(user.Id, user.FullName, user.Email, user.Role, user.HasPin));
    }
}

public sealed record SignInRequest(string? Email, string? Password);

public sealed record PinSignInRequest(string? Pin);

public sealed record SignInResponse(string Token, DateTime ExpiresAtUtc, Me User);

public sealed record ChangePasswordRequest(string CurrentPassword, string NewPassword);

public sealed record Me(string Id, string FullName, string? Email, UserRole Role, bool HasPin, IReadOnlyList<string> Permissions)
{
    public static Me For(string id, string fullName, string? email, UserRole role, bool hasPin) =>
        new(id, fullName, email, role, hasPin, RolePermissions.For(role).Order(StringComparer.Ordinal).ToList());
}

using System.Security.Cryptography;
using System.Text;

namespace Teas.Api.Startup;

/// <summary>/internal/v1 is reachable only through the BFF (S8): a missing or wrong X-Teas-Bff, or a secret that is not configured
/// or shorter than <see cref="MinLength"/>, is 401.</summary>
public sealed class BffSecretFilter(IConfiguration config) : IEndpointFilter
{
    public const string Header = "X-Teas-Bff";
    public const int MinLength = 32;

    public ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        var expected = config["TEAS_BFF_SECRET"];
        var given = ctx.HttpContext.Request.Headers[Header].ToString();
        var ok = expected is { Length: >= MinLength } && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(given));
        return ok ? next(ctx) : ValueTask.FromResult<object?>(Results.StatusCode(StatusCodes.Status401Unauthorized));
    }
}

using System.Security.Cryptography;
using System.Text;

namespace Teas.Api.Startup;

/// <summary>Endpoint metadata: the endpoint is reachable only through the BFF (the /internal/v1 group carries it).</summary>
public sealed class BffOnly
{
    public static readonly BffOnly Instance = new();
}

/// <summary>/internal/v1 is reachable only through the BFF (S8): a missing or wrong X-Teas-Bff, or a secret that is not configured
/// or shorter than <see cref="MinLength"/>, is 401. A middleware, so it runs BEFORE authentication and RouteAuthorization
/// (an endpoint filter would run after them): a caller without the secret learns nothing and writes no audit row.</summary>
public sealed class BffSecretMiddleware(RequestDelegate next, IConfiguration config)
{
    public const string Header = "X-Teas-Bff";
    public const int MinLength = 32;
    const string Prefix = "/internal/v1";

    public Task InvokeAsync(HttpContext http)
    {
        // fail closed both ways: the marker, or the REQUEST path under /internal/v1 (however the route was mapped; also a wrong method or an unknown path there)
        if (http.GetEndpoint()?.Metadata.GetMetadata<BffOnly>() is null && !http.Request.Path.StartsWithSegments(Prefix, StringComparison.OrdinalIgnoreCase)) return next(http);
        var expected = config["TEAS_BFF_SECRET"];
        var given = http.Request.Headers[Header].ToString();
        if (expected is { Length: >= MinLength } && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(given)))
            return next(http);
        http.Response.StatusCode = StatusCodes.Status401Unauthorized;
        return Task.CompletedTask;
    }
}

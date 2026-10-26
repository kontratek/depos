using Newtonsoft.Json.Linq;

namespace Depos.Core.Org;

public sealed record DeviceCode(
    string Code,
    string UserCode,
    string VerificationUri,
    string VerificationUriComplete,
    long ExpiresInSeconds,
    long IntervalSeconds);

public enum DevicePollKind
{
    Token,
    Denied,
    Expired,
    Cancelled,
}

public sealed record DevicePollResult(DevicePollKind Kind, string? Token = null);

/// <summary>The device flow's waits: real time in the IDE, a counter in tests.</summary>
public interface IDeviceFlowClock
{
    long Now();
    Task DelayAsync(long milliseconds, CancellationToken cancellationToken);
}

public sealed class SystemDeviceFlowClock : IDeviceFlowClock
{
    public static readonly SystemDeviceFlowClock Instance = new();

    public long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public Task DelayAsync(long milliseconds, CancellationToken cancellationToken) =>
        Task.Delay(TimeSpan.FromMilliseconds(milliseconds), cancellationToken);
}

/// <summary>
/// Sign-in to Depos with the OAuth 2.0 device flow (RFC 8628), served by Better
/// Auth's device-authorization plugin: Visual Studio shows a code, the user
/// approves it in the browser, Visual Studio collects a token. A port of
/// <c>src/ext/web/deviceFlow.ts</c>.
/// </summary>
public static class DeviceFlow
{
    /// <summary>The client id Depos accepts for this extension.</summary>
    public const string ClientId = "depos-visualstudio";
    private const string GrantType = "urn:ietf:params:oauth:grant-type:device_code";

    private static readonly IReadOnlyDictionary<string, string> JsonHeaders = new Dictionary<string, string>
    {
        ["Content-Type"] = "application/json",
        ["Accept"] = "application/json",
    };

    public static async Task<DeviceCode> RequestDeviceCodeAsync(IDeposHttp http, string origin, CancellationToken cancellationToken = default)
    {
        var body = new JObject { ["client_id"] = ClientId };
        var response = await http.SendAsync("POST", $"{origin}/api/auth/device/code", JsonHeaders, DeposJson.Write(body), cancellationToken)
            .ConfigureAwait(false);
        var json = DeposJson.Obj(DeposJson.Parse(response.Body)) ?? new JObject();
        var deviceCode = json.Str("device_code", int.MaxValue);
        var userCode = json.Str("user_code", int.MaxValue);
        if (!response.Ok || deviceCode is null || userCode is null)
            throw new DeposException($"Depos refused the sign-in (HTTP {response.Status}).");
        var verificationUri = json.Str("verification_uri", int.MaxValue) ?? $"{origin}/device";
        var interval = json.Number("interval");
        return new DeviceCode(
            deviceCode,
            userCode,
            verificationUri,
            json.Str("verification_uri_complete", int.MaxValue) ?? verificationUri,
            json.Number("expires_in") ?? 600,
            interval is > 0 ? interval.Value : 5);
    }

    /// <summary>Polls until the user approves or denies, the code expires, or the caller cancels.</summary>
    public static async Task<DevicePollResult> PollForTokenAsync(
        IDeposHttp http,
        string origin,
        DeviceCode code,
        IDeviceFlowClock clock,
        CancellationToken cancellationToken = default)
    {
        var deadline = clock.Now() + code.ExpiresInSeconds * 1000;
        var interval = code.IntervalSeconds * 1000;
        while (true)
        {
            try
            {
                await clock.DelayAsync(interval, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return new DevicePollResult(DevicePollKind.Cancelled);
            }
            if (cancellationToken.IsCancellationRequested) return new DevicePollResult(DevicePollKind.Cancelled);
            if (clock.Now() >= deadline) return new DevicePollResult(DevicePollKind.Expired);

            var body = new JObject
            {
                ["grant_type"] = GrantType,
                ["device_code"] = code.Code,
                ["client_id"] = ClientId,
            };
            HttpAnswer response;
            try
            {
                response = await http.SendAsync("POST", $"{origin}/api/auth/device/token", JsonHeaders, DeposJson.Write(body), cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return new DevicePollResult(DevicePollKind.Cancelled);
            }
            var json = DeposJson.Obj(DeposJson.Parse(response.Body)) ?? new JObject();
            var token = json.Str("access_token", int.MaxValue);
            if (response.Ok && token is not null) return new DevicePollResult(DevicePollKind.Token, token);

            switch (json.Str("error"))
            {
                case "authorization_pending":
                    continue;
                case "slow_down":
                    // RFC 8628 §3.5: add 5 seconds to the interval.
                    interval += 5000;
                    continue;
                case "access_denied":
                    return new DevicePollResult(DevicePollKind.Denied);
                case "expired_token":
                case "invalid_grant":
                    return new DevicePollResult(DevicePollKind.Expired);
                default:
                    throw new DeposException($"Depos stopped the sign-in (HTTP {response.Status}).");
            }
        }
    }
}

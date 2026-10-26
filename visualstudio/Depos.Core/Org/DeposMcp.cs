using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Depos.Core.Org;

/// <summary>
/// The MCP setup Visual Studio reads from <c>.mcp.json</c> in a solution folder,
/// for one repository: the MCP server Depos serves to agents with an MCP key. The
/// same server as the <c>.mcp.json</c> Depos shows under Settings → AI agents,
/// in Visual Studio's format: <c>servers</c>, and an <c>inputs</c> entry so
/// Visual Studio asks for the key and keeps it. It never carries a key.
/// </summary>
public static class DeposMcp
{
    public const string ServerName = "depos-notes";
    public const string KeyInput = "depos-mcp-key";

    public static string ServerUrl(string origin, string repoUlid) =>
        $"{origin}/api/mcp/repositories/{DeposUri.EncodeComponent(repoUlid)}";

    public static string VisualStudioJson(string origin, string repoUlid)
    {
        var root = new JObject
        {
            ["inputs"] = new JArray(new JObject
            {
                ["type"] = "promptString",
                ["id"] = KeyInput,
                ["description"] = "Depos MCP key (an admin adds one in Depos, under Settings → AI agents)",
                ["password"] = true,
            }),
            ["servers"] = new JObject
            {
                [ServerName] = new JObject
                {
                    ["type"] = "http",
                    ["url"] = ServerUrl(origin, repoUlid),
                    ["headers"] = new JObject { ["Authorization"] = "Bearer ${input:" + KeyInput + "}" },
                },
            },
        };
        return root.ToString(Formatting.Indented).Replace("\r\n", "\n") + "\n";
    }

    /// <summary>Where an admin adds MCP keys in Depos.</summary>
    public static string KeysPage(string origin, string orgUlid) =>
        $"{origin}/dashboard/{DeposUri.EncodeComponent(orgUlid)}/settings/ai-agents";
}

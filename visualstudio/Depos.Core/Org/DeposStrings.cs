namespace Depos.Core.Org;

/// <summary>
/// Every word the Depos connection shows in Visual Studio. The same text as the
/// org and web strings of the VS Code extension (<c>src/ext/strings.ts</c>) and
/// the JetBrains plugin (<c>DeposStrings.kt</c>), except where Visual Studio is
/// different: the Depos tool window, Tools → Options → Depos, and the MCP setup
/// it copies. Messages carry no "Pacmon:" prefix: Visual Studio shows them in a
/// Depos info bar or dialog.
/// </summary>
public static class DeposStrings
{
    // The Depos group of the tool window's settings view.
    public const string ViewGroupWeb = "Depos";
    public static string ViewWebSignedOut(string? host) =>
        $"Not signed in{(host is null ? string.Empty : " to " + host)}. Sign in to use your organization's notes and allowlist in folders it has added to Depos.";
    public static string ViewWebSignedIn(string host) => $"Signed in to {host}.";
    public const string ViewWebInvalidUrl = "The Depos address is not a valid address. Fix it in Tools → Options → Depos → General.";
    public const string ViewWebSignIn = "Sign in to Depos";
    public const string ViewWebSignInHelp = "Opens your browser. You check the code and approve the sign-in there.";
    public const string ViewWebShow = "Show connection";
    public const string ViewWebShowHelp = "Who you are signed in as, and the organization of each folder.";
    public const string ViewWebSignOut = "Sign out";
    public const string ViewWebSignOutHelp =
        "Ends the sign-in in Visual Studio and in Depos, and removes the local copy of the notes and allowlist results from Depos.";
    public const string ViewWebRefresh = "Refresh notes";
    public const string ViewWebRefreshHelp =
        "Asks Depos for what changed. This also happens at start, when Visual Studio gets focus, and every 5 minutes.";
    public const string ViewWebMcp = "Copy MCP setup";
    public const string ViewWebMcpHelp =
        "An .mcp.json for AI agents, for the repository of a folder in org mode. Visual Studio asks for an MCP key when the server starts.";

    // Connection and sign-in.
    public const string WebUrlPrompt = "Address of your Depos";
    public const string WebUrlPlaceholder = "https://depos.example.com";
    public const string WebUrlInvalid = "The Depos address is not a valid http or https address.";
    public const string WebUrlInsecure = "The Depos address must use https. Plain http is allowed only for localhost.";
    public static string WebSignInCode(string code) => $"Approve the sign-in in your browser. Check that the page shows the code {code}.";
    public const string WebOpenBrowser = "Open browser";
    public static string WebWaiting(string code) => $"Waiting for approval in the browser (code {code})";
    public static string WebSignedIn(string name, string email) => $"Signed in to Depos as {name} ({email}).";
    public const string WebDenied = "The sign-in was denied in the browser.";
    public const string WebExpired = "The sign-in code expired. Run \"Sign In to Depos\" again.";
    public const string WebSignedOut = "Signed out of Depos.";
    public const string WebNotSignedIn = "Not signed in to Depos.";
    public const string WebSessionExpired = "Your Depos sign-in has ended. Sign in again.";
    public const string WebSignIn = "Sign in";
    public static string WebUnreachable(string origin) => $"Could not reach {origin}.";
    public static string WebFolderOrg(string folder, string org, string repo) => $"{folder}: organization {org} ({repo})";
    public static string WebFolderNoOrg(string folder, string repo) => $"{folder}: {repo} is not added to any of your organizations in Depos";
    public static string WebFolderNoRemote(string folder) => $"{folder}: no GitHub remote";

    // Allowlist.
    public static string OrgDenied(string name, string org, string reason) =>
        reason.Length > 0 ? $"{name} is denied in {org}. Reason: {reason}" : $"{name} is denied in {org}.";
    public static string OrgUnlisted(string name, string org) => $"{name} is not listed in the allowlist of {org}.";
    public const string OrgResultAllowed = "Allowed";
    public const string OrgResultDenied = "Denied";
    public const string OrgResultUnlisted = "Not listed";
    public const string OrgModeAudit = "Audit";
    public const string OrgModeEnforce = "Enforce";
    public static string OrgAllowlistLine(string result, string mode) => $"Allowlist: {result} ({mode})";
    public static string OrgReason(string reason) => $"Reason: {reason}";
    public static string OrgExpires(string date) => $"Expires {date}";
    public static string OrgReceived(string time) => $"Updated from Depos at {time}";
    public const string OrgOpenWeb = "Open in Depos";

    // Notes from Depos.
    public static string OrgNotesLabel(string org) => $"notes of {org} in Depos";
    public static string OrgModeNotesFile(string org) =>
        $"You are signed in to Depos, so the notes of {org} come from Depos. This file is no longer used: delete it from the repository.";
    public const string OrgOpenOrgNotes = "Open notes from Depos";
    public const string OrgNoteReadOnly = "Only organization admins can change these notes.";
    public const string OrgNoteNotConnected = "This repository is not added to an organization in Depos.";
    public const string OrgNoteSaveFailed = "The note could not be saved to Depos. Try again.";
    public static string OrgNoteDropped(int count)
    {
        var one = count == 1;
        return $"{count} {(one ? "line" : "lines")} of the agent notes {(one ? "is" : "are")} not a field and "
            + $"{(one ? "was" : "were")} not saved. A note in Depos keeps \"- key: value\" lines only.";
    }

    // MCP: copied as Visual Studio's .mcp.json.
    public static string McpCopied(string repo) =>
        $"The MCP setup for {repo} is on your clipboard. Paste it into .mcp.json in the solution folder; Visual Studio asks for "
        + "the MCP key the first time the server starts. An admin adds keys in Depos, under Settings → AI agents.";
    public const string McpOpenKeys = "Open AI agents settings";
    public const string McpNoOrgFolder =
        "No folder of this solution is in org mode. Sign in to Depos, and add its GitHub repository to an organization there.";
    public const string McpPickFolder = "Copy the MCP setup of";
}

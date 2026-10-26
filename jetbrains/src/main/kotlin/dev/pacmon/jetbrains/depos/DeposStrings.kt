package dev.pacmon.jetbrains.depos

/**
 * Every word the Depos connection shows. The same text as the org and web strings
 * of the VS Code extension (`src/ext/strings.ts`), word for word, except where the
 * IDE is different: the Depos tool window instead of the Depos view, Settings →
 * Tools → Depos instead of a setting name, and the MCP setup, which JetBrains IDEs
 * have no API to register. Change both together.
 *
 * The connection is to a Depos server, and the text names it by its role — your
 * organization, the server — since the plugin is called Depos too.
 */
object DeposStrings {
    // ── The organization group of the tool window ────────────────────────────
    const val viewGroupWeb = "ORGANIZATION"
    fun viewWebSignedOut(host: String?): String =
        "Not signed in${if (host != null) " to $host" else ""}. Sign in to use your organization's notes and allowlist in the folders it has added."
    fun viewWebSignedIn(host: String): String = "Signed in to $host."
    const val viewWebInvalidUrl = "The server address is not a valid address. Fix it in Settings → Tools → Depos."
    const val viewWebSignIn = "Sign in"
    const val viewWebSignInHelp = "Opens your browser. You check the code and approve the sign-in there."
    const val viewWebShow = "Show connection"
    const val viewWebShowHelp = "Who you are signed in as, and the organization of each folder."
    const val viewWebSignOut = "Sign out"
    const val viewWebSignOutHelp =
        "Ends the sign-in in this IDE and on the server, and removes the local copy of your organization’s notes and allowlist results."
    const val viewWebRefresh = "Refresh notes"
    const val viewWebRefreshHelp = "Asks the server for what changed. Depos also asks at start, when the IDE gets focus, and every 5 minutes."
    const val viewWebMcp = "Copy MCP setup"
    const val viewWebMcpHelp = "An .mcp.json for AI agents, for the repository of a folder in org mode. It reads an MCP key from DEPOS_MCP_KEY."

    // ── Connection and sign-in ───────────────────────────────────────────────
    const val webUrlPrompt = "Address of your Depos server"
    const val webUrlPlaceholder = "https://depos.dev"
    const val webUrlInvalid = "Depos: the server address is not a valid http or https address."
    const val webUrlInsecure = "Depos: the server address must use https. Plain http is allowed only for localhost."
    fun webSignInCode(code: String): String = "Depos: approve the sign-in in your browser. Check that the page shows the code $code."
    const val webOpenBrowser = "Open browser"
    fun webWaiting(code: String): String = "Depos: waiting for approval in the browser (code $code)"
    fun webSignedIn(name: String, email: String): String = "Depos: signed in as $name ($email)."
    const val webDenied = "Depos: the sign-in was denied in the browser."
    const val webExpired = "Depos: the sign-in code expired. Run \"Sign In\" again."
    const val webSignedOut = "Depos: signed out."
    const val webNotSignedIn = "Depos: not signed in."
    const val webSessionExpired = "Depos: your sign-in has ended. Sign in again."
    const val webSignIn = "Sign in"
    fun webUnreachable(origin: String): String = "Depos: could not reach $origin."
    fun webFolderOrg(folder: String, org: String, repo: String): String = "$folder: organization $org ($repo)"
    fun webFolderNoOrg(folder: String, repo: String): String = "$folder: $repo is not added to any of your organizations"
    fun webFolderNoRemote(folder: String): String = "$folder: no GitHub remote"

    // ── Allowlist ────────────────────────────────────────────────────────────
    fun orgDenied(name: String, org: String, reason: String): String =
        if (reason.isNotEmpty()) "$name is denied in $org. Reason: $reason" else "$name is denied in $org."
    fun orgUnlisted(name: String, org: String): String = "$name is not listed in the allowlist of $org."
    const val orgResultAllowed = "Allowed"
    const val orgResultDenied = "Denied"
    const val orgResultUnlisted = "Not listed"
    const val orgModeAudit = "Audit"
    const val orgModeEnforce = "Enforce"
    fun orgAllowlistLine(result: String, mode: String): String = "Allowlist: $result ($mode)"
    fun orgReason(reason: String): String = "Reason: $reason"
    fun orgExpires(date: String): String = "Expires $date"
    fun orgReceived(time: String): String = "Updated from Depos at $time"
    const val orgOpenWeb = "Open in Depos"

    // ── Notes from Depos ─────────────────────────────────────────────────────
    fun orgNotesLabel(org: String): String = "notes of $org in Depos"
    fun orgModeNotesFile(org: String): String =
        "You are signed in, so Depos uses the notes of $org. This file is no longer used: delete it from the repository."
    const val orgOpenOrgNotes = "Open notes from Depos"
    const val orgNoteReadOnly = "Only organization admins can change these notes."
    const val orgNoteNotConnected = "This repository is not added to an organization in Depos."
    const val orgNoteSaveFailed = "Depos: the note could not be saved to your organization. Try again."
    fun orgNoteDropped(count: Int): String {
        val one = count == 1
        return "Depos: $count ${if (one) "line" else "lines"} of the agent notes ${if (one) "is" else "are"} not a field and " +
            "${if (one) "was" else "were"} not saved. An organization note keeps \"- key: value\" lines only."
    }

    // ── MCP: copied, since JetBrains IDEs have no API to register a server ───
    fun mcpCopied(repo: String): String =
        "Depos: the MCP setup for $repo is on your clipboard, as .mcp.json. It reads the key from the DEPOS_MCP_KEY " +
            "environment variable: an admin adds one in Depos, under Settings → AI agents."
    const val mcpOpenKeys = "Open AI agents settings"
    const val mcpNoOrgFolder =
        "Depos: no folder of this project is in org mode. Sign in, and add its GitHub repository to one of your organizations."
    const val mcpPickFolder = "Copy the MCP setup of"
}

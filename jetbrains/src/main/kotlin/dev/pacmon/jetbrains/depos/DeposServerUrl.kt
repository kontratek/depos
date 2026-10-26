package dev.pacmon.jetbrains.depos

import java.net.URI
import java.net.URISyntaxException

/**
 * The address of the Depos server, from the "Server address" setting. A port of
 * `src/ext/web/serverUrl.ts`: only the origin is kept, and plain http is allowed
 * only for this machine.
 */
object DeposServerUrl {
    /** The public Depos. The same default as the VS Code setting. */
    const val DEFAULT = "https://depos.dev"

    enum class Problem { EMPTY, INVALID, INSECURE }

    sealed interface Parsed {
        data class Ok(val origin: String) : Parsed
        data class Bad(val problem: Problem) : Parsed
    }

    private val localHosts = setOf("localhost", "127.0.0.1", "[::1]")

    fun parse(raw: String?): Parsed {
        val value = raw?.trim().orEmpty()
        if (value.isEmpty()) return Parsed.Bad(Problem.EMPTY)
        val uri = try {
            URI(value)
        } catch (_: URISyntaxException) {
            return Parsed.Bad(Problem.INVALID)
        }
        val scheme = uri.scheme?.lowercase() ?: return Parsed.Bad(Problem.INVALID)
        if (scheme != "http" && scheme != "https") return Parsed.Bad(Problem.INVALID)
        if (uri.rawUserInfo != null) return Parsed.Bad(Problem.INVALID)
        val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return Parsed.Bad(Problem.INVALID)
        if (scheme == "http" && host !in localHosts) return Parsed.Bad(Problem.INSECURE)
        val defaultPort = if (scheme == "https") 443 else 80
        val port = if (uri.port == -1 || uri.port == defaultPort) "" else ":${uri.port}"
        return Parsed.Ok("$scheme://$host$port")
    }

    /** `host[:port]` of an origin, for the status line. */
    fun host(origin: String): String = origin.substringAfter("://")

    private val pacmonOrigin = Regex("^https://(?:www\\.)?pacmon\\.dev(?=/|$)", RegexOption.IGNORE_CASE)

    /**
     * depos.dev was pacmon.dev before Pacmon became Depos: an address saved then
     * still works. A port of `renamedServerUrl` (`src/ext/web/serverUrl.ts`).
     */
    fun renamed(url: String): String = url.replace(pacmonOrigin, "https://depos.dev")
}

package dev.pacmon.jetbrains.depos

import java.nio.file.Files
import java.nio.file.Path

/**
 * The GitHub repository of a project root, from its `.git/config`. A port of
 * `src/ext/web/gitRemote.ts` and of `workspaceRepository` in `webConnection.ts`.
 * Depos matches it to a repository of an organization. GitHub only, like Depos.
 */
object GitRemote {
    private val remoteHeader = Regex("^\\[remote\\s+\"([^\"]+)\"\\]$")
    private val urlLine = Regex("^url\\s*=\\s*(.+)$")
    private val gitdirLine = Regex("^gitdir:\\s*(.+)$", RegexOption.MULTILINE)
    private val absolutePath = Regex("^([a-zA-Z]:)?[\\\\/]")
    private val githubPatterns = listOf(
        Regex("^https?://(?:[^@/]+@)?github\\.com/([^/]+)/([^/]+?)(?:\\.git)?/?$", RegexOption.IGNORE_CASE),
        Regex("^(?:ssh://)?git@github[\\w.-]*[:/](?:\\d+/)?([^/]+)/([^/]+?)(?:\\.git)?/?$", RegexOption.IGNORE_CASE),
    )

    /** URL of `[remote "origin"]`, else of the first remote, else null. */
    fun remoteUrlFromGitConfig(configText: String): String? {
        data class Remote(val name: String, var url: String? = null)
        val remotes = mutableListOf<Remote>()
        var current: Remote? = null
        for (rawLine in configText.split(Regex("\\r?\\n"))) {
            val line = rawLine.trim()
            if (line.startsWith("[")) {
                current = remoteHeader.matchEntire(line)?.let { Remote(it.groupValues[1]) }
                current?.let(remotes::add)
                continue
            }
            val remote = current ?: continue
            if (remote.url != null) continue
            urlLine.matchEntire(line)?.let { remote.url = it.groupValues[1].trim() }
        }
        return (remotes.firstOrNull { it.name == "origin" } ?: remotes.firstOrNull())?.url
    }

    /**
     * `owner/name` of a github.com remote URL (https or ssh), else null. An ssh host
     * alias that starts with `github` (`github-work`, `github.com-work`) counts too:
     * a wrong guess costs nothing, Depos answers 404 for anything that is not one of
     * the user's repositories.
     */
    fun githubFullName(remoteUrl: String): String? {
        val value = remoteUrl.trim()
        for (pattern in githubPatterns) {
            val match = pattern.matchEntire(value) ?: continue
            return "${match.groupValues[1]}/${match.groupValues[2]}"
        }
        return null
    }

    /** `owner/name` of the root's GitHub remote. Follows a `.git` file (worktree, submodule). */
    fun repositoryOf(root: Path): String? {
        val config = readGitConfig(root) ?: return null
        return remoteUrlFromGitConfig(config)?.let(::githubFullName)
    }

    private fun readGitConfig(root: Path): String? {
        try {
            val dotGit = root.resolve(".git")
            var gitDir = dotGit
            if (Files.isRegularFile(dotGit)) {
                // "gitdir: <path>": a worktree or a submodule. Its config is in the common dir.
                val pointer = gitdirLine.find(Files.readString(dotGit))?.groupValues?.get(1)?.trim()
                if (pointer.isNullOrEmpty()) return null
                gitDir = if (absolutePath.containsMatchIn(pointer)) Path.of(pointer) else root.resolve(pointer)
                val commonDir = gitDir.resolve("commondir")
                if (Files.isRegularFile(commonDir)) {
                    val common = Files.readString(commonDir).trim()
                    if (common.isNotEmpty()) gitDir = gitDir.resolve(common)
                }
            }
            val config = gitDir.resolve("config")
            return if (Files.isRegularFile(config)) Files.readString(config) else null
        } catch (_: Exception) {
            return null
        }
    }
}

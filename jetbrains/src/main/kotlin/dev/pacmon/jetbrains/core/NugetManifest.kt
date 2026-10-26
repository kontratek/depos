package dev.pacmon.jetbrains.core

object NugetManifestAdapter : ManifestAdapter {
    override val kind = ManifestKind.NUGET
    override val fileNames = listOf("Directory.Packages.props")
    override val discoveryGlobs = listOf("**/*.csproj", "**/*.fsproj", "**/*.vbproj", "**/Directory.Packages.props")
    override val notesRelativePath = ".depos/nuget/DEPENDENCY-NOTES.md"

    private val projectExtensions = listOf(".csproj", ".fsproj", ".vbproj")
    private val packageId = Regex("^[A-Za-z0-9][A-Za-z0-9._-]*$")

    override fun matchesPath(path: String): Boolean {
        val name = basename(path)
        val lower = name.lowercase()
        return name == "Directory.Packages.props" || projectExtensions.any(lower::endsWith)
    }

    override fun normalizeNoteKey(raw: String): String = ManifestRegistry.stripName(raw).lowercase()

    override fun extractDependencies(text: String): List<DependencyEntry> =
        extractDependencies(text, "project.csproj")

    override fun extractDependencies(text: String, path: String): List<DependencyEntry> {
        val nodes = descendants(parseXml(text))
        if (basename(path) == "Directory.Packages.props") {
            return nodes.flatMap { node ->
                when (node.name) {
                    "PackageVersion" -> {
                        val attribute = if (xmlAttribute(node, "Include") != null) "Include" else "Update"
                        entry(node, attribute, "centralVersion")?.let(::listOf).orEmpty()
                    }
                    "GlobalPackageReference" -> entry(node, "Include", "globalPackageReference")
                        ?.let(::listOf).orEmpty()
                    else -> emptyList()
                }
            }
        }
        return nodes.flatMap { node ->
            if (node.name != "PackageReference" || xmlAttribute(node, "Include") == null) emptyList()
            else entry(node, "Include", "packageReference")?.let(::listOf).orEmpty()
        }
    }

    private fun entry(node: XmlNode, attributeName: String, scope: String): DependencyEntry? {
        if (xmlAttribute(node, "Remove") != null) return null
        val attribute = xmlAttribute(node, attributeName) ?: return null
        if (!packageId.matches(attribute.value)) return null
        return dependencyEntry(
            attribute.value,
            scope,
            attribute.range,
            listOf(attribute.range),
            attribute.value,
            SourceRange(node.openStart, 1),
        )
    }

    private fun descendants(roots: List<XmlNode>): List<XmlNode> = buildList {
        fun visit(node: XmlNode) {
            add(node)
            node.children.forEach(::visit)
        }
        roots.forEach(::visit)
    }

    private fun basename(path: String): String = path.replace('\\', '/').substringAfterLast('/')
}

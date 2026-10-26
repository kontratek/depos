package dev.pacmon.jetbrains.settings

/**
 * The values the Depos tool window and the Settings page may write, and the
 * words next to them. The VS Code extension keeps the same vocabulary in
 * its settings (`depos.noteButtons`, `depos.decorations`,
 * `depos.noteEntry`, `depos.inlineSource`) and the same help text in
 * `src/ext/strings.ts`; both editors are meant to offer the same choices under
 * the same names, so a note written in one reads the same in the other.
 *
 * The gestures differ on purpose. VS Code needs Ctrl+click for a document link
 * and an inlay hint; in the IntelliJ platform the inlay presentations take a
 * plain click, and only the package name itself — which is a go-to-declaration
 * target — needs the modifier.
 */
object NoteButtons {
    const val ICON_LEFT = "iconLeft"
    const val LINK = "link"
    const val CODE_LENS = "codelens"
    const val INLAY_HINT = "inlayHint"
    const val LIGHTBULB = "lightbulb"

    val ALL = listOf(ICON_LEFT, LINK, CODE_LENS, INLAY_HINT, LIGHTBULB)
    val DEFAULT = listOf(ICON_LEFT, LINK)

    fun label(id: String): String = when (id) {
        ICON_LEFT -> "Icon before the dependency"
        LINK -> "The package name"
        CODE_LENS -> "Line above the dependency"
        INLAY_HINT -> "Chip at end of line"
        LIGHTBULB -> "Lightbulb on the cursor line"
        else -> id
    }

    fun gesture(id: String): String = when (id) {
        LINK -> "Ctrl+click"
        LIGHTBULB -> "Alt+Enter"
        else -> "click"
    }

    fun help(id: String): String = when (id) {
        ICON_LEFT ->
            "The Depos mark before the dependency — filled when it has a note, " +
                "hollow when it does not. The mouse turns into a hand over it."
        LINK -> "The package name itself opens its note. Adds nothing to the file."
        CODE_LENS -> "Unmissable — and it roughly doubles the apparent height of the manifest."
        INLAY_HINT -> "Spelled out at the end of the line, where it competes with the note preview."
        LIGHTBULB -> "The quietest option: nothing is drawn until the caret is on the line."
        else -> ""
    }
}

object Decorations {
    const val PREVIEW = "preview"
    const val BADGE = "badge"
    const val OFF = "off"

    val ALL = listOf(PREVIEW, BADGE, OFF)

    fun help(value: String): String = when (value) {
        PREVIEW -> "Show the first line of the note at end of line."
        BADGE -> "Show a plain marker instead of the note text."
        OFF -> "No end-of-line hint at all."
        else -> ""
    }
}

object NoteEntries {
    const val PANEL = "panel"
    const val PEEK = "peek"

    val ALL = listOf(PANEL, PEEK)

    fun help(value: String): String = when (value) {
        PANEL -> "The note editor in the Depos tool window (default)."
        PEEK -> "A popup editor over the dependency line."
        else -> ""
    }
}

object InlineSources {
    const val HUMAN_FIRST = "human-first"
    const val AI_FIRST = "ai-first"
    const val HUMAN_ONLY = "human-only"
    const val AI_ONLY = "ai-only"

    val ALL = listOf(HUMAN_FIRST, AI_FIRST, HUMAN_ONLY, AI_ONLY)

    fun help(value: String): String = when (value) {
        HUMAN_FIRST -> "What people wrote; the agent's purpose line when there is none."
        AI_FIRST -> "The agent's purpose line; what people wrote when there is none."
        HUMAN_ONLY -> "Only what people wrote."
        AI_ONLY -> "Only what agents wrote."
        else -> ""
    }
}

object MonorepoModes {
    const val NEAREST = "nearest"
    const val ROOT_ONLY = "rootOnly"

    val ALL = listOf(NEAREST, ROOT_ONLY)
}

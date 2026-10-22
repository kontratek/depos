package dev.pacmon.jetbrains.depos

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParseException
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive

/**
 * Checks for JSON from Depos: it is untrusted input. A port of `src/ext/web/json.ts`,
 * with the same limits. No platform import beyond Gson, so it is unit tested.
 */
internal object DeposJson {
    const val TEXT = 100_000
    const val SHORT = 1_000
    const val ITEMS = 50_000

    /** The parsed body, or null when it is not JSON at all. */
    fun parse(text: String?): JsonElement? {
        if (text.isNullOrBlank()) return null
        return try {
            JsonParser.parseString(text)
        } catch (_: JsonParseException) {
            null
        } catch (_: IllegalStateException) {
            null
        }
    }

    fun obj(value: JsonElement?): JsonObject? = value as? JsonObject

    /** A string element of an array, of at most [max] characters. */
    fun stringOf(value: JsonElement?, max: Int = SHORT): String? {
        val primitive = value as? JsonPrimitive ?: return null
        return if (primitive.isString) primitive.asString.takeIf { it.length <= max } else null
    }

    /** A string of at most [max] characters; null for anything else, a missing key included. */
    fun JsonObject.str(name: String, max: Int = SHORT): String? {
        val value = get(name) as? JsonPrimitive ?: return null
        if (!value.isString) return null
        return value.asString.takeIf { it.length <= max }
    }

    fun JsonObject.bool(name: String): Boolean? {
        val value = get(name) as? JsonPrimitive ?: return null
        return if (value.isBoolean) value.asBoolean else null
    }

    fun JsonObject.number(name: String): Long? {
        val value = get(name) as? JsonPrimitive ?: return null
        return if (value.isNumber) value.asDouble.toLong() else null
    }

    fun JsonObject.list(name: String): JsonArray? = (get(name) as? JsonArray)?.takeIf { it.size() <= ITEMS }

    /** The key is present and holds `null`, which is not the same as missing. */
    fun JsonObject.isNull(name: String): Boolean = has(name) && get(name).isJsonNull

    /** One map key per package: ecosystem and note key. */
    fun lookupKey(ecosystem: String, noteKey: String): String = "$ecosystem\u0000$noteKey"
}

/** JavaScript's `encodeURIComponent`, so paths and queries match what the VS Code extension sends. */
internal fun encodeUriComponent(value: String): String {
    val unreserved = "-_.!~*'()"
    val out = StringBuilder()
    for (byte in value.toByteArray(Charsets.UTF_8)) {
        val char = (byte.toInt() and 0xFF).toChar()
        if (char in 'A'..'Z' || char in 'a'..'z' || char in '0'..'9' || char in unreserved) {
            out.append(char)
        } else {
            out.append('%').append("%02X".format(byte.toInt() and 0xFF))
        }
    }
    return out.toString()
}

/** `URLSearchParams` encoding: like a form, spaces as `+`. */
internal fun encodeQuery(params: List<Pair<String, String>>): String = params.joinToString("&") { (key, value) ->
    "${java.net.URLEncoder.encode(key, Charsets.UTF_8)}=${java.net.URLEncoder.encode(value, Charsets.UTF_8)}"
}

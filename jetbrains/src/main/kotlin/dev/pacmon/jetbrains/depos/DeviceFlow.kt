package dev.pacmon.jetbrains.depos

import com.google.gson.JsonObject
import dev.pacmon.jetbrains.depos.DeposJson.number
import dev.pacmon.jetbrains.depos.DeposJson.str

/** One HTTP answer: status, body text and the headers this plugin reads (lower-case names). */
data class HttpAnswer(val status: Int, val body: String, val headers: Map<String, String> = emptyMap()) {
    val ok: Boolean get() = status in 200..299
}

/** The network, as the Depos code sees it: a fake in tests, `java.net.http` in the IDE. */
fun interface DeposHttp {
    fun send(method: String, url: String, headers: Map<String, String>, body: String?): HttpAnswer
}

/** A message for the user, from a refused sign-in or write. */
class DeposException(message: String) : RuntimeException(message)

/**
 * Sign-in to Depos with the OAuth 2.0 device flow (RFC 8628), served by Better
 * Auth's device-authorization plugin: the IDE shows a code, the user approves it in
 * the browser, the IDE collects a token. A port of `src/ext/web/deviceFlow.ts`.
 */
object DeviceFlow {
    /** The client id Depos accepts for this plugin. */
    const val CLIENT_ID = "depos-jetbrains"
    private const val GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"
    private val jsonHeaders = mapOf("Content-Type" to "application/json", "Accept" to "application/json")

    data class DeviceCode(
        val deviceCode: String,
        val userCode: String,
        val verificationUri: String,
        val verificationUriComplete: String,
        val expiresInSeconds: Long,
        val intervalSeconds: Long,
    )

    sealed interface PollResult {
        data class Token(val token: String) : PollResult
        data object Denied : PollResult
        data object Expired : PollResult
        data object Cancelled : PollResult
    }

    interface Clock {
        fun sleep(ms: Long)
        fun now(): Long
        fun isCancelled(): Boolean
    }

    fun requestDeviceCode(http: DeposHttp, origin: String): DeviceCode {
        val body = JsonObject().apply { addProperty("client_id", CLIENT_ID) }
        val response = http.send("POST", "$origin/api/auth/device/code", jsonHeaders, body.toString())
        val json = DeposJson.obj(DeposJson.parse(response.body)) ?: JsonObject()
        val deviceCode = json.str("device_code", Int.MAX_VALUE)
        val userCode = json.str("user_code", Int.MAX_VALUE)
        if (!response.ok || deviceCode == null || userCode == null) {
            throw DeposException("Depos refused the sign-in (HTTP ${response.status}).")
        }
        val verificationUri = json.str("verification_uri", Int.MAX_VALUE) ?: "$origin/device"
        val interval = json.number("interval")
        return DeviceCode(
            deviceCode = deviceCode,
            userCode = userCode,
            verificationUri = verificationUri,
            verificationUriComplete = json.str("verification_uri_complete", Int.MAX_VALUE) ?: verificationUri,
            expiresInSeconds = json.number("expires_in") ?: 600,
            intervalSeconds = interval?.takeIf { it > 0 } ?: 5,
        )
    }

    /** Polls until the user approves or denies, the code expires, or the caller cancels. */
    fun pollForToken(http: DeposHttp, origin: String, code: DeviceCode, clock: Clock): PollResult {
        val deadline = clock.now() + code.expiresInSeconds * 1000
        var intervalMs = code.intervalSeconds * 1000
        while (true) {
            clock.sleep(intervalMs)
            if (clock.isCancelled()) return PollResult.Cancelled
            if (clock.now() >= deadline) return PollResult.Expired

            val body = JsonObject().apply {
                addProperty("grant_type", GRANT_TYPE)
                addProperty("device_code", code.deviceCode)
                addProperty("client_id", CLIENT_ID)
            }
            val response = http.send("POST", "$origin/api/auth/device/token", jsonHeaders, body.toString())
            val json = DeposJson.obj(DeposJson.parse(response.body)) ?: JsonObject()
            val token = json.str("access_token", Int.MAX_VALUE)
            if (response.ok && token != null) return PollResult.Token(token)

            when (json.str("error")) {
                "authorization_pending" -> continue
                // RFC 8628 §3.5: add 5 seconds to the interval.
                "slow_down" -> intervalMs += 5000
                "access_denied" -> return PollResult.Denied
                "expired_token", "invalid_grant" -> return PollResult.Expired
                else -> throw DeposException("Depos stopped the sign-in (HTTP ${response.status}).")
            }
        }
    }
}

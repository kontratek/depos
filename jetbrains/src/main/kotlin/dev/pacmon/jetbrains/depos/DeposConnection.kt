package dev.pacmon.jetbrains.depos

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.BrowserUtil
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.util.messages.Topic
import com.intellij.util.net.JdkProxyProvider
import com.intellij.util.net.ssl.CertificateManager
import dev.pacmon.jetbrains.depos.DeposJson.str
import java.net.ConnectException
import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Path
import java.time.Duration

/** Fired when a token is stored or removed, or the address changes: org mode is fetched again. */
interface DeposConnectionListener {
    fun connectionChanged()

    /** The token state was read for the first time: only the tool window's status line follows. */
    fun statusKnown() = Unit

    companion object {
        @JvmField
        val TOPIC: Topic<DeposConnectionListener> = Topic.create("Pacmon Depos connection", DeposConnectionListener::class.java)
    }
}

/** What a GET for org mode answered. */
sealed interface FetchResult {
    data object SignedOut : FetchResult
    data class Status(val origin: String, val status: Int) : FetchResult
    data class Unchanged(val origin: String) : FetchResult
    data class Ok(val origin: String, val body: JsonElement?, val etag: String?) : FetchResult
}

/** What a write for org mode answered. */
sealed interface SendResult {
    data object SignedOut : SendResult
    data class Ok(val status: Int, val body: JsonElement?) : SendResult
    data class Status(val status: Int, val message: String?) : SendResult
}

data class DeposCredentials(val origin: String, val token: String)

/**
 * The optional connection to Depos, the web app that holds an organization's org
 * notes. A port of `src/ext/web/webConnection.ts`. Signed out, nothing here makes a
 * network request. Signed in, the actions and org mode ([OrgContext]) do. The token
 * lives in the IDE's password safe, one per server origin, and is never logged.
 *
 * Application-wide, like the VS Code setting (`scope: application`): one Depos for
 * every project.
 */
@Service(Service.Level.APP)
@State(name = "PacmonDepos", storages = [Storage("pacmon.xml")])
class DeposConnection : PersistentStateComponent<DeposConnection.Settings> {
    data class Settings(var url: String = DeposServerUrl.DEFAULT)

    private var settings = Settings()
    private val log = logger<DeposConnection>()

    /** Whether a token is stored for the configured server, as last read; null until read once. */
    @Volatile
    var signedIn: Boolean? = null
        private set

    /** The network. Replaced in tests. */
    @Volatile
    internal var http: DeposHttp = DeposHttp(::sendHttp)

    private val client: HttpClient by lazy {
        // The IDE's proxy and certificate settings, so a corporate proxy or a
        // self-signed Depos works the same as everywhere else in the IDE.
        HttpClient.newBuilder()
            // HTTP/1.1 only: over plain http the client otherwise asks to upgrade to
            // HTTP/2 (h2c), and a Node dev server answers that with nothing at all.
            .version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(TIMEOUT)
            .proxy(JdkProxyProvider.getInstance().proxySelector)
            .authenticator(JdkProxyProvider.getInstance().authenticator)
            .sslContext(CertificateManager.getInstance().sslContext)
            .build()
    }

    override fun getState(): Settings = settings

    override fun loadState(state: Settings) {
        settings = state
    }

    /** The setting; the local default until it is changed. An empty value asks at sign-in. */
    var url: String
        get() = settings.url
        set(value) {
            if (value == settings.url) return
            settings.url = value
            signedIn = null
            changed()
        }

    /** What the tool window shows, from the setting and the last known token state: no request. */
    data class Status(val host: String?, val invalid: Boolean, val signedIn: Boolean)

    fun status(): Status {
        val parsed = DeposServerUrl.parse(url)
        if (parsed !is DeposServerUrl.Parsed.Ok) {
            return Status(null, (parsed as DeposServerUrl.Parsed.Bad).problem != DeposServerUrl.Problem.EMPTY, false)
        }
        val known = signedIn
        if (known == null) ApplicationManager.getApplication().executeOnPooledThread { credentials() }
        return Status(DeposServerUrl.host(parsed.origin), false, known == true)
    }

    // ── Token ────────────────────────────────────────────────────────────────

    private fun attributes(origin: String) = CredentialAttributes(generateServiceName("Pacmon Depos", origin), origin)

    /** The configured origin and its token, without asking anything. null while signed out. Off the UI thread. */
    fun credentials(): DeposCredentials? {
        val parsed = DeposServerUrl.parse(url) as? DeposServerUrl.Parsed.Ok ?: return null
        val token = PasswordSafe.instance.getPassword(attributes(parsed.origin))?.takeIf { it.isNotEmpty() }
        noteSignedIn(token != null)
        return token?.let { DeposCredentials(parsed.origin, it) }
    }

    private fun storeToken(origin: String, token: String?) {
        PasswordSafe.instance.setPassword(attributes(origin), token)
        noteSignedIn(token != null)
        changed()
    }

    private fun noteSignedIn(value: Boolean) {
        val before = signedIn
        signedIn = value
        // The first read after a start or an address change: the tool window waits for it.
        if (before == null) {
            ApplicationManager.getApplication().invokeLater {
                ApplicationManager.getApplication().messageBus.syncPublisher(DeposConnectionListener.TOPIC).statusKnown()
            }
        }
    }

    private fun changed() {
        ApplicationManager.getApplication().invokeLater { publish() }
    }

    private fun publish() {
        ApplicationManager.getApplication().messageBus.syncPublisher(DeposConnectionListener.TOPIC).connectionChanged()
    }

    // ── Requests for org mode ────────────────────────────────────────────────

    private fun authHeaders(token: String) = mapOf("Authorization" to "Bearer $token", "Accept" to "application/json")

    private fun sessionEnded(origin: String) {
        storeToken(origin, null)
        log.info("depos: sign-in at $origin ended (401)")
    }

    /**
     * A GET for org mode. With [etag], an unchanged answer is a 304 and has no body.
     * A 401 removes the token: the sign-in has ended. Off the UI thread.
     */
    fun fetchJson(path: String, etag: String? = null): FetchResult {
        val creds = credentials() ?: return FetchResult.SignedOut
        val headers = authHeaders(creds.token).toMutableMap()
        if (etag != null) headers["If-None-Match"] = etag
        val answer = http.send("GET", "${creds.origin}$path", headers, null)
        if (answer.status == 401) {
            sessionEnded(creds.origin)
            return FetchResult.SignedOut
        }
        if (answer.status == 304) return FetchResult.Unchanged(creds.origin)
        if (!answer.ok) return FetchResult.Status(creds.origin, answer.status)
        return FetchResult.Ok(creds.origin, DeposJson.parse(answer.body), answer.headers["etag"])
    }

    /**
     * A write for org mode (save or delete an org note). A refused write carries the
     * server's message, which is written for users. Off the UI thread.
     */
    fun sendJson(method: String, path: String, body: JsonElement? = null): SendResult {
        val creds = credentials() ?: return SendResult.SignedOut
        val headers = authHeaders(creds.token).toMutableMap()
        if (body != null) headers["Content-Type"] = "application/json"
        val answer = http.send(method, "${creds.origin}$path", headers, body?.toString())
        if (answer.status == 401) {
            sessionEnded(creds.origin)
            return SendResult.SignedOut
        }
        val json = DeposJson.parse(answer.body)
        if (answer.ok) return SendResult.Ok(answer.status, json)
        val message = DeposJson.obj(json)?.str("message", Int.MAX_VALUE)?.take(300)
        return SendResult.Status(answer.status, message)
    }

    /** The `localhost` address that answered last, tried first next time. */
    @Volatile
    private var localhostAddress: String? = null

    /**
     * `localhost` is tried at each of its addresses in turn. The JDK's client connects
     * to the first one only, which is usually 127.0.0.1, while a local Depos may
     * listen on ::1 alone — what Node does by default on Windows.
     */
    private fun sendHttp(method: String, url: String, headers: Map<String, String>, body: String?): HttpAnswer {
        val uri = URI(url)
        if (uri.host?.lowercase() != "localhost") return sendTo(uri, method, headers, body)
        val candidates = localhostCandidates(uri, InetAddress.getAllByName("localhost").toList(), localhostAddress)
        var failure: ConnectException? = null
        for ((literal, target) in candidates) {
            try {
                return sendTo(target, method, headers, body).also { localhostAddress = literal }
            } catch (error: ConnectException) {
                failure = error
            }
        }
        throw failure ?: ConnectException("localhost has no address")
    }

    private fun sendTo(uri: URI, method: String, headers: Map<String, String>, body: String?): HttpAnswer {
        val builder = HttpRequest.newBuilder(uri).timeout(TIMEOUT)
        headers.forEach { (name, value) -> builder.header(name, value) }
        val publisher = if (body == null) HttpRequest.BodyPublishers.noBody() else HttpRequest.BodyPublishers.ofString(body)
        builder.method(method, publisher)
        val response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString(Charsets.UTF_8))
        val read = mutableMapOf<String, String>()
        response.headers().firstValue("etag").ifPresent { read["etag"] = it }
        return HttpAnswer(response.statusCode(), response.body().orEmpty(), read)
    }

    // ── Sign-in, sign-out, connection ────────────────────────────────────────

    /** The configured origin, after telling the user what is wrong with it. On the UI thread. */
    private fun origin(project: Project?, promptIfEmpty: Boolean): String? {
        var raw = url
        if (raw.isBlank() && promptIfEmpty) {
            raw = Messages.showInputDialog(project, "${DeposStrings.webUrlPrompt}, such as ${DeposStrings.webUrlPlaceholder}", "Pacmon", null, "", null)
                ?.takeIf { it.isNotBlank() }
                ?: return null
            (DeposServerUrl.parse(raw) as? DeposServerUrl.Parsed.Ok)?.let { url = it.origin }
        }
        return when (val parsed = DeposServerUrl.parse(raw)) {
            is DeposServerUrl.Parsed.Ok -> parsed.origin
            is DeposServerUrl.Parsed.Bad -> {
                when (parsed.problem) {
                    DeposServerUrl.Problem.INVALID -> notify(project, DeposStrings.webUrlInvalid, NotificationType.ERROR)
                    DeposServerUrl.Problem.INSECURE -> notify(project, DeposStrings.webUrlInsecure, NotificationType.ERROR)
                    DeposServerUrl.Problem.EMPTY -> Unit
                }
                null
            }
        }
    }

    /** The device flow: a code, the browser, a cancellable wait. On the UI thread. */
    fun signIn(project: Project?) {
        val origin = origin(project, promptIfEmpty = true) ?: return
        object : Task.Backgroundable(project, "Pacmon: signing in to Depos", true) {
            override fun run(indicator: ProgressIndicator) {
                val code = try {
                    DeviceFlow.requestDeviceCode(http, origin)
                } catch (error: Exception) {
                    log.warn("depos: sign-in at $origin could not start", error)
                    notify(project, error.message.takeIf { error is DeposException } ?: DeposStrings.webUnreachable(origin), NotificationType.ERROR)
                    return
                }
                log.info("depos: sign-in started at $origin")
                BrowserUtil.browse(code.verificationUriComplete)
                // The browser may not open (remote session, blocked): the action opens it again.
                notify(project, DeposStrings.webSignInCode(code.userCode), NotificationType.INFORMATION, DeposStrings.webOpenBrowser) {
                    BrowserUtil.browse(code.verificationUriComplete)
                }
                indicator.text = DeposStrings.webWaiting(code.userCode)
                val result = try {
                    DeviceFlow.pollForToken(http, origin, code, IndicatorClock(indicator))
                } catch (error: Exception) {
                    log.warn("depos: sign-in at $origin stopped", error)
                    notify(project, error.message.takeIf { error is DeposException } ?: DeposStrings.webUnreachable(origin), NotificationType.ERROR)
                    return
                }
                when (result) {
                    DeviceFlow.PollResult.Denied -> notify(project, DeposStrings.webDenied, NotificationType.WARNING)
                    DeviceFlow.PollResult.Expired -> notify(project, DeposStrings.webExpired, NotificationType.WARNING)
                    DeviceFlow.PollResult.Cancelled -> Unit
                    is DeviceFlow.PollResult.Token -> {
                        storeToken(origin, result.token)
                        log.info("depos: signed in at $origin")
                        showConnectionNow(project, origin, result.token)
                    }
                }
            }
        }.queue()
    }

    fun signOut(project: Project?) {
        val origin = origin(project, promptIfEmpty = false) ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            val token = PasswordSafe.instance.getPassword(attributes(origin))
            if (token.isNullOrEmpty()) {
                notify(project, DeposStrings.webNotSignedIn, NotificationType.INFORMATION)
                return@executeOnPooledThread
            }
            try {
                // Ends the session on the server too, so the token stops working everywhere.
                http.send("POST", "$origin/api/extension/sign-out", mapOf("Authorization" to "Bearer $token"), null)
            } catch (error: Exception) {
                // The local token is removed anyway; the server session then ends at its expiry.
                log.warn("depos: sign-out request failed", error)
            }
            storeToken(origin, null)
            log.info("depos: signed out of $origin")
            notify(project, DeposStrings.webSignedOut, NotificationType.INFORMATION)
        }
    }

    /** Who is signed in, and which organization each project root belongs to. */
    fun showConnection(project: Project?) {
        val origin = origin(project, promptIfEmpty = false)
        if (origin == null) {
            notify(project, DeposStrings.webNotSignedIn, NotificationType.INFORMATION)
            return
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            val token = PasswordSafe.instance.getPassword(attributes(origin))
            if (token.isNullOrEmpty()) {
                notify(project, DeposStrings.webNotSignedIn, NotificationType.INFORMATION, DeposStrings.webSignIn) { signIn(project) }
            } else {
                showConnectionNow(project, origin, token)
            }
        }
    }

    private fun showConnectionNow(project: Project?, origin: String, token: String) {
        try {
            val session = get(origin, token, "/api/extension/session")
            val user = (session.second as? JsonObject)?.get("user") as? JsonObject
            val name = user?.str("name")
            val email = user?.str("email")
            if (name == null || email == null) throw DeposException("GET /api/extension/session answered HTTP ${session.first}")
            val lines = mutableListOf<String>()
            for ((folder, root) in project?.let { OrgContext.getInstance(it).roots() }.orEmpty()) {
                val repo = GitRemote.repositoryOf(root)
                if (repo == null) {
                    lines.add(DeposStrings.webFolderNoRemote(folder))
                    continue
                }
                val (status, body) = get(origin, token, "/api/extension/workspace?repository=${encodeUriComponent(repo)}")
                val workspace = body as? JsonObject
                val orgName = (workspace?.get("organization") as? JsonObject)?.str("name")
                val fullName = (workspace?.get("repository") as? JsonObject)?.str("fullName")
                lines.add(
                    if (status == 200 && orgName != null && fullName != null) DeposStrings.webFolderOrg(folder, orgName, fullName)
                    else DeposStrings.webFolderNoOrg(folder, repo),
                )
            }
            lines.forEach { log.info("depos: $it") }
            ApplicationManager.getApplication().invokeLater {
                Messages.showInfoMessage(project, lines.joinToString("\n").ifEmpty { " " }, DeposStrings.webSignedIn(name, email))
            }
        } catch (_: SessionEnded) {
            storeToken(origin, null)
            notify(project, DeposStrings.webSessionExpired, NotificationType.WARNING, DeposStrings.webSignIn) { signIn(project) }
        } catch (error: Exception) {
            log.warn("depos: show connection failed", error)
            notify(project, DeposStrings.webUnreachable(origin), NotificationType.ERROR)
        }
    }

    private class SessionEnded : RuntimeException()

    private fun get(origin: String, token: String, path: String): Pair<Int, JsonElement?> {
        val answer = http.send("GET", "$origin$path", authHeaders(token), null)
        if (answer.status == 401) throw SessionEnded()
        return answer.status to (if (answer.ok) DeposJson.parse(answer.body) else null)
    }

    /** The device flow's waits, in steps short enough for Cancel to answer at once. */
    private class IndicatorClock(private val indicator: ProgressIndicator) : DeviceFlow.Clock {
        override fun sleep(ms: Long) {
            val until = System.currentTimeMillis() + ms
            while (!indicator.isCanceled && System.currentTimeMillis() < until) Thread.sleep(100)
        }

        override fun now(): Long = System.currentTimeMillis()

        override fun isCancelled(): Boolean = indicator.isCanceled
    }

    companion object {
        private val TIMEOUT: Duration = Duration.ofSeconds(10)

        /**
         * [uri] with its `localhost` replaced by each address of [addresses], as
         * (literal, uri) pairs, [preferred] first. Path and query stay as they are.
         */
        internal fun localhostCandidates(uri: URI, addresses: List<InetAddress>, preferred: String?): List<Pair<String, URI>> {
            val literals = addresses.map { if (it is Inet6Address) "[${it.hostAddress.substringBefore('%')}]" else it.hostAddress }
                .distinct()
                .sortedBy { if (it == preferred) 0 else 1 }
            val port = if (uri.port == -1) "" else ":${uri.port}"
            val rest = uri.rawPath.orEmpty() + (uri.rawQuery?.let { "?$it" } ?: "")
            return literals.map { it to URI("${uri.scheme}://$it$port$rest") }
        }

        fun getInstance(): DeposConnection = ApplicationManager.getApplication().getService(DeposConnection::class.java)

        /** Where the local copies live, outside every project: the org notes are the organization's, not a project's. */
        fun storageDirectory(): Path = Path.of(com.intellij.openapi.application.PathManager.getSystemPath(), "pacmon", "depos")

        fun notify(
            project: Project?,
            text: String,
            type: NotificationType,
            actionText: String? = null,
            action: (() -> Unit)? = null,
        ) {
            val notification = NotificationGroupManager.getInstance().getNotificationGroup("Pacmon").createNotification(text, type)
            if (actionText != null && action != null) {
                notification.addAction(NotificationAction.createSimpleExpiring(actionText, action))
            }
            notification.notify(project)
        }
    }
}

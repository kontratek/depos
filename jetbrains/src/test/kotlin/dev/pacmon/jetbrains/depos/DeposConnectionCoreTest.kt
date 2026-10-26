package dev.pacmon.jetbrains.depos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The counterpart of `src/test/unit/webConnection.test.ts`: the address, the remote, the device flow. */
class DeposConnectionCoreTest {
    @Test
    fun `an address keeps only its origin`() {
        assertEquals(DeposServerUrl.Parsed.Ok("https://pacmon.example.com"), DeposServerUrl.parse(" https://pacmon.example.com/some/path "))
        assertEquals(DeposServerUrl.Parsed.Ok("http://localhost:3000"), DeposServerUrl.parse("http://localhost:3000"))
        assertEquals(DeposServerUrl.Parsed.Ok("http://127.0.0.1:3000"), DeposServerUrl.parse("http://127.0.0.1:3000/"))
        assertEquals(DeposServerUrl.Parsed.Ok("https://depos.example.com:8443"), DeposServerUrl.parse("https://Depos.Example.com:8443"))
        assertEquals(DeposServerUrl.Parsed.Ok("https://depos.example.com"), DeposServerUrl.parse("https://depos.example.com:443"))
    }

    @Test
    fun `plain http is only for this machine`() {
        assertEquals(DeposServerUrl.Parsed.Bad(DeposServerUrl.Problem.INSECURE), DeposServerUrl.parse("http://pacmon.example.com"))
    }

    @Test
    fun `an empty or unusable address is told apart`() {
        assertEquals(DeposServerUrl.Parsed.Bad(DeposServerUrl.Problem.EMPTY), DeposServerUrl.parse(null))
        assertEquals(DeposServerUrl.Parsed.Bad(DeposServerUrl.Problem.EMPTY), DeposServerUrl.parse("   "))
        for (value in listOf("pacmon.example.com", "https://user:pw@pacmon.example.com", "ftp://pacmon.example.com", "https://")) {
            assertEquals(value, DeposServerUrl.Parsed.Bad(DeposServerUrl.Problem.INVALID), DeposServerUrl.parse(value))
        }
    }

    @Test
    fun `an address saved before Pacmon became Depos reads as depos dev`() {
        assertEquals("https://depos.dev", DeposServerUrl.renamed("https://pacmon.dev"))
        assertEquals("https://depos.dev/", DeposServerUrl.renamed("https://www.pacmon.dev/"))
        assertEquals("https://depos.dev", DeposServerUrl.renamed("HTTPS://PACMON.DEV"))
    }

    @Test
    fun `every other address is left alone`() {
        for (url in listOf("https://depos.dev", "http://localhost:3000", "https://pacmon.dev.example.com", "https://notpacmon.dev", "")) {
            assertEquals(url, url, DeposServerUrl.renamed(url))
        }
    }

    @Test
    fun `the client id is the one Depos accepts for this plugin`() {
        assertEquals("depos-jetbrains", DeviceFlow.CLIENT_ID)
    }

    @Test
    fun `the origin remote wins over an earlier one`() {
        val config = "[core]\r\n\tbare = false\r\n[remote \"upstream\"]\r\n\turl = git@github.com:up/stream.git\r\n" +
            "[remote \"origin\"]\r\n\turl = https://github.com/kontratek/pacmon.git\r\n\turl = https://github.com/other/one.git\r\n"
        assertEquals("https://github.com/kontratek/pacmon.git", GitRemote.remoteUrlFromGitConfig(config))
    }

    @Test
    fun `without origin the first remote is used, without remotes nothing`() {
        assertEquals("git@github.com:a/b.git", GitRemote.remoteUrlFromGitConfig("[remote \"fork\"]\n\turl = git@github.com:a/b.git\n"))
        assertNull(GitRemote.remoteUrlFromGitConfig("[core]\n\tbare = false\n"))
    }

    @Test
    fun `github remotes map to owner and name`() {
        val cases = mapOf(
            "https://github.com/kontratek/pacmon.git" to "kontratek/pacmon",
            "https://github.com/kontratek/pacmon" to "kontratek/pacmon",
            "https://token@github.com/kontratek/pacmon.git" to "kontratek/pacmon",
            "git@github.com:kontratek/pacmon.git" to "kontratek/pacmon",
            "ssh://git@github.com/kontratek/pacmon.git" to "kontratek/pacmon",
            "ssh://git@github.com:22/kontratek/pacmon.git" to "kontratek/pacmon",
            "https://github.com/kontratek/pacmon.web.git" to "kontratek/pacmon.web",
            "git@github-work:kontratek/pacmon.git" to "kontratek/pacmon",
            "git@github.com-personal:kontratek/pacmon.git" to "kontratek/pacmon",
        )
        for ((url, expected) in cases) assertEquals(url, expected, GitRemote.githubFullName(url))
    }

    @Test
    fun `other hosts and paths are not github`() {
        for (url in listOf("https://gitlab.com/a/b.git", "git@bitbucket.org:a/b.git", "https://github.com/a", "/home/me/repo", "C:\\repo")) {
            assertNull(url, GitRemote.githubFullName(url))
        }
    }

    private class FakeHttp(private val answers: MutableList<HttpAnswer>) : DeposHttp {
        val requests = mutableListOf<Pair<String, String?>>()
        override fun send(method: String, url: String, headers: Map<String, String>, body: String?): HttpAnswer {
            requests.add(url to body)
            return answers.removeAt(0)
        }
    }

    private class FakeClock(private val cancelAfter: Int = Int.MAX_VALUE) : DeviceFlow.Clock {
        var time = 0L
        val sleeps = mutableListOf<Long>()
        override fun sleep(ms: Long) {
            sleeps.add(ms)
            time += ms
        }
        override fun now(): Long = time
        override fun isCancelled(): Boolean = sleeps.size > cancelAfter
    }

    private fun code(expiresIn: Long = 600, interval: Long = 5) =
        DeviceFlow.DeviceCode("dev", "ABCD-EFGH", "https://d/device", "https://d/device?user_code=ABCD-EFGH", expiresIn, interval)

    @Test
    fun `the device code is asked for with this plugin's client id`() {
        val http = FakeHttp(mutableListOf(HttpAnswer(200, """{"device_code":"dev","user_code":"ABCD-EFGH","verification_uri":"https://d/device","expires_in":600,"interval":5}""")))
        val code = DeviceFlow.requestDeviceCode(http, "https://d")
        assertEquals("https://d/api/auth/device/code" to """{"client_id":"depos-jetbrains"}""", http.requests.single())
        assertEquals("ABCD-EFGH", code.userCode)
        assertEquals("https://d/device", code.verificationUriComplete)
    }

    @Test
    fun `a refused device code says which status`() {
        val http = FakeHttp(mutableListOf(HttpAnswer(400, """{"error":"invalid_client"}""")))
        try {
            DeviceFlow.requestDeviceCode(http, "https://d")
            fail("no exception")
        } catch (error: DeposException) {
            assertTrue(error.message.orEmpty(), error.message.orEmpty().contains("HTTP 400"))
        }
    }

    @Test
    fun `pending and slow down wait, then the token comes`() {
        val http = FakeHttp(mutableListOf(
            HttpAnswer(400, """{"error":"authorization_pending"}"""),
            HttpAnswer(400, """{"error":"slow_down"}"""),
            HttpAnswer(200, """{"access_token":"tok","token_type":"Bearer"}"""),
        ))
        val clock = FakeClock()
        assertEquals(DeviceFlow.PollResult.Token("tok"), DeviceFlow.pollForToken(http, "https://d", code(), clock))
        assertEquals(listOf(5000L, 5000L, 10000L), clock.sleeps)
        assertEquals(
            """{"grant_type":"urn:ietf:params:oauth:grant-type:device_code","device_code":"dev","client_id":"depos-jetbrains"}""",
            http.requests.last().second,
        )
    }

    @Test
    fun `denied and expired end the wait`() {
        val denied = FakeHttp(mutableListOf(HttpAnswer(400, """{"error":"access_denied"}""")))
        assertEquals(DeviceFlow.PollResult.Denied, DeviceFlow.pollForToken(denied, "https://d", code(), FakeClock()))
        val expired = FakeHttp(mutableListOf(HttpAnswer(400, """{"error":"expired_token"}""")))
        assertEquals(DeviceFlow.PollResult.Expired, DeviceFlow.pollForToken(expired, "https://d", code(), FakeClock()))
    }

    @Test
    fun `no request is sent at or past the deadline`() {
        val http = FakeHttp(MutableList(5) { HttpAnswer(400, """{"error":"authorization_pending"}""") })
        assertEquals(DeviceFlow.PollResult.Expired, DeviceFlow.pollForToken(http, "https://d", code(expiresIn = 12), FakeClock()))
        assertEquals(2, http.requests.size)
    }

    @Test
    fun `cancel stops before the next request`() {
        val http = FakeHttp(MutableList(5) { HttpAnswer(400, """{"error":"authorization_pending"}""") })
        assertEquals(DeviceFlow.PollResult.Cancelled, DeviceFlow.pollForToken(http, "https://d", code(), FakeClock(cancelAfter = 1)))
        assertEquals(1, http.requests.size)
    }

    @Test
    fun `an unknown answer stops the sign-in`() {
        val http = FakeHttp(mutableListOf(HttpAnswer(500, "{}")))
        try {
            DeviceFlow.pollForToken(http, "https://d", code(), FakeClock())
            fail("no exception")
        } catch (error: DeposException) {
            assertTrue(error.message.orEmpty().contains("HTTP 500"))
        }
    }

    @Test
    fun `localhost is tried at every address, the one that answered last first`() {
        val addresses = listOf(
            java.net.InetAddress.getByAddress("localhost", byteArrayOf(127, 0, 0, 1)),
            java.net.InetAddress.getByAddress("localhost", ByteArray(16).also { it[15] = 1 }),
        )
        val uri = java.net.URI("http://localhost:3000/api/extension/workspace?repository=kontratek%2Fapi")
        val candidates = DeposConnection.localhostCandidates(uri, addresses, null)
        assertEquals(listOf("127.0.0.1", "[0:0:0:0:0:0:0:1]"), candidates.map { it.first })
        assertEquals("http://[0:0:0:0:0:0:0:1]:3000/api/extension/workspace?repository=kontratek%2Fapi", candidates[1].second.toString())
        val preferred = DeposConnection.localhostCandidates(uri, addresses, "[0:0:0:0:0:0:0:1]")
        assertEquals("[0:0:0:0:0:0:0:1]", preferred.first().first)
    }

    @Test
    fun `the MCP setup points at the key-authenticated server and holds no key`() {
        val json = DeposCommands.mcpJson("https://depos.example.com", "01HREPO")
        assertTrue(json, json.contains("\"url\": \"https://depos.example.com/api/mcp/repositories/01HREPO\""))
        assertTrue(json, json.contains("\"Authorization\": \"Bearer \${DEPOS_MCP_KEY}\""))
        assertTrue(json, json.contains("\"depos-notes\""))
    }
}

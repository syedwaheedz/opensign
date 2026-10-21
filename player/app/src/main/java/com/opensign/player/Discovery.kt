package com.opensign.player

import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.URL
import java.util.concurrent.Callable
import java.util.concurrent.Executors

/**
 * Finds an OpenSign server on the local network so nobody has to type an address.
 * Tries, in order: a UDP broadcast, the emulator's host address, then a sweep of the local subnet.
 * The later steps still work when a router or firewall drops broadcast packets.
 */
object Discovery {
    private const val UDP_PORT = 41234
    private const val HTTP_PORT = 3000

    /** Returns e.g. "http://192.168.1.10:3000", or null if no server is found. */
    fun find(): String? = broadcast() ?: emulatorHost() ?: sweepSubnet()

    private fun broadcast(timeoutMs: Int = 2000): String? {
        return try {
            DatagramSocket().use { socket ->
                socket.broadcast = true
                socket.soTimeout = timeoutMs
                val msg = "OPENSIGN?".toByteArray()
                // The limited broadcast address is dropped on some devices; also target each subnet's own.
                for (addr in broadcastAddresses()) {
                    runCatching { socket.send(DatagramPacket(msg, msg.size, addr, UDP_PORT)) }
                }
                val packet = DatagramPacket(ByteArray(512), 512)
                socket.receive(packet)
                val text = String(packet.data, 0, packet.length)
                if (!text.startsWith("OPENSIGN ")) return null
                val port = JSONObject(text.removePrefix("OPENSIGN ")).getInt("port")
                "http://${packet.address.hostAddress}:$port"
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun broadcastAddresses(): List<InetAddress> {
        val list = mutableListOf(InetAddress.getByName("255.255.255.255"))
        runCatching {
            for (ni in NetworkInterface.getNetworkInterfaces().toList()) {
                if (!ni.isUp || ni.isLoopback) continue
                ni.interfaceAddresses.mapNotNullTo(list) { it.broadcast }
            }
        }
        return list
    }

    /** Android emulators and BlueStacks reach the computer running the server at 10.0.2.2. Harmless to try elsewhere. */
    private fun emulatorHost(): String? = probe("10.0.2.2", 600)

    /** Asks host:3000 whether it is an OpenSign server. */
    private fun probe(host: String, timeoutMs: Int): String? {
        return try {
            val conn = URL("http://$host:$HTTP_PORT/api/auth/status").openConnection() as HttpURLConnection
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs * 2
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()
            if (body.contains("setupRequired")) "http://$host:$HTTP_PORT" else null
        } catch (e: Exception) {
            null
        }
    }

    private fun sweepSubnet(): String? {
        val own = runCatching {
            NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback }
                .flatMap { it.inetAddresses.toList() }
                .filterIsInstance<Inet4Address>()
                .filter { it.isSiteLocalAddress }
                .mapNotNull { it.hostAddress }
        }.getOrDefault(emptyList())
        if (own.isEmpty()) return null

        val pool = Executors.newFixedThreadPool(48)
        try {
            val tasks = own.flatMap { ip ->
                val prefix = ip.substringBeforeLast('.')
                (1..254).map { n -> "$prefix.$n" }.filter { it != ip }
            }.distinct().map { host -> Callable { probe(host, 300) } }
            return pool.invokeAll(tasks).firstNotNullOfOrNull { f -> runCatching { f.get() }.getOrNull() }
        } finally {
            pool.shutdownNow()
        }
    }
}

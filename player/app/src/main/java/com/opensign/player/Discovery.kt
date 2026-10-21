package com.opensign.player

import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress

/** Finds an OpenSign server on the local network so nobody has to type an address. */
object Discovery {
    private const val PORT = 41234

    /** Returns e.g. "http://192.168.1.10:3000", or null if no server answers in time. */
    fun find(timeoutMs: Int = 3000): String? {
        return try {
            DatagramSocket().use { socket ->
                socket.broadcast = true
                socket.soTimeout = timeoutMs
                val msg = "OPENSIGN?".toByteArray()
                socket.send(DatagramPacket(msg, msg.size, InetAddress.getByName("255.255.255.255"), PORT))
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
}

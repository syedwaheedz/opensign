package com.opensign.player

import org.json.JSONObject
import java.util.Calendar

data class Item(val id: String, val name: String, val type: String, val duration: Int, val src: String)

/** This screen's tile (col,row) of a cols x rows video wall. */
data class Wall(val cols: Int, val rows: Int, val col: Int, val row: Int, val playlistId: String)

/** Emergency message that takes over the whole screen until [until] (server time, ms). */
data class Alert(val message: String, val color: String, val until: Long)

/** One rectangle of a layout, in percent of the screen, playing its own playlist. */
data class Zone(val x: Float, val y: Float, val w: Float, val h: Float, val playlistId: String?)

data class Layout(val id: String, val zones: List<Zone>)

data class Slot(val playlistId: String, val days: Set<Int>, val startMin: Int, val endMin: Int)

data class Config(
    val version: String,
    val defaultPlaylistId: String?,
    val slots: List<Slot>,
    val playlists: Map<String, List<Item>>,
    val wall: Wall? = null,
    val serverTime: Long = 0,
    val alert: Alert? = null,
    val name: String? = null,
    val layouts: Map<String, Layout> = emptyMap(),
) {
    /** Id of the playlist or layout to show right now: video wall, else first matching schedule slot, else the default. */
    fun activeContentId(now: Calendar = Calendar.getInstance()): String? {
        wall?.let { return it.playlistId }
        val dow = now.get(Calendar.DAY_OF_WEEK) - 1 // 0 = Sunday, matches the server
        val prevDow = (dow + 6) % 7
        val min = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE)
        val slot = slots.firstOrNull { s ->
            if (s.startMin <= s.endMin) dow in s.days && min >= s.startMin && min <= s.endMin
            else (dow in s.days && min >= s.startMin) || (prevDow in s.days && min <= s.endMin)
        }
        return slot?.playlistId ?: defaultPlaylistId
    }

    fun activePlaylist(now: Calendar = Calendar.getInstance()): Pair<String, List<Item>>? =
        activeContentId(now)?.let { id -> playlists[id]?.let { id to it } }

    fun activeLayout(now: Calendar = Calendar.getInstance()): Layout? = activeContentId(now)?.let { layouts[it] }

    companion object {
        fun parse(json: String): Config {
            val o = JSONObject(json)
            val pls = HashMap<String, List<Item>>()
            val po = o.getJSONObject("playlists")
            for (pid in po.keys()) {
                val arr = po.getJSONObject(pid).getJSONArray("items")
                pls[pid] = (0 until arr.length()).map {
                    val j = arr.getJSONObject(it)
                    Item(j.getString("id"), j.getString("name"), j.getString("type"), j.getInt("duration"), j.getString("src"))
                }
            }
            val sa = o.getJSONArray("schedule")
            val slots = (0 until sa.length()).map {
                val j = sa.getJSONObject(it)
                val days = j.getJSONArray("days").let { d -> (0 until d.length()).map(d::getInt).toSet() }
                Slot(j.getString("playlistId"), days, toMin(j.getString("start")), toMin(j.getString("end")))
            }
            val layouts = HashMap<String, Layout>()
            o.optJSONObject("layouts")?.let { lo ->
                for (lid in lo.keys()) {
                    val za = lo.getJSONObject(lid).getJSONArray("zones")
                    layouts[lid] = Layout(lid, (0 until za.length()).map {
                        val z = za.getJSONObject(it)
                        Zone(
                            z.getDouble("x").toFloat(), z.getDouble("y").toFloat(),
                            z.getDouble("w").toFloat(), z.getDouble("h").toFloat(),
                            if (z.isNull("playlistId")) null else z.getString("playlistId"),
                        )
                    })
                }
            }
            val def = if (o.isNull("defaultPlaylistId")) null else o.getString("defaultPlaylistId")
            val wall = o.optJSONObject("wall")?.let {
                Wall(it.getInt("cols"), it.getInt("rows"), it.getInt("col"), it.getInt("row"), it.getString("playlistId"))
            }
            val alert = o.optJSONObject("alert")?.let { Alert(it.getString("message"), it.getString("color"), it.getLong("until")) }
            return Config(o.getString("version"), def, slots, pls, wall, o.optLong("serverTime", 0), alert, o.optString("name").takeIf { it.isNotEmpty() && it != "null" }, layouts)
        }

        private fun toMin(hhmm: String) = hhmm.substring(0, 2).toInt() * 60 + hhmm.substring(3, 5).toInt()
    }
}

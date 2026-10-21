package com.opensign.player

import org.json.JSONObject
import java.util.Calendar

data class Item(val id: String, val name: String, val type: String, val duration: Int, val src: String)

data class Slot(val playlistId: String, val days: Set<Int>, val startMin: Int, val endMin: Int)

data class Config(
    val version: String,
    val defaultPlaylistId: String?,
    val slots: List<Slot>,
    val playlists: Map<String, List<Item>>,
) {
    /** Items to play right now: first matching schedule slot, else the default playlist. */
    fun activePlaylist(now: Calendar = Calendar.getInstance()): Pair<String, List<Item>>? {
        val dow = now.get(Calendar.DAY_OF_WEEK) - 1 // 0 = Sunday, matches the server
        val prevDow = (dow + 6) % 7
        val min = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE)
        val slot = slots.firstOrNull { s ->
            if (s.startMin <= s.endMin) dow in s.days && min >= s.startMin && min <= s.endMin
            else (dow in s.days && min >= s.startMin) || (prevDow in s.days && min <= s.endMin)
        }
        val id = slot?.playlistId ?: defaultPlaylistId ?: return null
        val items = playlists[id] ?: return null
        return id to items
    }

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
            val def = if (o.isNull("defaultPlaylistId")) null else o.getString("defaultPlaylistId")
            return Config(o.getString("version"), def, slots, pls)
        }

        private fun toMin(hhmm: String) = hhmm.substring(0, 2).toInt() * 60 + hhmm.substring(3, 5).toInt()
    }
}

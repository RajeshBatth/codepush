package com.otaspike

import android.app.Application
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

// Files + manifest (assets/ota to filesDir/ota copy emulates downloaded files).
object Ota {
  lateinit var app: Application
  val root: File get() = File(app.filesDir, "ota")
  val loadCalls = AtomicInteger(0) // NativeOtaUnits.load invocations (S9)

  fun path(rel: String): String = File(root, rel).absolutePath

  fun copyAssets(): Int {
    root.deleteRecursively()
    return copyDir("ota", root)
  }

  private fun copyDir(assetPath: String, dest: File): Int {
    val children = app.assets.list(assetPath) ?: return 0
    var n = 0
    if (children.isEmpty()) { // a file
      dest.parentFile?.mkdirs()
      app.assets.open(assetPath).use { i -> dest.outputStream().use { o -> i.copyTo(o) } }
      return 1
    }
    dest.mkdirs()
    for (c in children) n += copyDir("$assetPath/$c", File(dest, c))
    return n
  }

  val manifest: JSONObject by lazy { JSONObject(File(root, "spike.json").readText()) }
  fun reloadManifest() = JSONObject(File(root, "spike.json").readText())
  val hbcVersion: Int get() = reloadManifest().optInt("hbcVersion", 96)

  class UnitSpec(val name: String, val entryId: Double, val hash: String, val file: String)

  fun unit(name: String, m: JSONObject = reloadManifest()): UnitSpec? {
    val u = m.optJSONObject("units")?.optJSONObject(name) ?: return null
    return UnitSpec(name, u.optDouble("entryId", -1.0), u.optString("hash", ""), u.optString("file", "units/$name.hbc"))
  }

  /** entry module id of a fixture (bad-entry); tolerant about where the JS agent puts it. */
  fun fixtureEntryId(key: String): Double {
    val m = reloadManifest()
    for (k in listOf(key, "$key.hbc")) m.optJSONObject("fixtures")?.optJSONObject(k)?.let { if (it.has("entryId")) return it.getDouble("entryId") }
    m.optJSONObject("units")?.optJSONObject(key)?.let { if (it.has("entryId")) return it.getDouble("entryId") }
    m.optJSONObject("units")?.optJSONObject(key.removePrefix("unit-"))?.let { if (it.has("entryId")) return it.getDouble("entryId") }
    return Double.NaN
  }
}

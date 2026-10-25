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

  /** spike.json "patches"/"patched" records produced by prepare-spike-assets.mjs (delta-built files + their .hdiff). */
  class PatchSpec(val key: String, val patchFile: String, val builtHash: String, val baseHash: String, val patchSize: Long, val plainPatchSize: Long)

  fun patch(key: String): PatchSpec {
    val p = reloadManifest().getJSONObject("patches").getJSONObject(key)
    return PatchSpec(key, p.getString("file"), p.getString("builtHash"), p.getString("baseHash"), p.getLong("size"), p.getLong("plainBuiltPatchSize"))
  }

  fun patchedCabsEntryId(): Double = reloadManifest().getJSONObject("patched").getJSONObject("cabs").getDouble("entryId")
  fun patchedHash(key: String): String = reloadManifest().getJSONObject("patched").getJSONObject(key).getString("hash")
  fun deltaBuilt(): Boolean = reloadManifest().getJSONObject("patched").optBoolean("deltaBuilt", false)
  fun expectedHostFn(): String = reloadManifest().getJSONObject("patched").getJSONObject("probe").getString("hostFn")

  // ---- S16/S17: cabs v3 (unit-only edit: new function, new strings, changed string, new module) ----
  private fun v3() = reloadManifest().getJSONObject("patched").getJSONObject("cabsV3")
  fun v3Hash(): String = v3().getString("hash")
  fun v3EntryId(): Double = v3().getDouble("entryId")
  fun v3UnitFn(): String = v3().getJSONObject("probe").getString("unitFn")
  fun v3HostChanged(): Boolean = v3().getBoolean("hostChanged")
  fun v3DeltaBuilt(): Boolean = v3().getBoolean("deltaBuilt")
  fun v3HostHash(): String = v3().getString("hostHashV3")
  fun embeddedHostHash(): String = reloadManifest().getJSONObject("host").getString("hash")

  // ---- S18: biglib (real npm packages, ~240 KB unit) ----
  class BigSpec(val baseFile: String, val builtFile: String, val patchFile: String, val baseHash: String, val builtHash: String, val entryId: Double,
      val size: Long, val patchSize: Long, val plainPatchSize: Long, val b1: String, val b2: String)
  fun big(): BigSpec? {
    val b = reloadManifest().optJSONObject("big") ?: return null
    return BigSpec(b.getString("baseFile"), b.getString("builtFile"), b.getString("patchFile"), b.getString("baseHash"), b.getString("builtHash"),
        b.getDouble("entryId"), b.getLong("size"), b.getLong("patchSize"), b.getLong("plainBuiltPatchSize"),
        b.getJSONObject("probe").getString("b1"), b.getJSONObject("probe").getString("b2"))
  }
}

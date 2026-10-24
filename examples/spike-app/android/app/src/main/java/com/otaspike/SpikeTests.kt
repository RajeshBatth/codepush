package com.otaspike

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import com.facebook.react.interfaces.fabric.ReactSurface
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * S1-S10 per SPIKE.md. Runs on a background thread; UI work is marshalled to the main thread.
 * Execution order (state dependent): S1 S3 S6 S4 S5 S7 S8 S9 S2 S10. Each VM-recreating test first removes all surfaces.
 */
class SpikeTests(private val activity: Activity, private val box: FrameLayout, private val sink: (String) -> Unit) {
  private val app = activity.application as MainApplication
  private var pass = 0
  private var fail = 0
  private var surface: ReactSurface? = null

  private fun log(id: String, ok: Boolean, details: String) {
    if (ok) pass++ else fail++
    val line = "OTA_SPIKE RESULT $id ${if (ok) "PASS" else "FAIL"} $details"
    Log.i("OTA_SPIKE", line)
    sink(line)
  }

  private fun info(msg: String) {
    Log.i("OTA_SPIKE", "OTA_SPIKE INFO $msg")
    sink("OTA_SPIKE INFO $msg")
  }

  // ---------- helpers ----------
  private fun <T> ui(f: () -> T): T {
    var r: Result<T>? = null
    val l = CountDownLatch(1)
    Handler(Looper.getMainLooper()).post {
      r = runCatching(f)
      l.countDown()
    }
    l.await(15, TimeUnit.SECONDS)
    return r!!.getOrThrow()
  }

  private fun mount(module: String) {
    unmount()
    surface = ui { SpikeHost.mount(activity, box, module) }
  }

  private fun unmount() {
    val s = surface
    surface = null
    ui { SpikeHost.unmount(box, s) }
  }

  private fun findText(v: View, sub: String): TextView? {
    if (v is TextView && v.text.toString().contains(sub, ignoreCase = true)) return v
    if (v is ViewGroup) for (i in 0 until v.childCount) findText(v.getChildAt(i), sub)?.let { return it }
    return null
  }

  private fun waitText(sub: String, timeoutMs: Long = 10000): TextView? {
    val end = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < end) {
      val t = ui { findText(box, sub) }
      if (t != null) return t
      Thread.sleep(150)
    }
    return null
  }

  private fun tap(target: View) = ui {
    val tl = IntArray(2); target.getLocationOnScreen(tl)
    val rl = IntArray(2); box.getLocationOnScreen(rl)
    val x = (tl[0] - rl[0]) + target.width / 2f
    val y = (tl[1] - rl[1]) + target.height / 2f
    val t = SystemClock.uptimeMillis()
    box.dispatchTouchEvent(MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, x, y, 0))
    box.dispatchTouchEvent(MotionEvent.obtain(t, t + 60, MotionEvent.ACTION_UP, x, y, 0))
  }

  private fun probe(expr: String) = OtaNative.probe(SpikeHost.context(), expr).second

  private fun boot(src: SpikeHost.Src, reason: String) {
    unmount()
    SpikeHost.source = src
    SpikeHost.bootOrReload(app, reason)
    ui { SpikeHost.host?.onHostResume(activity) } // host lifecycle: activity is already resumed
  }

  private val patchedHost get() = SpikeHost.Src.File(Ota.path("patched/host.hbc"))

  private fun evalUnit(rel: String, entryId: Double, url: String, hash: String = "", ver: Int = Ota.hbcVersion): EvalOutcome =
      OtaNative.evaluateBlocking(SpikeHost.context()!!, Ota.path(rel), entryId, url, ver, hash)

  private fun loadEmbedded(name: String): EvalOutcome {
    val u = Ota.unit(name)!!
    return evalUnit("embedded/${u.file}", u.entryId, "unit://$name", u.hash)
  }

  private fun guarded(id: String, body: () -> Unit) {
    try {
      body()
    } catch (t: Throwable) {
      Log.e("OTA_SPIKE", "$id threw", t)
      log(id, false, "exception: $t")
    }
  }

  // ---------- run ----------
  fun runAll() {
    sink("OTA_SPIKE INFO copying assets/ota -> filesDir/ota")
    val n = Ota.copyAssets()
    info("copied $n files; hbcVersion=${runCatching { Ota.hbcVersion }.getOrNull()}")
    if (n == 0 || !File(Ota.root, "spike.json").exists()) {
      log("S0", false, "no assets/ota/spike.json (run scripts/prepare-spike-assets.mjs and rebuild)")
      sink("OTA_SPIKE SUMMARY pass=$pass fail=$fail")
      return
    }
    guarded("S1", ::s1)
    guarded("S3", ::s3)
    guarded("S6", ::s6)
    guarded("S4", ::s4)
    guarded("S5", ::s5)
    guarded("S7", ::s7)
    guarded("S8", ::s8)
    guarded("S9", ::s9)
    guarded("S2", ::s2)
    guarded("S10", ::s10)
    unmount()
    val line = "OTA_SPIKE SUMMARY pass=$pass fail=$fail"
    Log.i("OTA_SPIKE", line)
    sink(line)
  }

  private fun s1() {
    boot(SpikeHost.Src.Embedded, "S1")
    mount("SpikeHost")
    val t = waitText("HOST:embedded")
    val host = probe("__otaProbe.host")
    log("S1", t != null && host == "\"embedded\"", "surface=${t?.text} probe.host=$host source=${SpikeHost.source}")
  }

  private fun s3() {
    val o = loadEmbedded("cabs")
    val v = probe("__otaProbe.units.cabs")
    mount("cabs")
    val t = waitText("CABS:v1")
    log("S3", o.ok && v == "\"v1\"" && t != null, "$o probe.units.cabs=$v surface=${t?.text}")
  }

  private fun s6() {
    val c = Ota.unit("cabs")!!
    // patched cabs v2 into the VM that already holds v1 (hash unknown for patched files: skip it)
    val o = evalUnit("patched/${c.file}", c.entryId, "unit://cabs-v2")
    val v = probe("__otaProbe.units.cabs")
    log("S6", v == "\"v1\"", "eval(v2) $o; probe.units.cabs=$v (expected v1: first define wins)")
  }

  private fun s4() {
    val ver = Ota.hbcVersion
    val cabs = Ota.unit("cabs")!!
    val cases =
        listOf(
            Triple("wrong-version", "fixtures/unit-wrong-version.hbc", 0) to "BytecodeVersionMismatch",
            Triple("text-js", "fixtures/unit-text.js", 0) to "NotHermesBytecode",
            Triple("truncated", "fixtures/unit-truncated.hbc", 0) to "TooSmall",
            Triple("misaligned", "embedded/${cabs.file}", 1) to "Misaligned")
    val sb = StringBuilder()
    var allOk = true
    for ((c, expected) in cases) {
      val r = OtaNative.mapAndCheck(Ota.path(c.second), ver, "", c.third)
      val ok = r.status == expected
      allOk = allOk && ok
      sb.append("${c.first}=${r.status}${if (ok) "" else "(expected $expected)"} ")
    }
    val pwned = probe("__otaProbe.pwned")
    allOk = allOk && pwned == "false"
    // Informational: what does Hermes itself do for wrong-version if pre-check is bypassed (never bypass the text file).
    val bypass = evalUnit("fixtures/unit-wrong-version.hbc", -1.0, "unit://wrong-version", ver = -1)
    val units = probe("__otaProbe.units")
    log("S4", allOk, "$sb pwned=$pwned | bypass(wrong-version) hermes: status=${bypass.status} msg=${bypass.message} units-after=$units")
  }

  private fun s5() {
    val badId = Ota.fixtureEntryId("unit-bad-entry")
    if (badId.isNaN()) {
      log("S5", false, "spike.json has no entryId for unit-bad-entry")
      return
    }
    val o = evalUnit("fixtures/unit-bad-entry.hbc", badId, "unit://bad-entry")
    val bus = loadEmbedded("bus")
    val v = probe("__otaProbe.units.bus")
    log("S5", o.status == "RequireError" && bus.ok && v == "\"v1\"", "bad-entry: $o | then bus: ${bus.status} probe.units.bus=$v")
  }

  private fun s7() {
    unmount()
    val ctx1 = SpikeHost.context()!!
    val holder1 = ctx1.getJavaScriptContextHolder()!!
    val ptr1 = holder1.get()
    val rt1 = OtaNative.probe(ctx1, "1").first
    SpikeHost.bootOrReload(app, "S7") // reload: same source (embedded)
    val ctx2 = SpikeHost.context()!!
    val holder2 = ctx2.getJavaScriptContextHolder()!!
    val ptr2 = holder2.get()
    val rt2 = OtaNative.probe(ctx2, "1").first
    val staleCleared = holder1.get() == 0L // old holder must not hand out the dead runtime pointer
    val fresh = probe("__otaProbe.units")
    val o = loadEmbedded("cabs") // uses FRESH ctx2 invoker
    val v = probe("__otaProbe.units.cabs")
    val ok = o.ok && v == "\"v1\"" && fresh == "{}"
    log(
        "S7", ok,
        "ctx same=${ctx1 === ctx2} jsHolder ptr old=0x${ptr1.toString(16)} new=0x${ptr2.toString(16)} (same=${ptr1 == ptr2}) " +
            "rt(old)=$rt1 rt(new)=$rt2 oldHolderCleared=$staleCleared units-before-load=$fresh load=${o.status} probe.units.cabs=$v")
  }

  private fun s8() {
    boot(SpikeHost.Src.Embedded, "S8") // clean VM so each unit really evaluates
    val sb = StringBuilder()
    var ok = true
    for (name in listOf("cabs", "bus", "travelplex")) {
      val u = Ota.unit(name) ?: continue
      val t0 = SystemClock.elapsedRealtimeNanos()
      val o = evalUnit("embedded/${u.file}", u.entryId, "unit://$name", u.hash)
      val total = (SystemClock.elapsedRealtimeNanos() - t0) / 1e6
      ok = ok && o.ok
      sb.append("$name{bytes=${o.bytes} map=%.2f check+sha256=%.2f eval=%.2f require=%.2f total(incl. thread hops)=%.2f ms status=${o.status}} ".format(o.mapMs, o.checkMs, o.evalMs, o.requireMs, total))
    }
    val hostBytes = File(Ota.path("embedded/host.hbc")).length()
    log("S8", ok, "host.hbc bytes=$hostBytes | $sb")
  }

  private fun s9() {
    boot(SpikeHost.Src.Embedded, "S9")
    Ota.loadCalls.set(0)
    mount("SpikeHost")
    waitText("HOST:embedded")
    val lba = probe("typeof globalThis.__loadBundleAsync")
    val btn = waitText("import() cabs")
    if (btn == null) {
      log("S9", false, "button 'import() cabs' not found; typeof __loadBundleAsync=$lba")
      return
    }
    tap(btn)
    val t = waitText("CABS:v1", 12000)
    val v = probe("__otaProbe.units.cabs")
    log("S9", t != null && Ota.loadCalls.get() >= 1 && v == "\"v1\"", "typeof __loadBundleAsync=$lba NativeOtaUnits.load calls=${Ota.loadCalls.get()} surface=${t?.text} probe.units.cabs=$v")
  }

  private fun s2() {
    boot(patchedHost, "S2")
    mount("SpikeHost")
    val t = waitText("HOST:patched")
    val host = probe("__otaProbe.host")
    log("S2", t != null && host == "\"patched\"", "surface=${t?.text} probe.host=$host source=${SpikeHost.source} (via ReactHost.reload with dynamic JSBundleLoader)")
  }

  private fun s10() {
    boot(SpikeHost.Src.Embedded, "S10-a")
    val a = loadEmbedded("cabs")
    val va = probe("__otaProbe.units.cabs")
    unmount() // no surfaces mounted
    SpikeHost.source = patchedHost
    SpikeHost.bootOrReload(app, "S10-b")
    val host = probe("__otaProbe.host")
    val units = probe("__otaProbe.units")
    val b = loadEmbedded("cabs")
    val vb = probe("__otaProbe.units.cabs")
    mount("cabs")
    val t = waitText("CABS:v1")
    log("S10", a.ok && va == "\"v1\"" && host == "\"patched\"" && units == "{}" && b.ok && vb == "\"v1\"" && t != null,
        "before: cabs=$va | after swap: host=$host units=$units | reload cabs: ${b.status} probe=$vb surface=${t?.text}")
  }
}

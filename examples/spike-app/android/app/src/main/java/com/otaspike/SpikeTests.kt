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
 * S1-S18 per SPIKE.md (S11-S15: delta-built bytecode + on-device otacore applyPatch; S16-S17: unit adds a function + strings on the embedded host; S18: realistic unit size). Runs on a background thread; UI work is marshalled to the main thread.
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
    guarded("S11", ::s11)
    guarded("S12", ::s12)
    guarded("S13", ::s13)
    guarded("S14", ::s14)
    guarded("S15", ::s15)
    guarded("S16", ::s16)
    guarded("S17", ::s17)
    guarded("S18", ::s18)
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
    val fn = probe("__otaProbe.hostFn")
    log("S2", t != null && host == "\"patched\"" && fn == "\"${Ota.expectedHostFn()}\"" && Ota.deltaBuilt(), "surface=${t?.text} probe.host=$host hostFn=$fn deltaBuilt=${Ota.deltaBuilt()} source=${SpikeHost.source} (via ReactHost.reload with dynamic JSBundleLoader)")
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

  // ================= S11-S15 =================
  private fun sha(rel: String) = OtaNative.nativeSha256File(Ota.path(rel))

  /** S11: patched (delta-built) cabs v2 is the FIRST definition of cabs in a fresh VM (embedded cabs never loaded). */
  private fun s11() {
    boot(SpikeHost.Src.Embedded, "S11")
    val before = probe("__otaProbe.units")
    val fileHash = sha("patched/units/cabs.hbc")
    val embHash = sha("embedded/units/cabs.hbc")
    val o = evalUnit("patched/units/cabs.hbc", Ota.patchedCabsEntryId(), "unit://cabs-v2", Ota.patchedHash("cabs"))
    val v = probe("__otaProbe.units.cabs")
    mount("cabs")
    val t = waitText("CABS:v2")
    val sane = fileHash == Ota.patchedHash("cabs") && fileHash != embHash
    log("S11", before == "{}" && o.ok && v == "\"v2\"" && t != null && sane && Ota.deltaBuilt(),
        "fresh VM units-before=$before eval(delta-built v2)=${o.status} probe.units.cabs=$v surface=${t?.text} deltaBuilt=${Ota.deltaBuilt()} " +
            "file=${fileHash.take(19)} (embedded=${embHash.take(19)}) hashMatchesSpikeJson=${fileHash == Ota.patchedHash("cabs")}")
  }

  /** S12: delta-built patched host boots; its NEW function runs (probe.hostFn); then the delta-built cabs v2 loads on top of it. */
  private fun s12() {
    boot(SpikeHost.Src.Embedded, "S12-a")
    val embFn = probe("typeof __otaProbe.hostFn")
    val hostHash = sha("patched/host.hbc")
    boot(patchedHost, "S12-b")
    mount("SpikeHost")
    val t = waitText("HOST:patched")
    val host = probe("__otaProbe.host")
    val fn = probe("__otaProbe.hostFn")
    val o = evalUnit("patched/units/cabs.hbc", Ota.patchedCabsEntryId(), "unit://cabs-v2-on-patched-host", Ota.patchedHash("cabs"))
    val v = probe("__otaProbe.units.cabs")
    mount("cabs")
    val t2 = waitText("CABS:v2")
    val expectedFn = "\"${Ota.expectedHostFn()}\""
    log("S12", embFn == "\"undefined\"" && t != null && host == "\"patched\"" && fn == expectedFn && o.ok && v == "\"v2\"" && t2 != null &&
        hostHash == Ota.patchedHash("host") && Ota.deltaBuilt(),
        "embedded host typeof hostFn=$embFn | patched host (delta-built, ${hostHash.take(19)}) surface=${t?.text} probe.host=$host hostFn=$fn (expected $expectedFn) | " +
            "then cabs v2: ${o.status} probe.units.cabs=$v surface=${t2?.text}")
  }

  private fun builtPath(rel: String) = "built/$rel"

  /** S13: applyPatch(embedded, .hdiff) on device == the delta-built file (sha256), then the BUILT files load and run. */
  private fun s13() {
    val sb = StringBuilder()
    var ok = true
    val results = HashMap<String, OtaNative.ApplyOutcome>()
    for ((key, emb) in listOf("cabs" to "embedded/units/cabs.hbc", "host" to "embedded/host.hbc")) {
      val p = Ota.patch(key)
      val out = Ota.path(if (key == "host") builtPath("host.hbc") else builtPath("units/cabs.hbc"))
      File(out).parentFile!!.mkdirs()
      val r = OtaNative.applyPatch(Ota.path(emb), Ota.path(p.patchFile), out, p.builtHash)
      val got = if (File(out).exists()) OtaNative.nativeSha256File(out) else "none"
      val eq = got == p.builtHash && got == Ota.patchedHash(key)
      ok = ok && r.ok && eq && r.outExists && !r.tmpExists
      results[key] = r
      sb.append("$key{patch=${File(Ota.path(p.patchFile)).length()}B base=${File(Ota.path(emb)).length()}B built=${File(out).length()}B $r sha256(out)=${got.take(19)} ==expected&delta-built:$eq} ")
    }
    // the BUILT cabs runs: fresh VM, first definition of cabs
    boot(SpikeHost.Src.Embedded, "S13-cabs")
    val builtCabs = Ota.path(builtPath("units/cabs.hbc"))
    val o = OtaNative.evaluateBlocking(SpikeHost.context()!!, builtCabs, Ota.patchedCabsEntryId(), "unit://cabs-built-on-device", Ota.hbcVersion, Ota.patchedHash("cabs"))
    val v = probe("__otaProbe.units.cabs")
    mount("cabs")
    val t = waitText("CABS:v2")
    // the BUILT host boots too
    boot(SpikeHost.Src.File(Ota.path(builtPath("host.hbc"))), "S13-host")
    mount("SpikeHost")
    val th = waitText("HOST:patched")
    val fn = probe("__otaProbe.hostFn")
    ok = ok && o.ok && v == "\"v2\"" && t != null && th != null && fn == "\"${Ota.expectedHostFn()}\""
    log("S13", ok, "$sb | built cabs: ${o.status} probe=$v surface=${t?.text} | built host: surface=${th?.text} hostFn=$fn")
  }

  private fun corruptCopies(): List<Triple<String, File, String>> {
    val dir = File(Ota.root, "bad").apply { mkdirs() }
    val res = ArrayList<Triple<String, File, String>>()
    for (key in listOf("cabs", "host")) {
      val src = File(Ota.path(Ota.patch(key).patchFile)).readBytes()
      val flipped = src.copyOf().also { it[it.size / 2] = (it[it.size / 2].toInt() xor 0xFF).toByte() }
      val trunc = src.copyOf(src.size / 2)
      res += Triple("$key-flip", File(dir, "$key-flip.hdiff").also { it.writeBytes(flipped) }, key)
      res += Triple("$key-trunc", File(dir, "$key-trunc.hdiff").also { it.writeBytes(trunc) }, key)
    }
    return res
  }

  /** S14: corrupt/truncated patches are rejected on device and leave no output (and do not touch a pre-existing file). */
  private fun s14() {
    val sb = StringBuilder()
    var ok = true
    for ((name, patch, key) in corruptCopies()) {
      val p = Ota.patch(key)
      val emb = if (key == "host") "embedded/host.hbc" else "embedded/units/cabs.hbc"
      val out = File(Ota.root, "bad/$name.out")
      val sentinel = name.endsWith("trunc")
      if (sentinel) out.writeText("sentinel")
      val r = OtaNative.applyPatch(Ota.path(emb), patch.absolutePath, out.absolutePath, p.builtHash)
      val rejected = r.status == "PatchCorrupt" || r.status == "HashMismatch"
      val clean = if (sentinel) out.exists() && out.readText() == "sentinel" && !r.tmpExists else !out.exists() && !r.tmpExists
      ok = ok && rejected && clean
      sb.append("$name->${r.status}(${"%.1f".format(r.ms)}ms,${if (sentinel) "preexisting-untouched" else "no-output"}=$clean) ")
    }
    log("S14", ok, sb.toString().trim())
  }

  /** S15: right patch, wrong expected hash -> HashMismatch and no output. */
  private fun s15() {
    val sb = StringBuilder()
    var ok = true
    for ((key, emb) in listOf("cabs" to "embedded/units/cabs.hbc", "host" to "embedded/host.hbc")) {
      val p = Ota.patch(key)
      val wrong = p.builtHash.dropLast(1) + (if (p.builtHash.last() == '0') '1' else '0')
      val out = File(Ota.root, "bad/$key-wronghash.out")
      val r = OtaNative.applyPatch(Ota.path(emb), Ota.path(p.patchFile), out.absolutePath, wrong)
      val good = r.status == "HashMismatch" && !out.exists() && !r.tmpExists
      ok = ok && good
      sb.append("$key->${r.status} out=${out.exists()} tmp=${r.tmpExists} ")
    }
    log("S15", ok, sb.toString().trim())
  }

  // ================= S16-S18: unit-only edits never need a host patch =================
  private fun v3Properties(tag: String, unitFile: String, via: String): Pair<Boolean, String> {
    val hostBefore = sha("embedded/host.hbc")
    boot(SpikeHost.Src.Embedded, tag)
    val before = probe("__otaProbe.units")
    val hostProbe = probe("__otaProbe.host")
    val hostFnType = probe("typeof __otaProbe.hostFn")
    val o = evalUnit(unitFile, Ota.v3EntryId(), "unit://cabs-v3-$tag", Ota.v3Hash())
    val v = probe("__otaProbe.units.cabs")
    val fn = probe("__otaProbe.unitFn")
    mount("cabs")
    val t = waitText("CABS:v3")
    val changedStr = waitText("Mini fare:", 4000) // the changed existing string (was "Mini 120")
    val hostAfter = sha("embedded/host.hbc")
    val expectedFn = "\"${Ota.v3UnitFn()}\""
    val ok = hostBefore == Ota.embeddedHostHash() && hostAfter == hostBefore && hostBefore == Ota.v3HostHash() && !Ota.v3HostChanged() &&
        before == "{}" && hostProbe == "\"embedded\"" && hostFnType == "\"undefined\"" && o.ok && v == "\"v3\"" && fn == expectedFn &&
        t != null && changedStr != null && Ota.v3DeltaBuilt() && sha(unitFile) == Ota.v3Hash()
    return ok to "$via fresh VM on EMBEDDED host (host sha256 ${hostBefore.take(19)} == embedded ${Ota.embeddedHostHash().take(19)} == v3-build host ${Ota.v3HostHash().take(19)}, " +
        "unchanged after=${hostAfter == hostBefore}, hostChanged(spike.json)=${Ota.v3HostChanged()}) units-before=$before probe.host=$hostProbe eval=${o.status} bytes=${o.bytes} " +
        "probe.units.cabs=$v unitFn=$fn (expected $expectedFn) surface=${t?.text} changed-string-row=${changedStr?.text} deltaBuilt=${Ota.v3DeltaBuilt()} " +
        "eval map=%.2f check+sha=%.2f eval=%.2f require=%.2f ms".format(o.mapMs, o.checkMs, o.evalMs, o.requireMs)
  }

  /** S16: the delta-built v3 unit (new function + new strings + changed string + new module) is the FIRST cabs definition on the untouched EMBEDDED host. */
  private fun s16() {
    val (ok, d) = v3Properties("S16", "patched/units/cabs-v3.hbc", "delta-built file")
    log("S16", ok, d)
  }

  /** S17: v3 through the on-device apply: otacore applyPatch(embedded cabs, cabs-v3.hdiff) == the delta-built file; load the BUILT file. */
  private fun s17() {
    val p = Ota.patch("cabs-v3")
    val out = Ota.path(builtPath("units/cabs-v3.hbc"))
    File(out).parentFile!!.mkdirs()
    val r = OtaNative.applyPatch(Ota.path("embedded/units/cabs.hbc"), Ota.path(p.patchFile), out, p.builtHash)
    val got = if (File(out).exists()) OtaNative.nativeSha256File(out) else "none"
    val eq = got == p.builtHash && got == Ota.v3Hash()
    val (ok, d) = v3Properties("S17", builtPath("units/cabs-v3.hbc"), "on-device BUILT file")
    log("S17", r.ok && eq && r.outExists && !r.tmpExists && p.baseHash == sha("embedded/units/cabs.hbc") && ok,
        "apply: patch=${File(Ota.path(p.patchFile)).length()}B (plain-built patch would be ${p.plainPatchSize}B) base=${File(Ota.path("embedded/units/cabs.hbc")).length()}B built=${File(out).length()}B $r " +
            "sha256(out)=${got.take(19)} ==expected&delta-built:$eq | $d")
  }

  private fun median(l: List<Double>) = l.sorted()[l.size / 2]

  /** S18: realistic unit size (~240 KB biglib: lodash + dayjs + semver + ajv through the real splitter/ota-build pipeline). */
  private fun s18() {
    val b = Ota.big()
    if (b == null) {
      log("S18", false, "spike.json has no `big` record (run scripts/prepare-spike-big.mjs and rebuild)")
      return
    }
    val sb = StringBuilder()
    var ok = sha(b.baseFile) == b.baseHash
    val runs = ArrayList<EvalOutcome>()
    val totals = ArrayList<Double>()
    val shaMs = ArrayList<Double>()
    for (i in 0 until 5) { // run 0 = cold (first in this process for this file), 1..4 = warm
      boot(SpikeHost.Src.Embedded, "S18-b1-$i")
      val t0 = SystemClock.elapsedRealtimeNanos()
      val o = evalUnit(b.baseFile, b.entryId, "unit://biglib-b1", b.baseHash)
      totals += (SystemClock.elapsedRealtimeNanos() - t0) / 1e6
      val v = probe("__otaProbe.units.biglib")
      ok = ok && o.ok && v == "\"${b.b1}\""
      runs += o
      if (i == 0) sb.append("probe=$v units=${probe("__otaProbe.units")} first-eval=$o ")
    }
    fun fmt(o: EvalOutcome, tot: Double) = "map=%.2f check+sha256=%.2f eval=%.2f require=%.2f total=%.2f ms".format(o.mapMs, o.checkMs, o.evalMs, o.requireMs, tot)
    val warm = runs.drop(1); val warmTot = totals.drop(1)
    sb.append("unit=${b.size}B | cold: ${fmt(runs[0], totals[0])} | warm(median of 4): map=%.2f check+sha256=%.2f eval=%.2f require=%.2f total=%.2f ms | "
        .format(median(warm.map { it.mapMs }), median(warm.map { it.checkMs }), median(warm.map { it.evalMs }), median(warm.map { it.requireMs }), median(warmTot)))
    // on-device apply of the one-string-edit delta patch, 3 runs (first = cold)
    val out = Ota.path(builtPath("units/biglib-b2.hbc"))
    File(out).parentFile!!.mkdirs()
    val applies = ArrayList<OtaNative.ApplyOutcome>()
    for (i in 0 until 3) {
      File(out).delete()
      val r = OtaNative.applyPatch(Ota.path(b.baseFile), Ota.path(b.patchFile), out, b.builtHash)
      applies += r
      ok = ok && r.ok && r.outExists && !r.tmpExists
    }
    val got = OtaNative.nativeSha256File(out)
    val eq = got == b.builtHash
    ok = ok && eq
    sb.append("apply(one-string edit, patch=${b.patchSize}B delta-built vs ${b.plainPatchSize}B plain-built, built=${File(out).length()}B): " +
        "first ${applies[0]} | later ms=${applies.drop(1).joinToString { "%.2f".format(it.ms) }} peak+${applies.drop(1).joinToString { "${it.peakDeltaKb}kB" }} sha256(out)==expected:$eq | ")
    boot(SpikeHost.Src.Embedded, "S18-b2")
    val o = evalUnit(builtPath("units/biglib-b2.hbc"), b.entryId, "unit://biglib-b2", b.builtHash)
    val v = probe("__otaProbe.units.biglib")
    mount("biglib")
    val t = waitText("BIGLIB:b2")
    ok = ok && o.ok && v == "\"${b.b2}\"" && t != null
    sb.append("built b2: ${o.status} probe=$v surface=${t?.text}")
    log("S18", ok, sb.toString())
  }
}

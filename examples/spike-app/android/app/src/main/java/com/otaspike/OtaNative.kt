package com.otaspike

import com.facebook.react.bridge.ReactContext
import com.facebook.soloader.SoLoader
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Called on the JS thread by libotaspike.so. */
interface EvalCallback {
  fun onResult(
      status: String,
      message: String,
      mapMs: Double,
      checkMs: Double,
      evalMs: Double,
      requireMs: Double,
      bytes: Long
  )
}

interface ProbeCallback {
  fun onProbe(rt: String, value: String)
}

data class EvalOutcome(
    val status: String,
    val message: String,
    val mapMs: Double,
    val checkMs: Double,
    val evalMs: Double,
    val requireMs: Double,
    val bytes: Long
) {
  val ok get() = status == "Ok"
  override fun toString() =
      "status=$status bytes=$bytes map=%.2fms check+sha=%.2fms eval=%.2fms require=%.2fms msg=%s"
          .format(mapMs, checkMs, evalMs, requireMs, message)
}

data class MapOutcome(
    val status: String,
    val size: Long,
    val mapMs: Double,
    val checkMs: Double,
    val shaMs: Double,
    val version: Long
)

/**
 * Kotlin face of libotaspike.so. The runtime/CallInvoker come from a ReactContext:
 *  - CallInvoker: ReactContext.getJSCallInvokerHolder() (a CallInvokerHolderImpl; @FrameworkAPI, but we only pass it
 *    through as Object to JNI, so no Kotlin opt-in is needed)
 *  - jsi::Runtime: used only inside CallInvoker.invokeAsync(Runtime&); the raw pointer from
 *    ReactContext.getJavaScriptContextHolder().get() is only compared for identity (S7), never dereferenced.
 */
object OtaNative {
  init {
    SoLoader.loadLibrary("otaspike")
  }

  @JvmStatic external fun nativeMapAndCheck(path: String, expectedVersion: Int, expectedHash: String, misalign: Int): String

  @JvmStatic
  external fun nativeEvaluate(
      holder: Any?,
      path: String,
      entryId: Double,
      sourceUrl: String,
      expectedVersion: Int,
      expectedHash: String,
      cb: EvalCallback
  )

  /** otacore::applyPatch via FileSource. Returns "<Status>|ms|rssBeforeKb|hwmAfterKb|rssAfterKb|outExists|tmpExists|clearRefsOk". */
  @JvmStatic external fun nativeApplyPatch(oldFile: String, patchFile: String, outFile: String, expectedHash: String): String

  @JvmStatic external fun nativeSha256File(path: String): String

  @JvmStatic external fun nativeProbe(holder: Any?, expr: String, cb: ProbeCallback)

  data class ApplyOutcome(
      val status: String, val ms: Double, val rssBeforeKb: Long, val hwmAfterKb: Long, val rssAfterKb: Long,
      val outExists: Boolean, val tmpExists: Boolean, val peakReset: Boolean
  ) {
    val ok get() = status == "Ok"
    /** peak RSS above the pre-apply RSS (VmHWM was reset just before when peakReset) */
    val peakDeltaKb get() = hwmAfterKb - rssBeforeKb
    override fun toString() =
        "status=$status time=%.2fms rss=%dkB peak=%dkB (+%dkB%s) rssAfter=%dkB out=%s tmp=%s"
            .format(ms, rssBeforeKb, hwmAfterKb, peakDeltaKb, if (peakReset) "" else ", HWM NOT reset", rssAfterKb, outExists, tmpExists)
  }

  fun applyPatch(oldFile: String, patchFile: String, outFile: String, expectedHash: String): ApplyOutcome {
    val p = nativeApplyPatch(oldFile, patchFile, outFile, expectedHash).split("|")
    return ApplyOutcome(p[0], p[1].toDouble(), p[2].toLong(), p[3].toLong(), p[4].toLong(), p[5] == "1", p[6] == "1", p[7] == "1")
  }

  fun mapAndCheck(path: String, expectedVersion: Int, expectedHash: String = "", misalign: Int = 0): MapOutcome {
    val p = nativeMapAndCheck(path, expectedVersion, expectedHash, misalign).split("|")
    return MapOutcome(p[0], p[1].toLong(), p[2].toDouble(), p[3].toDouble(), p[4].toDouble(), p[5].toLong())
  }

  /** Spec form: evaluateUnit(path, entryId, sourceUrl, callback). entryId < 0 => do not run the entry module. */
  fun evaluateUnit(
      ctx: ReactContext,
      path: String,
      entryId: Double,
      sourceUrl: String,
      expectedVersion: Int,
      expectedHash: String,
      callback: (EvalOutcome) -> Unit
  ) {
    nativeEvaluate(
        ctx.getJSCallInvokerHolder(), path, entryId, sourceUrl, expectedVersion, expectedHash,
        object : EvalCallback {
          override fun onResult(status: String, message: String, mapMs: Double, checkMs: Double, evalMs: Double, requireMs: Double, bytes: Long) {
            callback(EvalOutcome(status, message, mapMs, checkMs, evalMs, requireMs, bytes))
          }
        })
  }

  /** Blocking helper; never call from the UI or JS thread. */
  fun evaluateBlocking(
      ctx: ReactContext,
      path: String,
      entryId: Double,
      sourceUrl: String,
      expectedVersion: Int,
      expectedHash: String = ""
  ): EvalOutcome {
    val latch = CountDownLatch(1)
    var out: EvalOutcome? = null
    evaluateUnit(ctx, path, entryId, sourceUrl, expectedVersion, expectedHash) {
      out = it
      latch.countDown()
    }
    if (!latch.await(20, TimeUnit.SECONDS)) return EvalOutcome("Timeout", "no callback in 20s", 0.0, 0.0, 0.0, 0.0, 0)
    return out!!
  }

  /** Spike-only: JSON.stringify(<expr>) on the JS thread. Returns Pair(runtimeAddress, json-or-ERR). */
  fun probe(ctx: ReactContext?, expr: String): Pair<String, String> {
    if (ctx == null) return "0x0" to "NOCONTEXT"
    val latch = CountDownLatch(1)
    var out = "0x0" to "TIMEOUT"
    nativeProbe(ctx.getJSCallInvokerHolder(), expr, object : ProbeCallback {
      override fun onProbe(rt: String, value: String) {
        out = rt to value
        latch.countDown()
      }
    })
    latch.await(10, TimeUnit.SECONDS)
    return out
  }
}

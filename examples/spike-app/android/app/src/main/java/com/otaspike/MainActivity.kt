package com.otaspike

import android.app.Activity
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.util.TypedValue
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlin.concurrent.thread

/** NATIVE first screen of the hybrid app. No React instance exists until a button needs one. */
class MainActivity : Activity() {
  private lateinit var results: TextView
  private lateinit var scroll: ScrollView
  private lateinit var surfaceBox: FrameLayout

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val dp = { v: Int -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt() }
    val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(8), dp(8), dp(8), dp(8)) }
    val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
    fun btn(label: String, tag: String, onClick: () -> Unit) =
        Button(this).apply {
          text = label
          contentDescription = tag
          isAllCaps = false
          setOnClickListener { onClick() }
          row.addView(this, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }
    btn("Run all spike tests", "run_all") { runAll() }
    btn("Open host", "open_host") { open("SpikeHost") }
    btn("Open cabs", "open_cabs") { open("cabs") }
    root.addView(row)
    results = TextView(this).apply {
      typeface = Typeface.MONOSPACE
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f)
      text = "Spike ready. No React instance created yet.\n"
    }
    scroll = ScrollView(this).apply { addView(results) }
    root.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    // on-screen mount point for surfaces used by the test runner
    surfaceBox = FrameLayout(this)
    root.addView(surfaceBox, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(260)))
    setContentView(root)
  }

  override fun onResume() {
    super.onResume()
    SpikeHost.host?.onHostResume(this)
  }

  override fun onPause() {
    super.onPause()
    SpikeHost.host?.onHostPause(this)
  }

  private fun append(line: String) = runOnUiThread {
    results.append(line + "\n")
    scroll.post { scroll.fullScroll(ScrollView.FOCUS_DOWN) }
  }

  @Volatile private var running = false

  private fun runAll() {
    if (running) return
    running = true
    results.text = ""
    thread(name = "spike-runner") {
      try {
        SpikeTests(this, surfaceBox, ::append).runAll()
      } catch (t: Throwable) {
        append("OTA_SPIKE RUNNER-CRASH $t")
        android.util.Log.e("OTA_SPIKE", "runner crash", t)
      } finally {
        running = false
      }
    }
  }

  /** "Open host" / "Open cabs": boot embedded host lazily, (for cabs) load the unit from filesDir, open RnActivity. */
  private fun open(module: String) {
    thread(name = "spike-open") {
      try {
        val app = application as MainApplication
        if (!Ota.root.exists()) Ota.copyAssets()
        if (SpikeHost.host == null) {
          SpikeHost.source = SpikeHost.Src.Embedded
          SpikeHost.bootOrReload(app, "open $module")
        }
        if (module == "cabs") {
          val c = Ota.unit("cabs")!!
          val ctx = SpikeHost.context()!!
          val loaded = OtaNative.probe(ctx, "__otaProbe.units.cabs").second
          if (loaded == "undefined" || loaded.startsWith("ERR")) {
            val o = OtaNative.evaluateBlocking(ctx, Ota.path("embedded/${c.file}"), c.entryId, "unit://cabs", Ota.hbcVersion, c.hash)
            append("open cabs: $o")
          }
        }
        runOnUiThread { startActivity(Intent(this, RnActivity::class.java).putExtra("module", module)) }
      } catch (t: Throwable) {
        append("open $module failed: $t")
        android.util.Log.e("OTA_SPIKE", "open failed", t)
      }
    }
  }
}

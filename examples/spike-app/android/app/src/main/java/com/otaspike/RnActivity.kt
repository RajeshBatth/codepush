package com.otaspike

import android.app.Activity
import android.os.Bundle
import android.widget.FrameLayout

/** Full-screen RN surface for the "Open host" / "Open cabs" buttons. */
class RnActivity : Activity() {
  private lateinit var container: FrameLayout
  private var surface: com.facebook.react.interfaces.fabric.ReactSurface? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    container = FrameLayout(this)
    setContentView(container)
    val module = intent.getStringExtra("module") ?: "SpikeHost"
    surface = SpikeHost.mount(this, container, module)
  }

  override fun onResume() {
    super.onResume()
    SpikeHost.host?.onHostResume(this)
  }

  override fun onPause() {
    super.onPause()
    SpikeHost.host?.onHostPause(this)
  }

  override fun onDestroy() {
    SpikeHost.unmount(container, surface)
    super.onDestroy()
  }

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    finish()
  }
}

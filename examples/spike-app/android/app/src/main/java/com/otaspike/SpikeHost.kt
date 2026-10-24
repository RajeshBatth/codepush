package com.otaspike

import android.app.Activity
import android.content.Context
import android.util.Log
import android.view.ViewGroup
import com.facebook.react.ReactHost
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.JSBundleLoader
import com.facebook.react.bridge.JSBundleLoaderDelegate
import com.facebook.react.bridge.ReactContext
import com.facebook.react.common.annotations.UnstableReactNativeAPI
import com.facebook.react.defaults.DefaultComponentsRegistry
import com.facebook.react.defaults.DefaultReactHostDelegate
import com.facebook.react.defaults.DefaultTurboModuleManagerDelegate
import com.facebook.react.fabric.ComponentFactory
import com.facebook.react.interfaces.fabric.ReactSurface
import com.facebook.react.runtime.ReactHostImpl
import com.facebook.react.runtime.hermes.HermesInstance
import java.util.concurrent.TimeUnit

/**
 * Lazily-created bridgeless ReactHost with a DYNAMIC JSBundleLoader.
 *
 * Why not DefaultReactHost.getDefaultReactHost(...)? It caches the host in a static and fixes the loader (the first call's
 * jsBundleFilePath wins forever), so S2/S7/S10 (switch host bundle, reload) would be impossible. ReactHostImpl's
 * constructor is public, ReactHostImpl re-reads delegate.jsBundleLoader on every (re)creation of the ReactInstance, and our
 * loader resolves `source` at loadScript() time, so ReactHost.reload() picks up a new bundle in-process.
 */
@OptIn(UnstableReactNativeAPI::class)
object SpikeHost {
  const val TAG = "OTA_SPIKE"
  const val EMBEDDED_ASSET = "assets://ota/embedded/host.hbc"

  sealed class Src {
    object Embedded : Src()
    data class File(val path: String) : Src()
    override fun toString() = if (this is File) "file:$path" else "embedded-asset"
  }

  @Volatile var source: Src = Src.Embedded
  @Volatile var host: ReactHost? = null
    private set

  private class DynamicLoader(val ctx: Context) : JSBundleLoader() {
    override fun loadScript(delegate: JSBundleLoaderDelegate): String =
        when (val s = source) {
          is Src.Embedded -> {
            delegate.loadScriptFromAssets(ctx.assets, EMBEDDED_ASSET, true)
            EMBEDDED_ASSET
          }
          is Src.File -> {
            // same call JSBundleLoader.createFileLoader(path) makes: sourceURL == path
            delegate.loadScriptFromFile(s.path, s.path, false)
            s.path
          }
        }
  }

  @Synchronized
  fun ensureHost(app: MainApplication): ReactHost {
    host?.let { return it }
    val factory = ComponentFactory()
    DefaultComponentsRegistry.register(factory)
    val packages: List<ReactPackage> = app.packages()
    val delegate =
        DefaultReactHostDelegate(
            jsMainModulePath = "index",
            jsBundleLoader = DynamicLoader(app),
            reactPackages = packages,
            jsRuntimeFactory = HermesInstance(),
            bindingsInstaller = null,
            exceptionHandler = { Log.e(TAG, "ReactHost exception", it) },
            turboModuleManagerDelegateBuilder = DefaultTurboModuleManagerDelegate.Builder())
    val h = ReactHostImpl(app, delegate, factory, false /* allowPackagerServerAccess */, false /* useDevSupport */)
    host = h
    return h
  }

  /** Boot (first time) or reload (VM recreate) from the current `source`. Blocking; call off the UI thread. */
  fun bootOrReload(app: MainApplication, reason: String) {
    val existed = host != null
    val h = ensureHost(app)
    val task = if (existed) h.reload(reason) else h.start()
    task.waitForCompletion()
    task.getError()?.let { throw it }
    waitReady()
  }

  fun context(): ReactContext? = host?.currentReactContext

  /** Poll until the host bundle ran far enough to create __otaProbe (host.hbc is the contract). */
  fun waitReady(timeoutMs: Long = 20000) {
    val end = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < end) {
      val c = context()
      if (c != null) {
        val v = OtaNative.probe(c, "__otaProbe.host").second
        if (v.startsWith("\"")) return
      }
      Thread.sleep(100)
    }
    throw IllegalStateException("host not ready after ${timeoutMs}ms (probe=${OtaNative.probe(context(), "__otaProbe.host")})")
  }

  // ---- surfaces (UI thread) ----
  fun mount(activity: Activity, container: ViewGroup, module: String): ReactSurface {
    val h = host ?: throw IllegalStateException("no host")
    val s = h.createSurface(activity, module, null)
    container.removeAllViews()
    container.addView(s.view, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    s.start()
    return s
  }

  fun unmount(container: ViewGroup, s: ReactSurface?) {
    try {
      s?.stop()?.waitForCompletion(2, TimeUnit.SECONDS)
    } catch (_: Throwable) {}
    container.removeAllViews()
    try {
      s?.detach()
    } catch (_: Throwable) {}
  }
}

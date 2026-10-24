package com.otaspike

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader

/**
 * HYBRID app: NOT a ReactApplication. No ReactHost / ReactNativeHost exists until SpikeHost.ensureHost() is called from
 * a button (lazy creation, DESIGN 5.4).
 */
class MainApplication : Application() {
  override fun onCreate() {
    super.onCreate()
    Ota.app = this
    SoLoader.init(this, OpenSourceMergedSoMapping)
    // Loads libappmodules / newarchdefaults only; creates no React instance.
    load()
  }

  fun packages() = PackageList(this).packages.apply { add(OtaUnitsPackage()) }
}

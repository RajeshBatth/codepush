package com.otaspike

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager

/**
 * Plain (legacy, non-Turbo) native module for S9: JS `__loadBundleAsync(name)` -> NativeOtaUnits.load(name) -> evaluate
 * the unit from filesDir WITHOUT running its entry (the import() that triggered it runs the entry via importAll).
 * Under bridgeless this is served by the TurboModule interop layer (NativeModules / TurboModuleRegistry.get).
 */
class OtaUnitsModule(private val rc: ReactApplicationContext) : ReactContextBaseJavaModule(rc) {
  override fun getName(): String = "NativeOtaUnits"

  @ReactMethod
  fun load(name: String, promise: Promise) {
    Ota.loadCalls.incrementAndGet()
    val spec = Ota.unit(name)
    if (spec == null) {
      promise.reject("E_NO_UNIT", "unknown unit $name")
      return
    }
    OtaNative.evaluateUnit(rc, Ota.path("embedded/${spec.file}"), -1.0, "unit://$name", Ota.hbcVersion, spec.hash) {
      if (it.ok) promise.resolve(null) else promise.reject(it.status, it.message)
    }
  }
}

class OtaUnitsPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
      listOf(OtaUnitsModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}

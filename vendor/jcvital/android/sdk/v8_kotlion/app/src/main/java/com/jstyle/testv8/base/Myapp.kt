package com.jstyle.testv8.base

import android.app.Application
import com.jstyle.testv8.ble.BleManager.Companion.init

class Myapp : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
        init(this)
    }

    companion object {
        var instance: Myapp? = null
            private set
    }
}

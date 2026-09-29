package com.jstyle.testv8.ble

import io.reactivex.Flowable
import io.reactivex.Observable
import io.reactivex.processors.FlowableProcessor
import io.reactivex.processors.PublishProcessor
import io.reactivex.subjects.PublishSubject
import io.reactivex.subjects.Subject


class RxBus private constructor() {
    private val bus: Subject<Any?>
    private val mBus: FlowableProcessor<Any?>

    init {
        mBus = PublishProcessor.create<Any?>().toSerialized()
        bus = PublishSubject.create<Any?>().toSerialized()
    }

    fun post(`object`: Any?) {
        bus.onNext(`object`!!)
    }

    fun <T> toObservable(eventType: Class<T?>): Observable<T?>? {
        return bus.ofType<T?>(eventType)
    }

    fun <T> toFlowable(tClass: Class<T?>): Flowable<T?>? {
        return mBus.ofType<T?>(tClass)
    }

    companion object {
        val instance: RxBus = RxBus()
    }
}

package com.hapi.eliteplus.connector.jcvital

import com.hapi.eliteplus.connector.jcvital.JCVitalV8ConnectionState.CONNECTED
import com.hapi.eliteplus.connector.jcvital.JCVitalV8ConnectionState.CONNECTING
import com.hapi.eliteplus.connector.jcvital.JCVitalV8ConnectionState.DISCONNECTED
import com.hapi.eliteplus.connector.jcvital.JCVitalV8ConnectionState.ERROR
import com.hapi.eliteplus.connector.jcvital.JCVitalV8ConnectionState.INITIALIZING
import com.hapi.eliteplus.connector.jcvital.JCVitalV8ConnectionState.READY
import com.hapi.eliteplus.connector.jcvital.JCVitalV8ConnectionState.SCANNING

class JCVitalV8ConnectionStateMachine(
    private val onTransition: (from: JCVitalV8ConnectionState, to: JCVitalV8ConnectionState, reason: String?) -> Unit = { _, _, _ -> },
) {
    @Volatile
    var state: JCVitalV8ConnectionState = DISCONNECTED
        private set

    val isLinkActive: Boolean get() = state in LINK_STATES

    fun canTransition(to: JCVitalV8ConnectionState): Boolean = to in (ALLOWED[state] ?: emptySet())

    /** Returns false (and leaves state unchanged) for no-op or illegal transitions. */
    @Synchronized
    fun transition(to: JCVitalV8ConnectionState, reason: String? = null): Boolean {
        val from = state
        if (from == to || !canTransition(to)) return false
        state = to
        onTransition(from, to, reason)
        return true
    }

    companion object {
        val LINK_STATES = setOf(CONNECTING, CONNECTED, INITIALIZING, READY)

        private val ALLOWED: Map<JCVitalV8ConnectionState, Set<JCVitalV8ConnectionState>> = mapOf(
            DISCONNECTED to setOf(SCANNING, CONNECTING, ERROR),
            SCANNING to setOf(DISCONNECTED, CONNECTING, ERROR),
            CONNECTING to setOf(CONNECTED, DISCONNECTED, ERROR),
            CONNECTED to setOf(INITIALIZING, DISCONNECTED, ERROR),
            INITIALIZING to setOf(READY, DISCONNECTED, ERROR),
            READY to setOf(DISCONNECTED, ERROR),
            ERROR to setOf(DISCONNECTED, SCANNING, CONNECTING),
        )
    }
}

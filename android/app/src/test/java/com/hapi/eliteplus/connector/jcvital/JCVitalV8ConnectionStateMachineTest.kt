package com.hapi.eliteplus.connector.jcvital

import com.hapi.eliteplus.connector.jcvital.JCVitalV8ConnectionState.CONNECTED
import com.hapi.eliteplus.connector.jcvital.JCVitalV8ConnectionState.CONNECTING
import com.hapi.eliteplus.connector.jcvital.JCVitalV8ConnectionState.DISCONNECTED
import com.hapi.eliteplus.connector.jcvital.JCVitalV8ConnectionState.ERROR
import com.hapi.eliteplus.connector.jcvital.JCVitalV8ConnectionState.INITIALIZING
import com.hapi.eliteplus.connector.jcvital.JCVitalV8ConnectionState.READY
import com.hapi.eliteplus.connector.jcvital.JCVitalV8ConnectionState.SCANNING
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class JCVitalV8ConnectionStateMachineTest {
    @Test
    fun happyPathReachesReadyAndEmitsEachTransition() {
        val seen = mutableListOf<Pair<JCVitalV8ConnectionState, JCVitalV8ConnectionState>>()
        val machine = JCVitalV8ConnectionStateMachine { from, to, _ -> seen += from to to }
        listOf(SCANNING, CONNECTING, CONNECTED, INITIALIZING, READY, DISCONNECTED).forEach { assertTrue(machine.transition(it)) }
        assertEquals(
            listOf(DISCONNECTED to SCANNING, SCANNING to CONNECTING, CONNECTING to CONNECTED, CONNECTED to INITIALIZING, INITIALIZING to READY, READY to DISCONNECTED),
            seen,
        )
    }

    @Test
    fun cannotSkipInitialization() {
        val machine = JCVitalV8ConnectionStateMachine()
        assertFalse(machine.transition(READY))
        machine.transition(CONNECTING)
        assertFalse(machine.transition(READY))
        machine.transition(CONNECTED)
        assertFalse(machine.transition(READY))
        assertEquals(CONNECTED, machine.state)
    }

    @Test
    fun cannotScanWhileLinked() {
        val machine = JCVitalV8ConnectionStateMachine()
        machine.transition(CONNECTING)
        assertFalse(machine.transition(SCANNING))
        assertTrue(machine.isLinkActive)
    }

    @Test
    fun errorIsReachableFromEveryStateAndRecoverable() {
        for (start in listOf(SCANNING, CONNECTING)) {
            val machine = JCVitalV8ConnectionStateMachine()
            machine.transition(start)
            assertTrue(machine.transition(ERROR))
        }
        val machine = JCVitalV8ConnectionStateMachine()
        listOf(CONNECTING, CONNECTED, INITIALIZING, READY, ERROR).forEach { assertTrue(machine.transition(it)) }
        assertFalse(machine.isLinkActive)
        assertTrue(machine.transition(CONNECTING))
    }

    @Test
    fun sameStateIsNoOpWithoutEvent() {
        var count = 0
        val machine = JCVitalV8ConnectionStateMachine { _, _, _ -> count++ }
        assertFalse(machine.transition(DISCONNECTED))
        assertEquals(0, count)
    }
}

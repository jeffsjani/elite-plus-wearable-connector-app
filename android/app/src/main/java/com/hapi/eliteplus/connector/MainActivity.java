package com.hapi.eliteplus.connector;

import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.hapi.eliteplus.connector.jcvital.JCVitalV8Plugin;
import com.hapi.eliteplus.connector.wellness.EliteDigitalWellnessPlugin;

public class MainActivity extends BridgeActivity {
	@Override
	protected void onCreate(Bundle savedInstanceState) {
		if (Build.VERSION.SDK_INT >= 28 && BuildConfig.HEALTH_CONNECT_ENABLED) {
			registerPlugin(EliteHealthConnectPlugin.class);
		}
		registerPlugin(JCVitalV8Plugin.class);
		registerPlugin(ConnectionDiagnosticExportPlugin.class);
		registerPlugin(EliteDigitalWellnessPlugin.class);
		super.onCreate(savedInstanceState);
	}
}

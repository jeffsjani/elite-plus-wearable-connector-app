package com.hapi.eliteplus.connector;

import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	@Override
	protected void onCreate(Bundle savedInstanceState) {
		if (Build.VERSION.SDK_INT >= 28) {
			registerPlugin(EliteHealthConnectPlugin.class);
		}
		super.onCreate(savedInstanceState);
	}
}

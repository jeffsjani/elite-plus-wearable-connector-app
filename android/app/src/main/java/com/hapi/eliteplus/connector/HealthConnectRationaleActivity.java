package com.hapi.eliteplus.connector;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

public class HealthConnectRationaleActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        TextView message = new TextView(this);
        message.setText("Elite+ reads the Health Connect data you select to provide personalized performance, recovery, and wellness insights. Your records are sent to your Elite+ account through the Connector's secure sync queue. You can revoke access in Health Connect settings.");
        message.setPadding(40, 64, 40, 40);
        message.setTextSize(18);
        setContentView(message);
    }
}
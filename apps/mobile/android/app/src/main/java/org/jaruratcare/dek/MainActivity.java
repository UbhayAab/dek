package org.jaruratcare.dek;

import android.os.Bundle;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // App-local plugins must be registered before the bridge starts.
        registerPlugin(DekNativePlugin.class);
        super.onCreate(savedInstanceState);

        // No bridge means the system WebView is missing, disabled or updating:
        // Capacitor already shows its "no WebView" screen; do not crash on top of it.
        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) return;

        // Replace Capacitor's chrome client with one that grants the web view only
        // the microphone and camera, only to the app's own origin, and only after
        // the Android runtime permission is granted.
        bridge.getWebView().setWebChromeClient(new DekWebChromeClient(bridge));
    }
}

package org.jaruratcare.dek;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // App-local plugins must be registered before the bridge starts.
        registerPlugin(DekNativePlugin.class);
        super.onCreate(savedInstanceState);

        // Replace Capacitor's chrome client with one that grants the web view only
        // the microphone and camera, only to the app's own origin, and only after
        // the Android runtime permission is granted.
        WebView webView = getBridge().getWebView();
        webView.setWebChromeClient(new DekWebChromeClient(getBridge()));
    }
}

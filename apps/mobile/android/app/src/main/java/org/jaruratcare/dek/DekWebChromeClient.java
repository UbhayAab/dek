package org.jaruratcare.dek;

import android.net.Uri;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.Logger;

/**
 * getUserMedia gate (APP03, DEK24).
 *
 * Capacitor's client already asks the Android runtime permission before it grants
 * the web view microphone or camera access, and denies when the person refuses.
 * This subclass narrows it further: requests from any origin other than the app's
 * own bundled origin, and requests for anything other than audio or video capture
 * (protected media ids, MIDI, geolocation), are denied outright.
 */
public class DekWebChromeClient extends BridgeWebChromeClient {

    private final Bridge bridge;

    public DekWebChromeClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public void onPermissionRequest(final PermissionRequest request) {
        if (!isAppOrigin(request.getOrigin())) {
            Logger.warn("DekWebChromeClient", "Denied media request from a foreign origin");
            request.deny();
            return;
        }
        for (String resource : request.getResources()) {
            boolean allowed =
                PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) ||
                PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource);
            if (!allowed) {
                Logger.warn("DekWebChromeClient", "Denied web view permission " + resource);
                request.deny();
                return;
            }
        }
        // Asks RECORD_AUDIO / CAMERA at run time; grants only when they are granted.
        super.onPermissionRequest(request);
    }

    @Override
    public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
        // Dek never uses location.
        callback.invoke(origin, false, false);
    }

    boolean isAppOrigin(Uri origin) {
        if (origin == null) return false;
        Uri app = Uri.parse(bridge.getLocalUrl());
        return (
            app.getScheme() != null &&
            app.getScheme().equalsIgnoreCase(origin.getScheme()) &&
            app.getHost() != null &&
            app.getHost().equalsIgnoreCase(origin.getHost()) &&
            app.getPort() == origin.getPort()
        );
    }
}

import type { CapacitorConfig } from '@capacitor/cli';

// Dek Android and iOS shells (APP01: Capacitor 8 around the same web app, see
// docs/NATIVE.md). The app always runs the bundled build in webDir; it never loads
// a remote page, so a compromised website cannot drive the native bridge.
const config: CapacitorConfig = {
  // PROPOSED identifier. Decision D02 / APPQ01 (the legal publisher) is open; this
  // id may change freely until the first upload to Play Console or App Store
  // Connect, and never after. Change it here, in android/app/build.gradle
  // (applicationId, namespace), the iOS PRODUCT_BUNDLE_IDENTIFIER and the two
  // files under apps/web/public/.well-known.
  appId: 'org.jaruratcare.dek',
  appName: 'Dek',
  // The canonical web build. scripts/android-build.mjs points DEK_WEB_DIR at
  // dist-native while apps/web/src/main.tsx does not call initNative() itself.
  webDir: process.env.DEK_WEB_DIR || '../web/dist',
  loggingBehavior: 'debug',
  server: {
    androidScheme: 'https',
    hostname: 'localhost',
  },
  android: {
    allowMixedContent: false,
    captureInput: false,
  },
  ios: {
    // The web app pads itself with env(safe-area-inset-*); no automatic insets.
    contentInset: 'never',
    preferredContentMode: 'mobile',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      launchAutoHide: true,
      launchFadeOutDuration: 150,
      backgroundColor: '#1a1030',
      showSpinner: false,
    },
    // iOS: the web view shrinks above the keyboard so the composer stays visible.
    // Android: Capacitor 8 SystemBars pads the web view by the keyboard height.
    Keyboard: {
      resize: 'native',
      resizeOnFullScreen: true,
    },
    SystemBars: {
      insetsHandling: 'css',
      style: 'DEFAULT',
      initialViewportFitValueHint: 'cover',
    },
    // No OS banner while the app is open: the open app already shows the message
    // through realtime, and a banner on top of the conversation is the duplicate
    // alert DEK17 forbids. Background and closed-app pushes are shown by the OS.
    PushNotifications: {
      presentationOptions: [],
    },
  },
};

export default config;

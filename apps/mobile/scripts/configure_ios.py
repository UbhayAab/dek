"""Configure the generated iOS project for Dek (APP12, APP13). Idempotent: safe to
re-run after `npx cap add ios` regenerates the project.

- Info.plist: camera, microphone and photo library purpose strings; background
  mode remote-notification only; the dek:// URL scheme; export compliance; arm64.
- App.entitlements: push (aps-environment) and Associated Domains (applinks and
  webcredentials for dek-7o4.pages.dev); wired through CODE_SIGN_ENTITLEMENTS.
- PrivacyInfo.xcprivacy: the app's privacy manifest, added to the bundle.
- AppDelegate.swift: hands the APNs token to the Capacitor push plugin.
- Version 2.0.0 (build 1).

There is no Mac here: this edits files only. Open ios/App/App.xcodeproj in Xcode
26 on a Mac to set the team, then build (docs/NATIVE.md, "iOS").
Run from apps/mobile: python scripts/configure_ios.py
"""
import hashlib
import plistlib
import re
from pathlib import Path

MOBILE = Path(__file__).resolve().parent.parent
APP = MOBILE / "ios" / "App" / "App"
PBX = MOBILE / "ios" / "App" / "App.xcodeproj" / "project.pbxproj"
WEB_HOST = "dek-7o4.pages.dev"
VERSION = "2.0.0"
BUILD = "1"

PURPOSES = {
    "NSCameraUsageDescription": "Dek uses the camera for video calls and for photos you choose to share in a conversation.",
    "NSMicrophoneUsageDescription": "Dek uses the microphone for voice and video calls and audio rooms.",
    "NSPhotoLibraryUsageDescription": "Dek lets you choose photos and videos from your library to share in a conversation.",
}


def info_plist():
    path = APP / "Info.plist"
    with path.open("rb") as f:
        info = plistlib.load(f)
    info.update(PURPOSES)
    info["CFBundleDisplayName"] = "Dek"
    info["UIBackgroundModes"] = ["remote-notification"]
    info["CFBundleURLTypes"] = [{
        "CFBundleURLName": "org.jaruratcare.dek",
        "CFBundleURLSchemes": ["dek"],
    }]
    info["ITSAppUsesNonExemptEncryption"] = False
    info["UIRequiredDeviceCapabilities"] = ["arm64"]
    with path.open("wb") as f:
        plistlib.dump(info, f, sort_keys=False)


def entitlements():
    ent = {
        # Xcode signs a distribution build with "production" from the profile.
        "aps-environment": "development",
        "com.apple.developer.associated-domains": [
            f"applinks:{WEB_HOST}",
            f"webcredentials:{WEB_HOST}",
        ],
    }
    with (APP / "App.entitlements").open("wb") as f:
        plistlib.dump(ent, f, sort_keys=False)


def privacy_manifest():
    def collected(kind):
        return {
            "NSPrivacyCollectedDataType": f"NSPrivacyCollectedDataType{kind}",
            "NSPrivacyCollectedDataTypeLinked": True,
            "NSPrivacyCollectedDataTypeTracking": False,
            "NSPrivacyCollectedDataTypePurposes": ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
        }

    manifest = {
        "NSPrivacyTracking": False,
        "NSPrivacyTrackingDomains": [],
        "NSPrivacyCollectedDataTypes": [
            collected(k) for k in (
                "Name", "EmailAddress", "OtherUserContent", "PhotosorVideos",
                "AudioData", "DeviceID", "ProductInteraction",
            )
        ],
        "NSPrivacyAccessedAPITypes": [],
    }
    with (APP / "PrivacyInfo.xcprivacy").open("wb") as f:
        plistlib.dump(manifest, f, sort_keys=False)


APPDELEGATE_HOOKS = '''
    // APNs hands the device token to the app delegate; the Capacitor push plugin
    // listens for these notifications (registration / registrationError events).
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
'''


def app_delegate():
    path = APP / "AppDelegate.swift"
    src = path.read_text(encoding="utf-8")
    if "capacitorDidRegisterForRemoteNotifications" in src:
        return
    marker = "    func application(_ application: UIApplication,\n                     configurationForConnecting"
    if marker not in src:
        raise SystemExit("AppDelegate.swift layout changed; add the APNs hooks by hand")
    path.write_text(src.replace(marker, APPDELEGATE_HOOKS.lstrip("\n") + "\n" + marker, 1), encoding="utf-8")


def pbx_id(name):
    return hashlib.md5(f"dek:{name}".encode()).hexdigest()[:24].upper()


def pbxproj():
    src = PBX.read_text(encoding="utf-8")
    src = re.sub(r"MARKETING_VERSION = [^;]+;", f"MARKETING_VERSION = {VERSION};", src)
    src = re.sub(r"CURRENT_PROJECT_VERSION = [^;]+;", f"CURRENT_PROJECT_VERSION = {BUILD};", src)
    if "CODE_SIGN_ENTITLEMENTS" not in src:
        src = src.replace(
            "\t\t\t\tCODE_SIGN_STYLE = Automatic;\n",
            "\t\t\t\tCODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n\t\t\t\tCODE_SIGN_STYLE = Automatic;\n",
        )

    ent_ref, priv_ref, priv_build = pbx_id("entitlements-ref"), pbx_id("privacy-ref"), pbx_id("privacy-build")
    if priv_ref not in src:
        src = src.replace(
            "/* End PBXBuildFile section */",
            f"\t\t{priv_build} /* PrivacyInfo.xcprivacy in Resources */ = {{isa = PBXBuildFile; fileRef = {priv_ref} /* PrivacyInfo.xcprivacy */; }};\n"
            "/* End PBXBuildFile section */",
        )
        src = src.replace(
            "/* End PBXFileReference section */",
            f"\t\t{ent_ref} /* App.entitlements */ = {{isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = App.entitlements; sourceTree = \"<group>\"; }};\n"
            f"\t\t{priv_ref} /* PrivacyInfo.xcprivacy */ = {{isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = \"<group>\"; }};\n"
            "/* End PBXFileReference section */",
        )
        src = src.replace(
            "\t\t\t\t504EC3131FED79650016851F /* Info.plist */,\n",
            "\t\t\t\t504EC3131FED79650016851F /* Info.plist */,\n"
            f"\t\t\t\t{ent_ref} /* App.entitlements */,\n"
            f"\t\t\t\t{priv_ref} /* PrivacyInfo.xcprivacy */,\n",
        )
        src = src.replace(
            "\t\t\t\t2FAD9763203C412B000D30F8 /* config.xml in Resources */,\n",
            "\t\t\t\t2FAD9763203C412B000D30F8 /* config.xml in Resources */,\n"
            f"\t\t\t\t{priv_build} /* PrivacyInfo.xcprivacy in Resources */,\n",
        )
    PBX.write_text(src, encoding="utf-8")
    for needle in ("CODE_SIGN_ENTITLEMENTS = App/App.entitlements;", priv_build, ent_ref, f"MARKETING_VERSION = {VERSION};"):
        if needle not in src:
            raise SystemExit(f"pbxproj patch incomplete: {needle}")


def main():
    info_plist()
    entitlements()
    privacy_manifest()
    app_delegate()
    pbxproj()
    print("iOS project configured")


if __name__ == "__main__":
    main()

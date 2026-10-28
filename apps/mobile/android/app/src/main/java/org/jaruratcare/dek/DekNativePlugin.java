package org.jaruratcare.dek;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Small app-local plugin: facts the web layer cannot learn by itself.
 *
 * pushConfigured: whether this build carries a Firebase configuration. Calling
 * PushNotifications.register() on a build without one throws inside the plugin and
 * Capacitor turns that into a crash, so the web layer asks here first and shows
 * "Push not configured on this build" instead (DEK19).
 */
@CapacitorPlugin(name = "DekNative")
public class DekNativePlugin extends Plugin {

    @Override
    public void load() {
        createNotificationChannels(getContext());
    }

    @PluginMethod
    public void info(PluginCall call) {
        Context ctx = getContext();
        JSObject ret = new JSObject();
        ret.put("platform", "android");
        ret.put("pushProvider", "fcm");
        ret.put("pushConfigured", isPushConfigured(ctx));
        ret.put("notificationsEnabled", NotificationManagerCompat.from(ctx).areNotificationsEnabled());
        ret.put("messagesChannelEnabled", channelEnabled(ctx, ctx.getString(R.string.dek_channel_messages_id)));
        ret.put("callsChannelEnabled", channelEnabled(ctx, ctx.getString(R.string.dek_channel_calls_id)));
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    /** Opens the system notification settings for Dek (blocked or denied cases). */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Context ctx = getContext();
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.getPackageName())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startOrReject(call, intent);
    }

    /** Opens the app details screen (microphone and camera permissions). */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Context ctx = getContext();
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.fromParts("package", ctx.getPackageName(), null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startOrReject(call, intent);
    }

    private void startOrReject(PluginCall call, Intent intent) {
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open settings", "settings_unavailable", e);
        }
    }

    /** The google-services Gradle plugin writes google_app_id only when configured. */
    static boolean isPushConfigured(Context ctx) {
        int id = ctx.getResources().getIdentifier("google_app_id", "string", ctx.getPackageName());
        return id != 0 && !ctx.getString(id).isEmpty();
    }

    static boolean channelEnabled(Context ctx, String id) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return false;
        NotificationChannel channel = nm.getNotificationChannel(id);
        return channel != null && channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    /** Channels exist before the first push so FCM never falls back to "Miscellaneous". */
    static void createNotificationChannels(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;

        NotificationChannel messages = new NotificationChannel(
            ctx.getString(R.string.dek_channel_messages_id),
            ctx.getString(R.string.dek_channel_messages_name),
            NotificationManager.IMPORTANCE_HIGH
        );
        messages.setDescription(ctx.getString(R.string.dek_channel_messages_description));
        messages.setShowBadge(true);
        messages.enableVibration(true);

        NotificationChannel calls = new NotificationChannel(
            ctx.getString(R.string.dek_channel_calls_id),
            ctx.getString(R.string.dek_channel_calls_name),
            NotificationManager.IMPORTANCE_HIGH
        );
        calls.setDescription(ctx.getString(R.string.dek_channel_calls_description));
        calls.setShowBadge(true);
        calls.enableVibration(true);
        calls.setSound(
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
            new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        );

        nm.createNotificationChannel(messages);
        nm.createNotificationChannel(calls);
    }
}

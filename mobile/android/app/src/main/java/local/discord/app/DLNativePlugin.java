package local.discord.app;

import android.content.Context;
import android.content.Intent;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** O que a interface web precisa do Android e o WebView não dá: call em segundo plano, alto-falante, abrir link. */
@CapacitorPlugin(name = "DLNative")
public class DLNativePlugin extends Plugin {

    @PluginMethod
    public void callActive(PluginCall call) {
        Context ctx = getContext();
        Intent intent = new Intent(ctx, CallService.class);
        AudioManager audio = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (call.getBoolean("active", false)) {
            audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
            ContextCompat.startForegroundService(ctx, intent);
        } else {
            ctx.stopService(intent);
            if (Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice();
            else audio.setSpeakerphoneOn(false);
            audio.setMode(AudioManager.MODE_NORMAL);
        }
        call.resolve();
    }

    @PluginMethod
    public void setSpeaker(PluginCall call) {
        boolean on = call.getBoolean("on", true);
        AudioManager audio = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (Build.VERSION.SDK_INT >= 31) {
            if (!on) {
                audio.clearCommunicationDevice();
            } else {
                for (AudioDeviceInfo d : audio.getAvailableCommunicationDevices()) {
                    if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                        audio.setCommunicationDevice(d);
                        break;
                    }
                }
            }
        } else {
            audio.setSpeakerphoneOn(on);
        }
        call.resolve();
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(call.getString("url")));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}

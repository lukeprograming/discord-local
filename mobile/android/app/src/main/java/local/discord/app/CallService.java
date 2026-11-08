package local.discord.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Serviço em primeiro plano durante a call: sem ele o Android corta o microfone
 * e acaba matando o app quando ele sai da tela.
 */
public class CallService extends Service {
    private static final String CHANNEL = "call";
    private PowerManager.WakeLock wakeLock;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Chamada em andamento", NotificationManager.IMPORTANCE_LOW));
        }
        PendingIntent open = PendingIntent.getActivity(
            this, 0, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setContentTitle("Discord Local")
            .setContentText("Em chamada — toque para abrir")
            .setContentIntent(open)
            .setOngoing(true)
            .build();

        if (Build.VERSION.SDK_INT >= 29) {
            // Microfone só pode ser declarado se a permissão já foi dada (senão o Android 14 derruba o app).
            // O tipo "microfone" só existe a partir do Android 11 (API 30); no Android 10 (ex.: Poco F1) usar dá erro.
            boolean mic = Build.VERSION.SDK_INT >= 30
                && ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
            int type = mic ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE | ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                           : ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
            startForeground(1, n, type);
        } else {
            startForeground(1, n);
        }

        if (wakeLock == null) {
            PowerManager pm = getSystemService(PowerManager.class);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "discordlocal:call");
            wakeLock.acquire(6 * 60 * 60 * 1000L); // teto de 6h, caso a call não seja encerrada direito
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

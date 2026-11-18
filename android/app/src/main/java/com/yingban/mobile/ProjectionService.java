package com.yingban.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Binder;
import android.os.Build;
import android.os.IBinder;

/** The Android media projection must run in a visible foreground service. */
public final class ProjectionService extends Service {
    final class LocalBinder extends Binder { ProjectionService service() { return ProjectionService.this; } }
    private final IBinder binder = new LocalBinder();
    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        manager.createNotificationChannel(new NotificationChannel("projection", "屏幕共享", NotificationManager.IMPORTANCE_LOW));
        Notification notification = new Notification.Builder(this, "projection")
            .setSmallIcon(android.R.drawable.ic_menu_share).setContentTitle("映伴正在共享屏幕")
            .setContentText("回到映伴即可停止共享").setOngoing(true).build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(43127, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        else startForeground(43127, notification);
    }
    @Override public IBinder onBind(Intent intent) { return binder; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) { return START_NOT_STICKY; }
}

package com.yingban.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONObject;
import org.webrtc.RendererCommon;
import org.webrtc.SurfaceViewRenderer;
import org.webrtc.VideoTrack;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

public final class MainActivity extends Activity implements RoomConnection.Listener, RtcSession.Listener {
    private static final int MIC_PERMISSION = 71, SCREEN_PERMISSION = 72, AVATAR_PICK = 73;
    private static final int BACKGROUND = Color.rgb(248, 243, 236), INK = Color.rgb(64, 50, 45), MUTED = Color.rgb(130, 112, 102), ACCENT = Color.rgb(184, 93, 67);
    private LinearLayout root, stageBody;
    private TextView statusView, remoteNameView, remoteStateView, localNameView, stageLabel;
    private ImageView localAvatarView, remoteAvatarView;
    private ImageButton micButton, shareButton;
    private FrameLayout stage;
    private SurfaceViewRenderer video;
    private VideoTrack remoteVideo;
    private RoomConnection room;
    private RtcSession rtc;
    private SharedPreferences prefs;
    private boolean inRoom, connecting, peerJoined, peerSharing, connected, boundProjection;
    private String role = "", peerName = "", peerAvatar = "", currentStatus = "等待对方加入";
    private Intent pendingProjection;
    private final ServiceConnection projectionConnection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            if (!inRoom || pendingProjection == null) { stopProjection(); return; }
            Intent permission = pendingProjection; pendingProjection = null;
            DisplayMetrics metrics = new DisplayMetrics(); getWindowManager().getDefaultDisplay().getRealMetrics(metrics);
            rtc.startScreen(permission, metrics.widthPixels, metrics.heightPixels);
            updateSession(); sendState();
            if (!rtc.isSharing()) stopProjection();
        }
        @Override public void onServiceDisconnected(ComponentName name) { boundProjection = false; if (rtc.isSharing()) { rtc.stopScreen(); sendState(); updateSession(); } }
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("profile", MODE_PRIVATE);
        room = new RoomConnection(this, this); rtc = new RtcSession(this, this);
        video = new SurfaceViewRenderer(this);
        video.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        video.setContentDescription("等待共享画面");
        video.init(rtc.eglContext(), new RendererCommon.RendererEvents() {
            @Override public void onFirstFrameRendered() { runOnUiThread(() -> video.setContentDescription("共享画面已接收")); }
            @Override public void onFrameResolutionChanged(int width, int height, int rotation) { }
        });
        video.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT);
        home();
        if (getIntent() != null && getIntent().getData() != null) acceptInvite(getIntent().getData());
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); if (intent.getData() != null) acceptInvite(intent.getData()); }
    private void acceptInvite(Uri data) {
        String invitation = data.toString();
        if (inRoom) new AlertDialog.Builder(this).setMessage("结束当前通话并加入新的房间？").setNegativeButton("取消", null)
            .setPositiveButton("加入", (d, w) -> { leave(); room.join(invitation); busy("正在加入…"); }).show();
        else { room.join(invitation); busy("正在加入…"); }
    }
    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private GradientDrawable rounded(int color, int radius) { GradientDrawable d = new GradientDrawable(); d.setColor(color); d.setCornerRadius(dp(radius)); return d; }
    private TextView text(String value, float size, int color) { TextView t = new TextView(this); t.setText(value); t.setTextSize(size); t.setTextColor(color); return t; }
    private LinearLayout column() { LinearLayout l = new LinearLayout(this); l.setOrientation(LinearLayout.VERTICAL); return l; }
    private LinearLayout row() { LinearLayout l = new LinearLayout(this); l.setOrientation(LinearLayout.HORIZONTAL); l.setGravity(Gravity.CENTER_VERTICAL); return l; }
    private void gap(LinearLayout parent, int size) { View v = new View(this); parent.addView(v, new LinearLayout.LayoutParams(1, dp(size))); }
    private Button button(String label, boolean primary) {
        Button b = new Button(this); b.setText(label); b.setTextSize(15); b.setAllCaps(false); b.setTextColor(primary ? Color.WHITE : INK);
        b.setBackground(rounded(primary ? ACCENT : Color.rgb(239, 230, 220), 14)); b.setMinHeight(dp(52)); return b;
    }
    private void addHeader(LinearLayout parent, String title, Runnable settings) {
        LinearLayout header = row(); TextView brand = text(title, 22, INK); brand.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        header.addView(brand, new LinearLayout.LayoutParams(0, dp(48), 1));
        ImageButton setting = icon(R.drawable.ic_settings, "设置", false); setting.setOnClickListener(v -> settings.run()); header.addView(setting, new LinearLayout.LayoutParams(dp(46), dp(46)));
        parent.addView(header);
    }
    private void setRoot(boolean scrollable) {
        root = column(); root.setPadding(dp(22), dp(16), dp(22), dp(18)); root.setBackgroundColor(BACKGROUND);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int left, top, right, bottom;
            if (Build.VERSION.SDK_INT >= 30) {
                Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                left = safe.left; top = safe.top; right = safe.right; bottom = safe.bottom;
            } else {
                left = insets.getSystemWindowInsetLeft(); top = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight(); bottom = insets.getSystemWindowInsetBottom();
            }
            view.setPadding(dp(22) + left, dp(16) + top, dp(22) + right, dp(18) + bottom);
            return insets;
        });
        if (scrollable) { ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.addView(root); setContentView(scroll); }
        else setContentView(root);
        root.requestApplyInsets();
    }
    private void home() {
        detachVideo(); setRoot(true); addHeader(root, "映伴", this::profileDialog); gap(root, 28);
        TextView title = text("一起看，一起聊", 28, INK); title.setTypeface(Typeface.DEFAULT, Typeface.BOLD); root.addView(title);
        gap(root, 8); root.addView(text("与身边的人共享画面和声音", 14, MUTED)); gap(root, 30);
        Button create = button("创建通话", true); root.addView(create, new LinearLayout.LayoutParams(-1, dp(56)));
        create.setOnClickListener(v -> { if (!connecting) { room.create(); busy("正在创建房间…"); } });
        gap(root, 20);
        TextView joinTitle = text("加入通话", 17, INK); joinTitle.setTypeface(Typeface.DEFAULT, Typeface.BOLD); root.addView(joinTitle); gap(root, 10);
        EditText input = new EditText(this); input.setSingleLine(true); input.setTextSize(16); input.setTextColor(INK); input.setHint("输入 6 位房间号或粘贴邀请链接");
        input.setPadding(dp(14), 0, dp(14), 0); input.setBackground(rounded(Color.WHITE, 12)); root.addView(input, new LinearLayout.LayoutParams(-1, dp(54))); gap(root, 12);
        Button join = button("加入房间", false); root.addView(join, new LinearLayout.LayoutParams(-1, dp(54)));
        join.setOnClickListener(v -> { if (connecting) return; String value = input.getText().toString().trim(); if (value.isEmpty()) { toast("请输入房间号或邀请链接"); return; } room.join(value); busy("正在寻找房间…"); });
        gap(root, 20); root.addView(text("房间号适用于同一局域网；跨网连接请使用邀请链接。", 13, MUTED));
    }
    private void busy(String value) { connecting = true; if (root != null) root.setAlpha(.65f); toast(value); }
    private void session() {
        detachVideo(); setRoot(false);
        LinearLayout header = row(); TextView title = text("映伴", 20, INK); title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        header.addView(title, new LinearLayout.LayoutParams(0, dp(44), 1));
        ImageButton settings = icon(R.drawable.ic_settings, "设置", false); settings.setOnClickListener(v -> profileDialog()); header.addView(settings, new LinearLayout.LayoutParams(dp(44), dp(44))); root.addView(header);
        statusView = text(currentStatus, 13, MUTED); root.addView(statusView); gap(root, 16);
        stage = new FrameLayout(this); stage.setBackground(rounded(Color.rgb(237, 226, 214), 18)); stage.setClipToOutline(true);
        root.addView(stage, new LinearLayout.LayoutParams(-1, 0, 1));
        stageBody = column(); stageBody.setGravity(Gravity.CENTER); stage.addView(stageBody, new FrameLayout.LayoutParams(-1, -1));
        stageLabel = text("等待对方加入", 14, MUTED); stageLabel.setGravity(Gravity.CENTER); stageBody.addView(stageLabel);
        LinearLayout participants = row(); participants.setGravity(Gravity.CENTER); LinearLayout.LayoutParams people = new LinearLayout.LayoutParams(-1, -2); people.topMargin = dp(20); stageBody.addView(participants, people);
        LinearLayout local = participant(); localAvatarView = (ImageView) local.getChildAt(0); localNameView = (TextView) local.getChildAt(1);
        ((TextView) local.getChildAt(2)).setText("已加入");
        LinearLayout remote = participant(); remoteAvatarView = (ImageView) remote.getChildAt(0); remoteNameView = (TextView) remote.getChildAt(1); remoteStateView = (TextView) remote.getChildAt(2);
        participants.addView(local, new LinearLayout.LayoutParams(0, -2, 1)); participants.addView(remote, new LinearLayout.LayoutParams(0, -2, 1));
        stage.addView(video, new FrameLayout.LayoutParams(-1, -1)); video.setVisibility(View.GONE);
        gap(root, 18);
        LinearLayout controls = row(); controls.setGravity(Gravity.CENTER); root.addView(controls);
        micButton = icon(R.drawable.ic_mic_off, "开启麦克风", true); micButton.setOnClickListener(v -> toggleMic()); controls.addView(micButton, new LinearLayout.LayoutParams(dp(58), dp(58)));
        addHorizontalGap(controls, 14);
        shareButton = icon(R.drawable.ic_screen, "共享屏幕", true); shareButton.setOnClickListener(v -> toggleScreen()); controls.addView(shareButton, new LinearLayout.LayoutParams(dp(58), dp(58)));
        addHorizontalGap(controls, 14);
        ImageButton invite = icon(R.drawable.ic_invite, "复制邀请", true); invite.setOnClickListener(v -> copyInvite()); controls.addView(invite, new LinearLayout.LayoutParams(dp(58), dp(58)));
        addHorizontalGap(controls, 14);
        ImageButton hangup = icon(R.drawable.ic_hangup, "结束通话", true); hangup.setBackground(rounded(Color.rgb(197, 77, 67), 28)); hangup.setColorFilter(Color.WHITE); hangup.setOnClickListener(v -> leave()); controls.addView(hangup, new LinearLayout.LayoutParams(dp(58), dp(58)));
        updateSession();
    }
    private void addHorizontalGap(LinearLayout parent, int width) { parent.addView(new View(this), new LinearLayout.LayoutParams(dp(width), 1)); }
    private ImageButton icon(int resource, String label, boolean circle) {
        ImageButton b = new ImageButton(this); b.setImageResource(resource); b.setColorFilter(INK); b.setContentDescription(label); b.setPadding(dp(13), dp(13), dp(13), dp(13));
        b.setBackground(rounded(circle ? Color.rgb(237, 225, 214) : BACKGROUND, circle ? 28 : 12)); return b;
    }
    private LinearLayout participant() {
        LinearLayout group = column(); group.setGravity(Gravity.CENTER); ImageView avatar = new ImageView(this); avatar.setScaleType(ImageView.ScaleType.CENTER_CROP);
        avatar.setBackground(rounded(Color.rgb(213, 156, 132), 38)); avatar.setClipToOutline(true); group.addView(avatar, new LinearLayout.LayoutParams(dp(76), dp(76)));
        TextView name = text("", 15, INK); name.setGravity(Gravity.CENTER); LinearLayout.LayoutParams n = new LinearLayout.LayoutParams(-1, -2); n.topMargin = dp(10); group.addView(name, n);
        TextView state = text("", 12, MUTED); state.setGravity(Gravity.CENTER); group.addView(state); return group;
    }
    private void avatar(ImageView view, String data) {
        if (data != null && data.startsWith("data:image/jpeg;base64,")) try {
            byte[] bytes = Base64.decode(data.substring(data.indexOf(',') + 1), Base64.DEFAULT); Bitmap image = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (image != null) { view.setImageBitmap(image); return; }
        } catch (Exception ignored) { }
        view.setImageResource(R.drawable.ic_person); view.setColorFilter(Color.WHITE);
    }
    private void updateSession() {
        if (!inRoom || stage == null) return;
        statusView.setText(room.code.isEmpty() ? currentStatus : "房间 " + room.code + " · " + currentStatus); localNameView.setText(profileName().isEmpty() ? "我" : profileName() + "（我）");
        remoteNameView.setText(peerName.isEmpty() ? "对方" : peerName); remoteStateView.setText(peerJoined ? (connected ? "已连接" : "正在连接") : "等待加入");
        localAvatarView.clearColorFilter(); remoteAvatarView.clearColorFilter(); avatar(localAvatarView, profileAvatar()); avatar(remoteAvatarView, peerAvatar);
        boolean showRemote = peerSharing && remoteVideo != null; video.setVisibility(showRemote ? View.VISIBLE : View.GONE); stageBody.setVisibility(showRemote ? View.GONE : View.VISIBLE);
        stageLabel.setText(rtc.isSharing() ? "正在共享手机画面" : peerSharing ? "等待对方的画面…" : peerJoined ? "通话中" : "等待对方加入");
        micButton.setImageResource(rtc.isMicOn() ? R.drawable.ic_mic : R.drawable.ic_mic_off); micButton.setContentDescription(rtc.isMicOn() ? "关闭麦克风" : "开启麦克风");
        shareButton.setColorFilter(rtc.isSharing() ? ACCENT : INK); shareButton.setContentDescription(rtc.isSharing() ? "停止共享" : "共享屏幕");
    }
    private void toggleMic() {
        if (rtc.isMicOn()) { rtc.setMicrophone(false); sendState(); updateSession(); return; }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MIC_PERMISSION); return; }
        rtc.setMicrophone(true); sendState(); updateSession();
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == MIC_PERMISSION) { if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED && inRoom) { rtc.setMicrophone(true); sendState(); updateSession(); } else toast("需要麦克风权限才能说话"); }
    }
    private void toggleScreen() {
        if (rtc.isSharing()) { rtc.stopScreen(); stopProjection(); sendState(); updateSession(); return; }
        if (peerSharing) { toast("对方正在共享，请先停止对方的共享"); return; }
        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        startActivityForResult(manager.createScreenCaptureIntent(), SCREEN_PERMISSION);
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == SCREEN_PERMISSION && result == RESULT_OK && data != null && inRoom) {
            pendingProjection = data; Intent service = new Intent(this, ProjectionService.class);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(service); else startService(service);
            boundProjection = bindService(service, projectionConnection, BIND_AUTO_CREATE);
            if (!boundProjection) { pendingProjection = null; stopService(service); toast("无法启动屏幕共享服务"); }
        } else if (request == AVATAR_PICK && result == RESULT_OK && data != null && data.getData() != null) saveAvatar(data.getData());
    }
    private void stopProjection() {
        pendingProjection = null;
        if (boundProjection) { unbindService(projectionConnection); boundProjection = false; }
        stopService(new Intent(this, ProjectionService.class));
    }
    private void copyInvite() {
        if (room.invite.isEmpty()) { toast("请让创建房间的一方复制邀请"); return; }
        String web = "https://baek-nanxun.github.io/yingban-windows/join/?target=" + Uri.encode(room.invite);
        ((ClipboardManager) getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("映伴邀请", "映伴房间号：" + room.code + "\n加入链接：" + web));
        toast("房间号和邀请链接已复制");
    }
    private String profileName() { return prefs.getString("name", ""); }
    private String profileAvatar() { return prefs.getString("avatar", ""); }
    private void profileDialog() {
        LinearLayout content = column(); content.setPadding(dp(24), dp(4), dp(24), dp(4));
        EditText nickname = new EditText(this); nickname.setSingleLine(true); nickname.setText(profileName()); nickname.setHint("昵称（最多 20 字）"); nickname.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(20)}); content.addView(nickname);
        Button choose = button("选择头像", false); LinearLayout.LayoutParams chooseParams = new LinearLayout.LayoutParams(-1, dp(48)); chooseParams.topMargin = dp(16); content.addView(choose, chooseParams);
        choose.setOnClickListener(v -> { Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT); pick.setType("image/*"); pick.addCategory(Intent.CATEGORY_OPENABLE); startActivityForResult(pick, AVATAR_PICK); });
        Button clear = button("使用默认头像", false); LinearLayout.LayoutParams clearParams = new LinearLayout.LayoutParams(-1, dp(48)); clearParams.topMargin = dp(8); content.addView(clear, clearParams);
        clear.setOnClickListener(v -> { prefs.edit().remove("avatar").apply(); sendProfile(); updateSession(); toast("已恢复默认头像"); });
        new AlertDialog.Builder(this).setTitle("个人资料").setView(content).setNegativeButton("取消", null).setPositiveButton("保存", (d, w) -> {
            prefs.edit().putString("name", nickname.getText().toString().trim()).apply(); sendProfile(); updateSession();
        }).show();
    }
    private void saveAvatar(Uri uri) {
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options(); bounds.inJustDecodeBounds = true;
            try (InputStream in = getContentResolver().openInputStream(uri)) { BitmapFactory.decodeStream(in, null, bounds); }
            if (bounds.outWidth < 1 || bounds.outHeight < 1) throw new IllegalArgumentException();
            BitmapFactory.Options options = new BitmapFactory.Options(); options.inSampleSize = Math.max(1, Math.max(bounds.outWidth, bounds.outHeight) / 256);
            Bitmap source; try (InputStream in = getContentResolver().openInputStream(uri)) { source = BitmapFactory.decodeStream(in, null, options); }
            if (source == null) throw new IllegalArgumentException();
            int side = Math.min(source.getWidth(), source.getHeight()); Bitmap square = Bitmap.createBitmap(source, (source.getWidth() - side) / 2, (source.getHeight() - side) / 2, side, side);
            Bitmap small = Bitmap.createScaledBitmap(square, 128, 128, true); ByteArrayOutputStream bytes = new ByteArrayOutputStream(); small.compress(Bitmap.CompressFormat.JPEG, 80, bytes);
            String avatar = "data:image/jpeg;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
            if (avatar.length() > 48000) throw new IllegalArgumentException();
            prefs.edit().putString("avatar", avatar).apply(); sendProfile(); updateSession(); toast("头像已保存");
        } catch (Exception e) { toast("无法读取头像，请选择其他图片"); }
    }
    private void sendState() {
        if (!inRoom) return;
        try { room.send(new JSONObject().put("type", "peer-state").put("sharing", rtc.isSharing()).put("muted", !rtc.isMicOn()).put("speaking", false).put("computerAudio", false).put("sourceDucked", false).put("duckEnabled", false).put("duckDepth", 15)); }
        catch (Exception ignored) { }
    }
    private void sendProfile() {
        if (!inRoom) return;
        try { room.send(new JSONObject().put("type", "profile").put("displayName", profileName()).put("avatarData", profileAvatar())); } catch (Exception ignored) { }
    }
    @Override public void onSignal(JSONObject message) {
        switch (message.optString("type")) {
            case "welcome": role = message.optString("role"); connecting = false; inRoom = true; currentStatus = "等待对方加入"; session(); break;
            case "peer-ready": peerJoined = true; currentStatus = "正在建立媒体连接"; rtc.buildPeer("host".equals(role)); sendState(); sendProfile(); updateSession(); break;
            case "description": if (inRoom && message.optJSONObject("description") != null) rtc.description(message.optJSONObject("description")); break;
            case "candidate": if (inRoom && message.optJSONObject("candidate") != null) rtc.candidate(message.optJSONObject("candidate")); break;
            case "peer-state": peerSharing = message.optBoolean("sharing"); updateSession(); break;
            case "profile": peerName = message.optString("displayName", ""); if (peerName.length() > 20) peerName = peerName.substring(0, 20);
                String avatar = message.optString("avatarData", ""); peerAvatar = avatar.length() <= 48000 && avatar.matches("data:image/jpeg;base64,[A-Za-z0-9+/=]+") ? avatar : ""; updateSession(); break;
            case "peer-left": peerJoined = peerSharing = connected = false; peerName = peerAvatar = ""; rtc.closePeer(); currentStatus = "对方已离开"; updateSession(); break;
        }
    }
    @Override public void send(JSONObject message) { room.send(message); }
    @Override public void state(String message, boolean success) { currentStatus = message; connected = success; updateSession(); }
    @Override public void remoteVideo(VideoTrack track) {
        if (remoteVideo != null) remoteVideo.removeSink(video); remoteVideo = track;
        if (track != null) track.addSink(video); updateSession();
    }
    @Override public void projectionEnded() { rtc.stopScreen(); stopProjection(); sendState(); updateSession(); toast("屏幕共享已停止"); }
    @Override public void onError(String message) { connecting = false; if (inRoom) leave(); else { room.close(); home(); } toast(message); }
    @Override public void error(String message) { toast(message); }
    private void detachVideo() { if (video != null && video.getParent() instanceof ViewGroup) ((ViewGroup) video.getParent()).removeView(video); }
    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
    private void leave() {
        inRoom = connecting = peerJoined = peerSharing = connected = false; role = peerName = peerAvatar = "";
        rtc.stopScreen(); stopProjection(); rtc.setMicrophone(false); rtc.closePeer(); room.close(); currentStatus = "等待对方加入"; home();
    }
    @Override public void onBackPressed() { if (inRoom) new AlertDialog.Builder(this).setMessage("结束当前通话？").setNegativeButton("取消", null).setPositiveButton("结束通话", (d, w) -> leave()).show(); else super.onBackPressed(); }
    @Override protected void onDestroy() { room.close(); rtc.stopScreen(); stopProjection(); rtc.closePeer(); video.release(); rtc.release(); super.onDestroy(); }
}

package com.yingban.mobile;

import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjection;
import android.os.Handler;
import android.os.Looper;
import org.json.JSONObject;
import org.webrtc.*;
import org.webrtc.audio.JavaAudioDeviceModule;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Media slots match desktop: 0 microphone, 1 shared sound, 2 screen video. */
final class RtcSession {
    interface Listener {
        void send(JSONObject message);
        void state(String message, boolean connected);
        void remoteVideo(VideoTrack track);
        void projectionEnded();
        void error(String message);
    }
    private static boolean initialized;
    private final Context context;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final EglBase egl;
    private final PeerConnectionFactory factory;
    private final JavaAudioDeviceModule audioDevice;
    private PeerConnection peer;
    private RtpTransceiver micSlot, audioSlot, videoSlot;
    private AudioSource micSource;
    private AudioTrack micTrack;
    private ScreenCapturerAndroid capturer;
    private SurfaceTextureHelper texture;
    private VideoSource screenSource;
    private VideoTrack screenTrack;
    private final List<IceCandidate> candidates = new ArrayList<>();
    private boolean remoteSet;
    private boolean remoteAttachScheduled;
    private boolean sharing;

    RtcSession(Context context, Listener listener) {
        this.context = context.getApplicationContext(); this.listener = listener;
        synchronized (RtcSession.class) {
            if (!initialized) { PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(this.context).createInitializationOptions()); initialized = true; }
        }
        egl = EglBase.create();
        // Keep the platform's low-latency audio effects. They avoid the
        // emulator's software audio path starving the video decoder when the
        // microphone is enabled, while physical devices still use their normal
        // vendor AEC/noise suppression implementation.
        audioDevice = JavaAudioDeviceModule.builder(this.context).setUseHardwareAcousticEchoCanceler(true).setUseHardwareNoiseSuppressor(true).createAudioDeviceModule();
        factory = PeerConnectionFactory.builder().setAudioDeviceModule(audioDevice)
            .setVideoEncoderFactory(new DefaultVideoEncoderFactory(egl.getEglBaseContext(), true, true))
            .setVideoDecoderFactory(new DefaultVideoDecoderFactory(egl.getEglBaseContext())).createPeerConnectionFactory();
    }
    EglBase.Context eglContext() { return egl.getEglBaseContext(); }
    boolean isMicOn() { return micTrack != null; }
    boolean isSharing() { return sharing; }

    void buildPeer(boolean initiator) {
        closePeer();
        PeerConnection.RTCConfiguration configuration = new PeerConnection.RTCConfiguration(Collections.emptyList());
        configuration.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        configuration.bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE;
        final PeerConnection[] holder = new PeerConnection[1];
        final PeerConnection current = factory.createPeerConnection(configuration, new PeerConnection.Observer() {
            @Override public void onSignalingChange(PeerConnection.SignalingState state) { }
            @Override public void onIceConnectionChange(PeerConnection.IceConnectionState state) { }
            @Override public void onIceConnectionReceivingChange(boolean value) { }
            @Override public void onIceGatheringChange(PeerConnection.IceGatheringState state) { }
            @Override public void onIceCandidatesRemoved(IceCandidate[] removed) { }
            @Override public void onAddStream(MediaStream stream) { }
            @Override public void onRemoveStream(MediaStream stream) { }
            @Override public void onDataChannel(DataChannel channel) { }
            @Override public void onRenegotiationNeeded() { }
            @Override public void onIceCandidate(IceCandidate candidate) {
                main.post(() -> {
                    if (holder[0] == null || peer != holder[0]) return;
                    try { JSONObject c = new JSONObject().put("candidate", candidate.sdp).put("sdpMid", candidate.sdpMid).put("sdpMLineIndex", candidate.sdpMLineIndex);
                        listener.send(new JSONObject().put("type", "candidate").put("candidate", c)); } catch (Exception ignored) { }
                });
            }
            @Override public void onConnectionChange(PeerConnection.PeerConnectionState state) {
                main.post(() -> { if (holder[0] == null || peer != holder[0]) return;
                    if (state == PeerConnection.PeerConnectionState.CONNECTED) listener.state("通话已连接", true);
                    else if (state == PeerConnection.PeerConnectionState.FAILED) listener.error("音视频连接失败，请检查局域网和防火墙。");
                    else if (state == PeerConnection.PeerConnectionState.DISCONNECTED) listener.state("网络中断，正在尝试恢复", false);
                });
            }
            // WebRTC may deliver onTrack just before setRemoteDescription's
            // callback assigns the stable transceiver slots. Retry attachment
            // on the main thread so a video track is not lost in that race.
            @Override public void onTrack(RtpTransceiver transceiver) { main.post(() -> {
                if (holder[0] != null && peer == holder[0]) attachRemote();
            }); }
        });
        if (current == null) { listener.error("无法初始化音视频连接。"); return; }
        holder[0] = current; peer = current;
        if (initiator) {
            micSlot = current.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO);
            audioSlot = current.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO);
            videoSlot = current.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO);
            attach();
            current.createOffer(new SdpCallback() {
                @Override public void onCreateSuccess(SessionDescription description) { main.post(() -> setLocal(current, description)); }
            }, new MediaConstraints());
        }
        listener.state("正在建立媒体连接", false);
    }

    void description(JSONObject object) {
        if (peer == null) buildPeer(false);
        PeerConnection current = peer;
        if (current == null) return;
        try {
            SessionDescription.Type type = SessionDescription.Type.fromCanonicalForm(object.getString("type"));
            SessionDescription description = new SessionDescription(type, object.getString("sdp"));
            current.setRemoteDescription(new SdpCallback() {
                @Override public void onSetSuccess() { main.post(() -> {
                    if (peer != current) return;
                    remoteSet = true;
                    for (IceCandidate c : candidates) current.addIceCandidate(c);
                    candidates.clear();
                    if (type == SessionDescription.Type.OFFER) {
                        List<RtpTransceiver> slots = current.getTransceivers();
                        if (slots.size() < 3) { listener.error("对方的媒体协议不兼容。"); return; }
                        micSlot = slots.get(0); audioSlot = slots.get(1); videoSlot = slots.get(2);
                        for (RtpTransceiver slot : slots) slot.setDirection(RtpTransceiver.RtpTransceiverDirection.SEND_RECV);
                        attach();
                    }
                    attachRemote();
                    if (type == SessionDescription.Type.OFFER) {
                        current.createAnswer(new SdpCallback() {
                            @Override public void onCreateSuccess(SessionDescription answer) { main.post(() -> setLocal(current, answer)); }
                        }, new MediaConstraints());
                    }
                }); }
            }, description);
        } catch (Exception e) { listener.error("无法处理对方的音视频信息。"); }
    }
    void candidate(JSONObject object) {
        try {
            IceCandidate candidate = new IceCandidate(object.optString("sdpMid", ""), object.getInt("sdpMLineIndex"), object.getString("candidate"));
            if (peer != null && remoteSet) peer.addIceCandidate(candidate); else candidates.add(candidate);
        } catch (Exception ignored) { }
    }
    private void setLocal(PeerConnection current, SessionDescription description) {
        if (peer != current) return;
        current.setLocalDescription(new SdpCallback() {
            @Override public void onSetSuccess() { main.post(() -> {
                if (peer != current) return;
                try { listener.send(new JSONObject().put("type", "description").put("description", new JSONObject().put("type", description.type.canonicalForm()).put("sdp", description.description))); }
                catch (Exception ignored) { }
            }); }
        }, description);
    }
    private abstract class SdpCallback implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription description) { }
        @Override public void onSetSuccess() { }
        @Override public void onCreateFailure(String error) { main.post(() -> listener.error("建立通话失败：" + error)); }
        @Override public void onSetFailure(String error) { main.post(() -> listener.error("建立通话失败：" + error)); }
    }
    private void attach() {
        if (micSlot != null) micSlot.getSender().setTrack(micTrack, false);
        if (audioSlot != null) audioSlot.getSender().setTrack(null, false);
        if (videoSlot != null) videoSlot.getSender().setTrack(screenTrack, false);
    }
    private void attachRemote() {
        MediaStreamTrack audio = audioSlot == null ? null : audioSlot.getReceiver().track();
        if (audio instanceof AudioTrack) ((AudioTrack) audio).setVolume(0.8);
        MediaStreamTrack video = videoSlot == null ? null : videoSlot.getReceiver().track();
        if (video instanceof VideoTrack) {
            remoteAttachScheduled = false;
            listener.remoteVideo((VideoTrack) video);
        } else if (peer != null && remoteSet && !remoteAttachScheduled) {
            remoteAttachScheduled = true;
            main.postDelayed(() -> {
                remoteAttachScheduled = false;
                if (peer != null && remoteSet) attachRemote();
            }, 100);
        }
    }
    void setMicrophone(boolean enabled) {
        if (enabled && micTrack == null) {
            MediaConstraints constraints = new MediaConstraints();
            constraints.mandatory.add(new MediaConstraints.KeyValuePair("googEchoCancellation", "true"));
            constraints.mandatory.add(new MediaConstraints.KeyValuePair("googNoiseSuppression", "true"));
            micSource = factory.createAudioSource(constraints); micTrack = factory.createAudioTrack("microphone", micSource);
            micTrack.setEnabled(true); attach();
        } else if (!enabled && micTrack != null) {
            AudioTrack oldTrack = micTrack; AudioSource oldSource = micSource; micTrack = null; micSource = null; attach();
            oldTrack.dispose(); oldSource.dispose();
        }
    }
    void startScreen(Intent permission, int width, int height) {
        if (sharing) return;
        try {
            capturer = new ScreenCapturerAndroid(permission, new MediaProjection.Callback() {
                @Override public void onStop() { main.post(() -> { if (sharing) listener.projectionEnded(); }); }
            });
            texture = SurfaceTextureHelper.create("YingBanScreen", egl.getEglBaseContext());
            screenSource = factory.createVideoSource(true);
            capturer.initialize(texture, context, screenSource.getCapturerObserver());
            float factor = Math.min(1f, 1920f / Math.max(width, height));
            int w = Math.max(2, ((int) (width * factor)) & ~1), h = Math.max(2, ((int) (height * factor)) & ~1);
            screenTrack = factory.createVideoTrack("screen", screenSource); screenTrack.setEnabled(true);
            capturer.startCapture(w, h, 24); sharing = true; attach();
        } catch (Exception e) { stopScreen(); listener.error("屏幕共享启动失败：" + e.getMessage()); }
    }
    void stopScreen() {
        sharing = false; VideoTrack oldTrack = screenTrack; screenTrack = null; attach();
        if (capturer != null) { capturer.stopCapture(); capturer.dispose(); capturer = null; }
        if (oldTrack != null) oldTrack.dispose();
        if (screenSource != null) { screenSource.dispose(); screenSource = null; }
        if (texture != null) { texture.dispose(); texture = null; }
    }
    void closePeer() {
        PeerConnection old = peer; peer = null; micSlot = audioSlot = videoSlot = null; remoteSet = false; remoteAttachScheduled = false; candidates.clear();
        listener.remoteVideo(null);
        if (old != null) { old.close(); old.dispose(); }
    }
    void release() { stopScreen(); setMicrophone(false); closePeer(); factory.dispose(); audioDevice.release(); egl.release(); }
}

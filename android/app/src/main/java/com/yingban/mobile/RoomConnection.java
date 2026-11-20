package com.yingban.mobile;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import android.net.Uri;
import org.java_websocket.WebSocket;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.handshake.ServerHandshake;
import org.java_websocket.server.WebSocketServer;
import org.json.JSONObject;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Implements the desktop's LAN discovery and two-peer signaling protocol. */
final class RoomConnection {
    interface Listener {
        void onSignal(JSONObject message);
        void onError(String message);
    }
    private static final int SIGNAL_PORT = 43127, DISCOVERY_PORT = 43128;
    private static final Set<String> RELAY_TYPES = new HashSet<>(Arrays.asList("description", "candidate", "peer-state", "profile"));
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Context context;
    private final Listener listener;
    private volatile WebSocketClient client;
    private volatile Server server;
    private volatile DatagramSocket discovery;
    private volatile Thread serverShutdown;
    private WifiManager.MulticastLock multicastLock;
    private volatile int generation;
    String code = "", invite = "";

    RoomConnection(Context context, Listener listener) { this.context = context.getApplicationContext(); this.listener = listener; }

    static URI endpoint(String input) throws Exception {
        String text = input.trim();
        int start = text.indexOf("https://baek-nanxun.github.io/yingban/join/?target=");
        if (start >= 0) {
            String url = text.substring(start).split("\\s", 2)[0];
            Uri uri = Uri.parse(url);
            text = uri.getQueryParameter("target");
        }
        if (text == null) throw new IllegalArgumentException("邀请链接无效。");
        URI uri = new URI(text.trim());
        if (!("yingban".equals(uri.getScheme()) || "clearcall".equals(uri.getScheme()) || "ws".equals(uri.getScheme()))
                || uri.getHost() == null || !uri.getHost().matches("[a-zA-Z0-9.-]+") || uri.getPort() < 1 || uri.getPort() > 65535
                || uri.getPath() == null || !uri.getPath().matches("/[a-f0-9]{48}")
                || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null)
            throw new IllegalArgumentException("邀请链接无效，请重新复制。");
        return new URI("ws", null, uri.getHost(), uri.getPort(), uri.getPath(), null, null);
    }

    void create() {
        close(); int current = generation;
        Thread previousShutdown = serverShutdown;
        new Thread(() -> {
            try {
                // WebSocketServer.stop() closes active peers before its
                // selector releases 43127. Do not race a new server against
                // that shutdown; the old 1.5s wait was shorter than the
                // close handshake on Android and left the next create() with
                // a false "port occupied" error.
                if (previousShutdown != null) {
                    previousShutdown.join(7000);
                    if (previousShutdown.isAlive()) throw new IllegalStateException("上一个房间仍在关闭，请稍后再试。");
                }
                if (generation != current) return;
                byte[] bytes = new byte[24]; new SecureRandom().nextBytes(bytes);
                StringBuilder secret = new StringBuilder();
                for (byte b : bytes) secret.append(String.format(Locale.ROOT, "%02x", b & 255));
                String token = secret.toString();
                String roomCode = String.valueOf(100000 + new SecureRandom().nextInt(900000));
                Server next = new Server(token); server = next; next.start();
                if (!next.started.await(8, TimeUnit.SECONDS) || next.failure != null) {
                    try { next.stop(1000); } catch (Exception ignored) { }
                    throw new IllegalStateException("无法创建房间，请确认 43127 端口未被占用。");
                }
                if (generation != current) { if (server == next) server = null; try { next.stop(5000); } catch (Exception ignored) { } return; }
                DatagramSocket udp = new DatagramSocket(null); udp.setReuseAddress(false); udp.bind(new InetSocketAddress(DISCOVERY_PORT)); discovery = udp;
                acquireMulticast();
                Thread responder = new Thread(() -> respond(udp, roomCode, token), "yingban-discovery"); responder.setDaemon(true); responder.start();
                List<String> addresses = localAddresses();
                if (addresses.isEmpty()) throw new IllegalStateException("没有可用的局域网地址，请连接 Wi-Fi。");
                code = roomCode; invite = "yingban://" + addresses.get(0) + ":" + SIGNAL_PORT + "/" + token;
                connect(new URI("ws://127.0.0.1:" + SIGNAL_PORT + "/" + token), current);
            } catch (Exception e) { fail(current, e.getMessage()); }
        }, "yingban-create").start();
    }

    void join(String input) {
        close(); int current = generation;
        new Thread(() -> {
            try {
                URI target;
                if (input.trim().matches("[0-9]{6}")) { code = input.trim(); target = findRoom(code); }
                else target = endpoint(input);
                if (generation == current) connect(target, current);
            } catch (Exception e) { fail(current, e.getMessage()); }
        }, "yingban-join").start();
    }

    private void connect(URI target, int current) throws Exception {
        WebSocketClient next = new WebSocketClient(target, new Draft_6455(Collections.emptyList(), 128 * 1024)) {
            @Override public void onOpen(ServerHandshake handshake) { }
            @Override public void onMessage(String text) {
                if (generation != current || text.length() > 128 * 1024) return;
                try { JSONObject message = new JSONObject(text); main.post(() -> { if (generation == current) listener.onSignal(message); }); }
                catch (Exception ignored) { }
            }
            @Override public void onClose(int code, String reason, boolean remote) {
                if (generation == current) fail(current, "Room full".equals(reason) ? "房间已满。" : "连接已断开，请确认对方在线并重新加入。");
            }
            @Override public void onError(Exception error) { }
        };
        next.setConnectionLostTimeout(25); client = next;
        if (!next.connectBlocking(8, TimeUnit.SECONDS)) throw new IllegalStateException("连接失败，请检查房间地址和防火墙。");
    }

    void send(JSONObject message) {
        WebSocketClient socket = client;
        if (socket != null && socket.isOpen() && RELAY_TYPES.contains(message.optString("type"))) socket.send(message.toString());
    }

    void close() {
        generation++;
        WebSocketClient c = client; client = null; if (c != null) c.close();
        DatagramSocket d = discovery; discovery = null; if (d != null) d.close();
        Server s = server; server = null;
        if (s != null) {
            Thread shutdown = new Thread(() -> {
                try { s.stop(5000); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            }, "yingban-server-close");
            serverShutdown = shutdown; shutdown.start();
        }
        synchronized (this) { if (multicastLock != null && multicastLock.isHeld()) multicastLock.release(); multicastLock = null; }
        code = ""; invite = "";
    }

    private void fail(int current, String text) { main.post(() -> { if (generation == current) listener.onError(text == null ? "连接失败，请重试。" : text); }); }
    private synchronized void acquireMulticast() {
        WifiManager wifi = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
        if (wifi != null) { multicastLock = wifi.createMulticastLock("yingban-discovery"); multicastLock.setReferenceCounted(false); multicastLock.acquire(); }
    }
    private static void respond(DatagramSocket socket, String code, String token) {
        byte[] buffer = new byte[1024];
        while (!socket.isClosed()) {
            try {
                DatagramPacket p = new DatagramPacket(buffer, buffer.length); socket.receive(p);
                String text = new String(p.getData(), p.getOffset(), p.getLength(), StandardCharsets.UTF_8);
                if (text.equals("YINGBAN_DISCOVER|" + code)) {
                    byte[] reply = ("YINGBAN_ROOM|" + code + "|" + token + "|" + SIGNAL_PORT).getBytes(StandardCharsets.UTF_8);
                    socket.send(new DatagramPacket(reply, reply.length, p.getAddress(), p.getPort()));
                }
            } catch (Exception ignored) { if (socket.isClosed()) break; }
        }
    }
    private static URI findRoom(String code) throws Exception {
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setBroadcast(true); socket.setSoTimeout(2000);
            byte[] query = ("YINGBAN_DISCOVER|" + code).getBytes(StandardCharsets.UTF_8);
            List<InetAddress> destinations = new ArrayList<>(); destinations.add(InetAddress.getByName("255.255.255.255"));
            for (NetworkInterface iface : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!iface.isUp() || iface.isLoopback()) continue;
                for (InterfaceAddress address : iface.getInterfaceAddresses()) if (address.getBroadcast() != null) destinations.add(address.getBroadcast());
            }
            for (InetAddress destination : destinations) try { socket.send(new DatagramPacket(query, query.length, destination, DISCOVERY_PORT)); } catch (Exception ignored) { }
            long until = System.currentTimeMillis() + 2000;
            while (System.currentTimeMillis() < until) {
                byte[] buffer = new byte[1024]; DatagramPacket response = new DatagramPacket(buffer, buffer.length); socket.receive(response);
                String[] parts = new String(response.getData(), response.getOffset(), response.getLength(), StandardCharsets.UTF_8).split("\\|");
                if (parts.length == 4 && parts[0].equals("YINGBAN_ROOM") && parts[1].equals(code) && parts[2].matches("[a-f0-9]{48}") && parts[3].matches("[0-9]{1,5}")) {
                    int port = Integer.parseInt(parts[3]);
                    if (port > 0 && port <= 65535) return new URI("ws://" + response.getAddress().getHostAddress() + ":" + port + "/" + parts[2]);
                }
            }
        } catch (java.net.SocketTimeoutException ignored) { }
        throw new IllegalStateException("找不到房间，请确认设备在同一局域网；跨网请使用邀请链接。");
    }
    private static List<String> localAddresses() throws Exception {
        List<String> result = new ArrayList<>();
        for (NetworkInterface iface : Collections.list(NetworkInterface.getNetworkInterfaces())) {
            if (!iface.isUp() || iface.isLoopback()) continue;
            for (InetAddress address : Collections.list(iface.getInetAddresses()))
                if (address instanceof Inet4Address && !address.isLoopbackAddress() && !address.isLinkLocalAddress()) result.add(address.getHostAddress());
        }
        result.sort((a, b) -> Boolean.compare(b.startsWith("100."), a.startsWith("100.")));
        return result;
    }

    private static final class Server extends WebSocketServer {
        final String token; final CountDownLatch started = new CountDownLatch(1);
        final Map<WebSocket, String> peers = new LinkedHashMap<>(); volatile Exception failure;
        Server(String token) { super(new InetSocketAddress("0.0.0.0", SIGNAL_PORT), Collections.singletonList(new Draft_6455(Collections.emptyList(), 128 * 1024))); this.token = token; setReuseAddr(true); setConnectionLostTimeout(25); }
        @Override public void onStart() { started.countDown(); }
        @Override public synchronized void onOpen(WebSocket socket, ClientHandshake request) {
            String path = request.getResourceDescriptor();
            if (request.hasFieldValue("Origin") || path == null || !path.matches("/[a-f0-9]{48}") || !MessageDigest.isEqual(path.substring(1).getBytes(StandardCharsets.US_ASCII), token.getBytes(StandardCharsets.US_ASCII))) { socket.close(1008, "Invalid invitation"); return; }
            if (peers.size() >= 2) { socket.close(1008, "Room full"); return; }
            String role = peers.isEmpty() ? "host" : "guest"; peers.put(socket, role); socket.setAttachment(new Bucket());
            send(socket, "{\"type\":\"welcome\",\"role\":\"" + role + "\"}");
            if (peers.size() == 2) for (WebSocket peer : peers.keySet()) send(peer, "{\"type\":\"peer-ready\"}");
        }
        @Override public synchronized void onMessage(WebSocket socket, String text) {
            Bucket bucket = socket.getAttachment();
            if (!peers.containsKey(socket) || text.length() > 128 * 1024 || bucket == null || !bucket.take()) { socket.close(1008, "Invalid message"); return; }
            try { if (RELAY_TYPES.contains(new JSONObject(text).optString("type"))) for (WebSocket peer : peers.keySet()) if (peer != socket) send(peer, text); }
            catch (Exception ignored) { }
        }
        @Override public synchronized void onClose(WebSocket socket, int status, String reason, boolean remote) {
            String role = peers.remove(socket); if (role == null) return;
            for (WebSocket other : new ArrayList<>(peers.keySet())) { send(other, "{\"type\":\"peer-left\"}"); if (role.equals("host")) other.close(1001, "Host left"); }
        }
        @Override public void onError(WebSocket socket, Exception error) { if (socket == null && started.getCount() > 0) { failure = error; started.countDown(); } }
        private static void send(WebSocket socket, String text) { if (socket.isOpen()) socket.send(text); }
    }
    private static final class Bucket {
        double available = 150; long last = System.currentTimeMillis();
        boolean take() { long now = System.currentTimeMillis(); available = Math.min(150, available + Math.max(0, now - last) * 0.05); last = now; available--; return available >= 0; }
    }
}

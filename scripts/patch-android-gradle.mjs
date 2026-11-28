import fs from 'node:fs';
import path from 'node:path';
import { installFeiArticalAndroidIcons } from './generate-android-icons.mjs';

const versionCode = process.env.VERSION_CODE;
const versionName = process.env.VERSION_NAME;

if (!versionCode || !versionName) {
  throw new Error('Missing VERSION_CODE or VERSION_NAME environment variables.');
}

const gradlePath = path.resolve(process.env.GRADLE_FILE || 'android/app/build.gradle');
let content = fs.readFileSync(gradlePath, 'utf8');

if (!/versionCode\s+\d+/.test(content) || !/versionName\s+"[^"]*"/.test(content)) {
  throw new Error(`Could not find versionCode/versionName in ${gradlePath}`);
}

content = content.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
content = content.replace(/versionName\s+"[^"]*"/, `versionName "${versionName}"`);

if (!content.includes('signingConfig signingConfigs.release')) {
  const buildTypesReleasePattern = /(buildTypes\s*\{[\s\S]*?\brelease\s*\{)/;
  if (!buildTypesReleasePattern.test(content)) {
    throw new Error(`Could not find buildTypes { release { ... } } in ${gradlePath}`);
  }
  content = content.replace(
    buildTypesReleasePattern,
    '$1\n            signingConfig signingConfigs.release'
  );
}

const signingBlock = [
  'signingConfigs {',
  '        release {',
  '            storeFile file(System.getenv("FEI_STORE_FILE") ?: project.findProperty("FEI_STORE_FILE"))',
  '            storePassword System.getenv("FEI_STORE_PASSWORD") ?: project.findProperty("FEI_STORE_PASSWORD")',
  '            keyAlias System.getenv("FEI_KEY_ALIAS") ?: project.findProperty("FEI_KEY_ALIAS")',
  '            keyPassword System.getenv("FEI_KEY_PASSWORD") ?: project.findProperty("FEI_KEY_PASSWORD")',
  '        }',
  '    }',
  '    buildTypes {',
].join('\n');

if (!/signingConfigs\s*\{/.test(content)) {
  if (!/buildTypes\s*\{/.test(content)) {
    throw new Error(`Could not find buildTypes block in ${gradlePath}`);
  }
  content = content.replace(/buildTypes\s*\{/, signingBlock);
}

// Add OkHttp dependency for full WebDAV method support (MKCOL / PROPFIND / PUT / GET) on Android
if (!content.includes('com.squareup.okhttp3:okhttp')) {
  content = content.replace(
    /dependencies\s*\{/,
    'dependencies {\n    implementation "com.squareup.okhttp3:okhttp:4.12.0"'
  );
}

// Add AndroidX DocumentFile for SAF real local folder read/write on Android 10-15
if (!content.includes('androidx.documentfile:documentfile')) {
  content = content.replace(
    /dependencies\s*\{/,
    'dependencies {\n    implementation "androidx.documentfile:documentfile:1.0.1"'
  );
}

fs.writeFileSync(gradlePath, content, 'utf8');
console.log(`Patched ${gradlePath}: versionName=${versionName}, versionCode=${versionCode}`);

// Prepend Google's Maven Central mirror before mavenCentral() to avoid repo.maven.apache.org 429 rate-limits in CI
const MAVEN_MIRROR_GROOVY = 'maven { url "https://maven-central.storage-download.googleapis.com/maven2/" }';
function injectMavenMirror(targetFile) {
  if (!fs.existsSync(targetFile)) return;
  let txt = fs.readFileSync(targetFile, 'utf8');
  if (txt.includes('maven-central.storage-download.googleapis.com/maven2')) return;
  if (/mavenCentral\(\)/.test(txt)) {
    txt = txt.replace(/^([ \t]*)mavenCentral\(\)/gm, `$1${MAVEN_MIRROR_GROOVY}\n$1mavenCentral()`);
    fs.writeFileSync(targetFile, txt, 'utf8');
    console.log(`Added Google Maven Central mirror in ${targetFile}`);
  }
}

const appDir = path.dirname(gradlePath);
const androidRootDir = path.dirname(appDir);
injectMavenMirror(path.join(androidRootDir, 'build.gradle'));
injectMavenMirror(path.join(androidRootDir, 'settings.gradle'));
injectMavenMirror(gradlePath);
injectMavenMirror(path.resolve('node_modules/@capacitor/android/capacitor/build.gradle'));

// Ensure required network & local folder storage permissions in AndroidManifest.xml
const manifestPath = path.join(appDir, 'src', 'main', 'AndroidManifest.xml');
if (fs.existsSync(manifestPath)) {
  let manifest = fs.readFileSync(manifestPath, 'utf8');
  const perms = [
    '<uses-permission android:name="android.permission.INTERNET" />',
    '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />',
    '<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />',
    '<uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />',
    '<uses-permission android:name="android.permission.WAKE_LOCK" />',
    '<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
    '<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />',
    '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
    '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />',
    '<uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />',
    '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
    '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />',
  ];
  for (const tag of perms) {
    const nameMatch = tag.match(/android:name="([^"]+)"/);
    if (nameMatch && !manifest.includes(nameMatch[1])) {
      manifest = manifest.replace(/<application\b/, `${tag}\n    <application`);
    }
  }
  if (!manifest.includes('android:requestLegacyExternalStorage')) {
    manifest = manifest.replace(
      /<application\b/,
      '<application\n        android:requestLegacyExternalStorage="true"'
    );
  }
  if (!manifest.includes('android:usesCleartextTraffic')) {
    manifest = manifest.replace(
      /<application\b/,
      '<application\n        android:usesCleartextTraffic="true"'
    );
  }
  if (!manifest.includes('LanWebDavKeepAliveService')) {
    const serviceTag =
      '        <service\n' +
      '            android:name=".LanWebDavKeepAliveService"\n' +
      '            android:exported="false"\n' +
      '            android:foregroundServiceType="dataSync"\n' +
      '            android:stopWithTask="true" />\n    </application>';
    manifest = manifest.replace(/<\/application>/, serviceTag);
  }
  fs.writeFileSync(manifestPath, manifest, 'utf8');
}

installFeiArticalAndroidIcons(appDir);

// Inject native OkHttp WebDavPlugin, pure-Java LanServerPlugin & camera-cutout-safe MainActivity
const javaPkgDir = path.join(appDir, 'src', 'main', 'java', 'com', 'feiartical', 'app');

if (fs.existsSync(javaPkgDir)) {
  const webDavPluginJava = `package com.feiartical.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

@CapacitorPlugin(name = "WebDavNative")
public class WebDavPlugin extends Plugin {

    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .build();

    private static final ExecutorService EXECUTOR = Executors.newCachedThreadPool();

    @PluginMethod
    public void request(PluginCall call) {
        String url = call.getString("url");
        String method = call.getString("method", "GET");
        JSObject headers = call.getObject("headers", new JSObject());
        String body = call.getString("body");
        String contentType = call.getString("contentType", "text/plain; charset=utf-8");

        if (url == null || url.isEmpty()) {
            call.reject("Missing url");
            return;
        }

        final String upperMethod = method.toUpperCase();

        EXECUTOR.execute(() -> {
            try {
                Request.Builder builder = new Request.Builder().url(url);

                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    String value = headers.getString(key);
                    if (value != null) {
                        builder.header(key, value);
                    }
                }

                RequestBody requestBody = null;
                if ("PUT".equals(upperMethod) || "POST".equals(upperMethod) || "PROPFIND".equals(upperMethod)) {
                    byte[] bytes = (body != null ? body : "").getBytes(StandardCharsets.UTF_8);
                    requestBody = RequestBody.create(bytes, MediaType.parse(contentType));
                }

                builder.method(upperMethod, requestBody);

                try (Response response = CLIENT.newCall(builder.build()).execute()) {
                    int status = response.code();
                    String responseBody;
                    if (status == 304 || "HEAD".equals(upperMethod) || response.body() == null) {
                        responseBody = "";
                    } else {
                        byte[] rawBytes = response.body().bytes();
                        responseBody = decodeSmartText(rawBytes);
                    }
                    String etag = response.header("ETag");
                    String lastModified = response.header("Last-Modified");

                    JSObject result = new JSObject();
                    result.put("status", status);
                    result.put("body", responseBody);
                    if (etag != null) result.put("etag", etag);
                    if (lastModified != null) result.put("lastModified", lastModified);
                    call.resolve(result);
                }
            } catch (IOException e) {
                JSObject result = new JSObject();
                result.put("status", 0);
                result.put("error", e.getMessage() != null ? e.getMessage() : "网络请求失败");
                call.resolve(result);
            } catch (Exception e) {
                JSObject result = new JSObject();
                result.put("status", 0);
                result.put("error", e.getMessage() != null ? e.getMessage() : "WebDAV 请求异常");
                call.resolve(result);
            }
        });
    }

    private static String decodeSmartText(byte[] rawBytes) {
        if (rawBytes == null || rawBytes.length == 0) {
            return "";
        }
        if (rawBytes.length >= 3
                && (rawBytes[0] & 0xFF) == 0xEF
                && (rawBytes[1] & 0xFF) == 0xBB
                && (rawBytes[2] & 0xFF) == 0xBF) {
            return new String(rawBytes, 3, rawBytes.length - 3, StandardCharsets.UTF_8);
        }
        if (rawBytes.length >= 2
                && (rawBytes[0] & 0xFF) == 0xFF
                && (rawBytes[1] & 0xFF) == 0xFE) {
            return new String(rawBytes, 2, rawBytes.length - 2, StandardCharsets.UTF_16LE);
        }
        if (rawBytes.length >= 2
                && (rawBytes[0] & 0xFF) == 0xFE
                && (rawBytes[1] & 0xFF) == 0xFF) {
            return new String(rawBytes, 2, rawBytes.length - 2, StandardCharsets.UTF_16BE);
        }
        try {
            CharsetDecoder utf8Decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
            String text = utf8Decoder.decode(ByteBuffer.wrap(rawBytes)).toString();
            if (!text.isEmpty() && text.charAt(0) == '\\uFEFF') {
                return text.substring(1);
            }
            return text;
        } catch (CharacterCodingException ignored) {
            try {
                return new String(rawBytes, Charset.forName("GB18030"));
            } catch (Exception ignored2) {
                try {
                    return new String(rawBytes, Charset.forName("GBK"));
                } catch (Exception ignored3) {
                    return new String(rawBytes, StandardCharsets.UTF_8);
                }
            }
        }
    }
}
`;

  const lanServerPluginJava = `package com.feiartical.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.Enumeration;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONObject;

@CapacitorPlugin(name = "LanServerNative")
public class LanServerPlugin extends Plugin {

    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final SecureRandom secureRandom = new SecureRandom();
    private final Map<String, Long> pendingNonces = new ConcurrentHashMap<>();
    private final Map<String, Long> validTokens = new ConcurrentHashMap<>();
    private final Map<String, long[]> failedAuthByIp = new ConcurrentHashMap<>();
    private volatile ServerSocket serverSocket;
    private volatile boolean running = false;
    private volatile int activePort = 8899;
    private volatile String activeIp = "";
    private volatile String pageHtml = "";
    private volatile String stateJson = "{\\"folders\\":[],\\"docs\\":[]}";
    private volatile String authPassword = "";

    @PluginMethod
    public void start(PluginCall call) {
        int preferredPort = call.getInt("port", 8899);
        String html = call.getString("html", "");
        String state = call.getString("stateJson", "{\\"folders\\":[],\\"docs\\":[]}");
        String password = call.getString("password", "");

        this.pageHtml = html != null ? html : "";
        this.stateJson = state != null ? state : "{\\"folders\\":[],\\"docs\\":[]}";
        this.authPassword = password != null ? password : "";
        this.pendingNonces.clear();
        this.validTokens.clear();
        this.failedAuthByIp.clear();

        if (running && serverSocket != null && !serverSocket.isClosed()) {
            JSObject res = new JSObject();
            res.put("running", true);
            res.put("ip", activeIp);
            res.put("port", activePort);
            res.put("url", "http://" + activeIp + ":" + activePort);
            call.resolve(res);
            return;
        }

        String ip = resolveLanIpv4();
        if (ip == null || ip.isEmpty()) {
            call.reject("未检测到局域网 Wi-Fi，请确认手机已连接 Wi-Fi");
            return;
        }

        ServerSocket socket = null;
        int boundPort = preferredPort;
        for (int p = preferredPort; p <= preferredPort + 10; p++) {
            try {
                socket = new ServerSocket(p);
                boundPort = p;
                break;
            } catch (IOException ignored) {
            }
        }

        if (socket == null) {
            call.reject("无法启动本地端口，请重试");
            return;
        }

        this.serverSocket = socket;
        this.activePort = boundPort;
        this.activeIp = ip;
        this.running = true;

        final ServerSocket listening = socket;
        executor.execute(() -> {
            while (running && !listening.isClosed()) {
                try {
                    Socket client = listening.accept();
                    executor.execute(() -> handleClient(client));
                } catch (IOException e) {
                    if (!running) break;
                }
            }
        });

        JSObject res = new JSObject();
        res.put("running", true);
        res.put("ip", activeIp);
        res.put("port", activePort);
        res.put("url", "http://" + activeIp + ":" + activePort);
        call.resolve(res);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopInternal();
        JSObject res = new JSObject();
        res.put("running", false);
        call.resolve(res);
    }

    @PluginMethod
    public void updateState(PluginCall call) {
        String state = call.getString("stateJson");
        if (state != null) {
            this.stateJson = state;
        }
        JSObject res = new JSObject();
        res.put("ok", true);
        call.resolve(res);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject res = new JSObject();
        res.put("running", running);
        res.put("ip", activeIp);
        res.put("port", activePort);
        res.put("url", running && !activeIp.isEmpty() ? ("http://" + activeIp + ":" + activePort) : "");
        call.resolve(res);
    }

    @Override
    protected void handleOnDestroy() {
        stopInternal();
        super.handleOnDestroy();
    }

    private void stopInternal() {
        running = false;
        authPassword = "";
        pendingNonces.clear();
        validTokens.clear();
        failedAuthByIp.clear();
        ServerSocket s = serverSocket;
        serverSocket = null;
        if (s != null) {
            try {
                s.close();
            } catch (IOException ignored) {
            }
        }
    }

    private boolean isIpLockedOut(String ip) {
        long[] info = failedAuthByIp.get(ip);
        if (info == null) return false;
        long now = System.currentTimeMillis();
        if (now - info[1] > 60_000L) {
            failedAuthByIp.remove(ip);
            return false;
        }
        return info[0] >= 5L;
    }

    private void recordFailedAuth(String ip) {
        long now = System.currentTimeMillis();
        long[] info = failedAuthByIp.get(ip);
        if (info == null || now - info[1] > 60_000L) {
            failedAuthByIp.put(ip, new long[] { 1L, now });
        } else {
            info[0] += 1L;
            info[1] = now;
        }
    }

    private boolean isTokenAuthorized(String token) {
        if (authPassword == null || authPassword.isEmpty()) return true;
        if (token == null || token.isEmpty()) return false;
        Long expiry = validTokens.get(token);
        if (expiry == null) return false;
        if (System.currentTimeMillis() > expiry) {
            validTokens.remove(token);
            return false;
        }
        return true;
    }

    private String randomHex(int byteLen) {
        byte[] buf = new byte[byteLen];
        secureRandom.nextBytes(buf);
        return toHex(buf);
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format(Locale.ROOT, "%02x", b & 0xff));
        }
        return sb.toString();
    }

    private static byte[] sha256(String input) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        return md.digest(input.getBytes(StandardCharsets.UTF_8));
    }

    private static String hmacSha256Hex(byte[] key, String message) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return toHex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
    }

    private static boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null || a.length() != b.length()) return false;
        int diff = 0;
        for (int i = 0; i < a.length(); i++) {
            diff |= a.charAt(i) ^ b.charAt(i);
        }
        return diff == 0;
    }

    private void handleClient(Socket client) {
        try (Socket sock = client) {
            sock.setSoTimeout(30000);
            String remoteIp = sock.getInetAddress() != null ? sock.getInetAddress().getHostAddress() : "unknown";
            InputStream in = new BufferedInputStream(sock.getInputStream());
            OutputStream out = sock.getOutputStream();

            String headerBlock = readHeaderBlock(in);
            if (headerBlock == null || headerBlock.isEmpty()) return;

            String[] lines = headerBlock.split("\\r\\n");
            if (lines.length == 0) return;

            String[] reqParts = lines[0].split(" ");
            if (reqParts.length < 2) return;

            String method = reqParts[0].toUpperCase(Locale.ROOT);
            String fullPath = reqParts[1];
            int qIdx = fullPath.indexOf('?');
            String path = qIdx >= 0 ? fullPath.substring(0, qIdx) : fullPath;

            int contentLength = 0;
            String lanToken = "";
            for (int i = 1; i < lines.length; i++) {
                int colon = lines[i].indexOf(':');
                if (colon > 0) {
                    String k = lines[i].substring(0, colon).trim().toLowerCase(Locale.ROOT);
                    String v = lines[i].substring(colon + 1).trim();
                    if ("content-length".equals(k)) {
                        try {
                            contentLength = Integer.parseInt(v);
                        } catch (NumberFormatException ignored) {
                        }
                    } else if ("x-lan-token".equals(k)) {
                        lanToken = v;
                    }
                }
            }

            String requestBody = "";
            if (contentLength > 0 && contentLength <= 64 * 1024 * 1024) {
                byte[] buf = readExactBytes(in, contentLength);
                requestBody = new String(buf, StandardCharsets.UTF_8);
            }

            if ("OPTIONS".equals(method)) {
                writeResponse(out, 204, "No Content", "text/plain; charset=utf-8", "");
                return;
            }

            if ("GET".equals(method) && ("/".equals(path) || "/index.html".equals(path) || "/pc".equals(path))) {
                writeResponse(out, 200, "OK", "text/html; charset=utf-8", pageHtml);
                return;
            }

            if ("GET".equals(method) && "/api/auth/challenge".equals(path)) {
                boolean reqAuth = authPassword != null && !authPassword.isEmpty();
                JSONObject resp = new JSONObject();
                resp.put("required", reqAuth);
                if (reqAuth) {
                    if (isIpLockedOut(remoteIp)) {
                        writeResponse(out, 429, "Too Many Requests", "application/json; charset=utf-8", "{\\"error\\":\\"密码错误次数过多，请 1 分钟后再试\\"}");
                        return;
                    }
                    String nonce = randomHex(16);
                    long now = System.currentTimeMillis();
                    pendingNonces.entrySet().removeIf(e -> now > e.getValue());
                    pendingNonces.put(nonce, now + 120_000L);
                    resp.put("nonce", nonce);
                }
                writeResponse(out, 200, "OK", "application/json; charset=utf-8", resp.toString());
                return;
            }

            if ("POST".equals(method) && "/api/auth/login".equals(path)) {
                if (authPassword == null || authPassword.isEmpty()) {
                    writeResponse(out, 200, "OK", "application/json; charset=utf-8", "{\\"ok\\":true,\\"token\\":\\"open\\"}");
                    return;
                }
                if (isIpLockedOut(remoteIp)) {
                    writeResponse(out, 429, "Too Many Requests", "application/json; charset=utf-8", "{\\"error\\":\\"密码错误次数过多，请 1 分钟后再试\\"}");
                    return;
                }
                JSONObject bodyObj = new JSONObject(requestBody.isEmpty() ? "{}" : requestBody);
                String nonce = bodyObj.optString("nonce", "");
                String proof = bodyObj.optString("proof", "");
                Long nonceExp = pendingNonces.remove(nonce);
                if (nonceExp == null || System.currentTimeMillis() > nonceExp) {
                    writeResponse(out, 401, "Unauthorized", "application/json; charset=utf-8", "{\\"error\\":\\"验证已过期，请重试\\"}");
                    return;
                }
                byte[] authKey = sha256("fei-lan-auth-v1:" + authPassword);
                String expected = hmacSha256Hex(authKey, "pc:" + nonce);
                if (!constantTimeEquals(expected, proof.toLowerCase(Locale.ROOT))) {
                    recordFailedAuth(remoteIp);
                    writeResponse(out, 401, "Unauthorized", "application/json; charset=utf-8", "{\\"error\\":\\"加密密码错误\\"}");
                    return;
                }
                failedAuthByIp.remove(remoteIp);
                String token = randomHex(24);
                validTokens.put(token, System.currentTimeMillis() + 12L * 3600L * 1000L);
                JSONObject resp = new JSONObject();
                resp.put("ok", true);
                resp.put("token", token);
                writeResponse(out, 200, "OK", "application/json; charset=utf-8", resp.toString());
                return;
            }

            if ("GET".equals(method) && "/api/state".equals(path)) {
                if (!isTokenAuthorized(lanToken)) {
                    writeResponse(out, 401, "Unauthorized", "application/json; charset=utf-8", "{\\"error\\":\\"需要验证加密密码\\"}");
                    return;
                }
                writeResponse(out, 200, "OK", "application/json; charset=utf-8", stateJson);
                return;
            }

            if ("POST".equals(method) && "/api/action".equals(path)) {
                if (!isTokenAuthorized(lanToken)) {
                    writeResponse(out, 401, "Unauthorized", "application/json; charset=utf-8", "{\\"error\\":\\"需要验证加密密码\\"}");
                    return;
                }
                JSObject payload = new JSObject();
                payload.put("actionJson", requestBody);
                notifyListeners("lanAction", payload);
                writeResponse(out, 200, "OK", "application/json; charset=utf-8", "{\\"ok\\":true}");
                return;
            }

            writeResponse(out, 404, "Not Found", "text/plain; charset=utf-8", "Not Found");
        } catch (Exception ignored) {
        }
    }

    private static String readHeaderBlock(InputStream in) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        int state = 0;
        int b;
        while ((b = in.read()) != -1) {
            baos.write(b);
            if (baos.size() > 65536) return null;
            if (state == 0 && b == '\\r') state = 1;
            else if (state == 1 && b == '\\n') state = 2;
            else if (state == 2 && b == '\\r') state = 3;
            else if (state == 3 && b == '\\n') break;
            else state = (b == '\\r') ? 1 : 0;
        }
        return baos.toString(StandardCharsets.UTF_8.name());
    }

    private static byte[] readExactBytes(InputStream in, int length) throws IOException {
        byte[] data = new byte[length];
        int offset = 0;
        while (offset < length) {
            int n = in.read(data, offset, length - offset);
            if (n < 0) break;
            offset += n;
        }
        return data;
    }

    private static void writeResponse(OutputStream out, int code, String reason, String contentType, String body)
        throws IOException {
        byte[] bodyBytes = body.getBytes(StandardCharsets.UTF_8);
        String headers =
            "HTTP/1.1 " + code + " " + reason + "\\r\\n" +
            "Content-Type: " + contentType + "\\r\\n" +
            "Content-Length: " + bodyBytes.length + "\\r\\n" +
            "Access-Control-Allow-Origin: *\\r\\n" +
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\\r\\n" +
            "Access-Control-Allow-Headers: Content-Type, X-Lan-Token\\r\\n" +
            "Cache-Control: no-store\\r\\n" +
            "Connection: close\\r\\n\\r\\n";
        out.write(headers.getBytes(StandardCharsets.UTF_8));
        if (bodyBytes.length > 0) {
            out.write(bodyBytes);
        }
        out.flush();
    }

    private static String resolveLanIpv4() {
        String fallback = null;
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            if (ifaces == null) return null;
            for (NetworkInterface nif : Collections.list(ifaces)) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                String name = nif.getName().toLowerCase(Locale.ROOT);
                for (InetAddress addr : Collections.list(nif.getInetAddresses())) {
                    if (addr.isLoopbackAddress() || !(addr instanceof Inet4Address)) continue;
                    String ip = addr.getHostAddress();
                    if (ip == null) continue;
                    if (name.startsWith("wlan") || name.startsWith("eth") || name.startsWith("ap")) {
                        return ip;
                    }
                    if (fallback == null) {
                        fallback = ip;
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return fallback;
    }
}
`;

  const readerNativePluginJava = `package com.feiartical.app;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "ReaderNative",
    permissions = {
        @Permission(
            alias = "microphone",
            strings = { Manifest.permission.RECORD_AUDIO }
        )
    }
)
public class ReaderNativePlugin extends Plugin {
    private static volatile ReaderNativePlugin activeInstance;
    public static volatile boolean volumeKeyInterceptEnabled = false;
    public static volatile boolean touchStateTrackingEnabled = false;
    public static volatile boolean inputPasteTrackingEnabled = false;
    public static volatile boolean isScreenTouched = false;

    @Override
    public void load() {
        super.load();
        activeInstance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (activeInstance == this) {
            activeInstance = null;
        }
        volumeKeyInterceptEnabled = false;
        touchStateTrackingEnabled = false;
        inputPasteTrackingEnabled = false;
        isScreenTouched = false;
        super.handleOnDestroy();
    }

    @PluginMethod
    public void setVolumeKeyIntercept(PluginCall call) {
        volumeKeyInterceptEnabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        call.resolve();
    }

    @PluginMethod
    public void setTouchStateTracking(PluginCall call) {
        touchStateTrackingEnabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        JSObject res = new JSObject();
        res.put("pressed", isScreenTouched);
        call.resolve(res);
    }

    @PluginMethod
    public void setInputPasteTracking(PluginCall call) {
        inputPasteTrackingEnabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        call.resolve();
    }

    @PluginMethod
    public void readClipboardText(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            JSObject res = new JSObject();
            res.put("text", "");
            call.resolve(res);
            return;
        }
        activity.runOnUiThread(() -> {
            String text = "";
            try {
                ClipboardManager clipboard =
                    (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                if (clipboard != null && clipboard.hasPrimaryClip()) {
                    ClipData clip = clipboard.getPrimaryClip();
                    if (clip != null && clip.getItemCount() > 0) {
                        CharSequence cs = clip.getItemAt(0).coerceToText(activity);
                        if (cs != null) {
                            text = cs.toString();
                        }
                    }
                }
            } catch (Exception ignored) {
                text = "";
            }
            JSObject res = new JSObject();
            res.put("text", text);
            call.resolve(res);
        });
    }

    @PluginMethod
    public void requestMicrophonePermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            JSObject res = new JSObject();
            res.put("granted", true);
            call.resolve(res);
            return;
        }
        requestPermissionForAlias("microphone", call, "onMicrophonePermResult");
    }

    @PermissionCallback
    private void onMicrophonePermResult(PluginCall call) {
        JSObject res = new JSObject();
        res.put("granted", getPermissionState("microphone") == PermissionState.GRANTED);
        call.resolve(res);
    }

    public static void dispatchVolumeKey(String direction) {
        ReaderNativePlugin instance = activeInstance;
        if (instance == null) return;
        JSObject payload = new JSObject();
        payload.put("direction", direction);
        instance.notifyListeners("volumeKey", payload);
    }

    public static void dispatchTouchState(boolean pressed, float cssX, float cssY, boolean hasCoords) {
        if (isScreenTouched == pressed) return;
        isScreenTouched = pressed;
        if (!touchStateTrackingEnabled) return;
        ReaderNativePlugin instance = activeInstance;
        if (instance == null) return;
        JSObject payload = new JSObject();
        payload.put("pressed", pressed);
        if (hasCoords) {
            payload.put("x", cssX);
            payload.put("y", cssY);
        }
        instance.notifyListeners("touchState", payload);
    }

    public static void dispatchTouchState(boolean pressed) {
        dispatchTouchState(pressed, 0f, 0f, false);
    }

    public static void dispatchTouchMove(float cssX, float cssY) {
        if (!touchStateTrackingEnabled || !isScreenTouched) return;
        ReaderNativePlugin instance = activeInstance;
        if (instance == null) return;
        JSObject payload = new JSObject();
        payload.put("x", cssX);
        payload.put("y", cssY);
        instance.notifyListeners("touchMove", payload);
    }

    public static void dispatchInputActionMode() {
        if (!inputPasteTrackingEnabled) return;
        ReaderNativePlugin instance = activeInstance;
        if (instance == null) return;
        JSObject payload = new JSObject();
        payload.put("source", "actionMode");
        instance.notifyListeners("inputLongPress", payload);
    }

    public static void dispatchNativeLongPress(float cssX, float cssY) {
        if (!inputPasteTrackingEnabled) return;
        ReaderNativePlugin instance = activeInstance;
        if (instance == null) return;
        JSObject payload = new JSObject();
        payload.put("source", "touch");
        payload.put("x", cssX);
        payload.put("y", cssY);
        instance.notifyListeners("inputLongPress", payload);
    }
}
`;

  const localStoragePluginJava = `package com.feiartical.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.Settings;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "LocalStorageNative",
    permissions = {
        @Permission(
            alias = "storage",
            strings = {
                Manifest.permission.READ_EXTERNAL_STORAGE,
                Manifest.permission.WRITE_EXTERNAL_STORAGE
            }
        )
    }
)
public class LocalStoragePlugin extends Plugin {
    static final String PREFS_NAME = "feiartical_local_fs_prefs";
    static final String KEY_MODE = "mode";
    static final String KEY_TREE_URI = "tree_uri";
    static final String KEY_FOLDER_PATH = "folder_path";
    static final String INDEX_FILE_NAME = ".feiartical-index.json";
    public static final ReentrantReadWriteLock WORKSPACE_IO_LOCK = new ReentrantReadWriteLock();
    private static final long MAX_SCAN_FILE_BYTES = 15L * 1024L * 1024L;
    private static final long MAX_BINARY_FILE_BYTES = 25L * 1024L * 1024L;

    private static volatile LocalStoragePlugin activeInstance;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final ExecutorService mediaExecutor = Executors.newFixedThreadPool(2);

    public static class BinaryFileMeta {
        public final String relPath;
        public final long size;
        public final long lastModified;

        public BinaryFileMeta(String relPath, long size, long lastModified) {
            this.relPath = relPath;
            this.size = size;
            this.lastModified = lastModified;
        }
    }

    @Override
    public void load() {
        super.load();
        activeInstance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (activeInstance == this) {
            activeInstance = null;
        }
        super.handleOnDestroy();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        notifyListeners("workspaceResume", new JSObject());
    }

    private SharedPreferences getPrefs() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private void saveConfig(String mode, String folderPath, String treeUri) {
        SharedPreferences.Editor editor = getPrefs().edit();
        editor.putString(KEY_MODE, mode != null ? mode : "");
        editor.putString(KEY_FOLDER_PATH, folderPath != null ? folderPath : "");
        editor.putString(KEY_TREE_URI, treeUri != null ? treeUri : "");
        editor.apply();
    }

    private static String normalizeRelPath(String raw) {
        if (raw == null) return "";
        String cleaned = raw.replace('\\\\', '/').trim();
        String[] parts = cleaned.split("/");
        StringBuilder sb = new StringBuilder();
        for (String p : parts) {
            String seg = p.trim();
            if (seg.isEmpty() || ".".equals(seg) || "..".equals(seg)) continue;
            if (sb.length() > 0) sb.append('/');
            sb.append(seg);
        }
        return sb.toString();
    }

    private static String extractDisplayPathFromTreeUri(Uri treeUri) {
        try {
            String docId = DocumentsContract.getTreeDocumentId(treeUri);
            if (docId != null && !docId.isEmpty()) {
                int colon = docId.indexOf(':');
                if (colon >= 0) {
                    String volume = docId.substring(0, colon);
                    String rel = docId.substring(colon + 1);
                    if ("primary".equalsIgnoreCase(volume)) {
                        return rel.isEmpty() ? "/" : ("/" + rel);
                    }
                    return rel.isEmpty() ? ("/" + volume) : ("/" + volume + "/" + rel);
                }
                return "/" + docId;
            }
        } catch (Exception ignored) {
        }
        return "/FeiArtical";
    }

    private static boolean tryEnsureWritableDir(File dir) {
        try {
            if (!dir.exists() && !dir.mkdirs()) {
                return false;
            }
            if (!dir.isDirectory()) return false;
            File probe = new File(dir, ".feiartical_write_probe");
            try (FileOutputStream fos = new FileOutputStream(probe, false)) {
                fos.write(1);
                fos.flush();
            }
            probe.delete();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private File resolvePathRoot(String relPath) {
        String clean = normalizeRelPath(relPath);
        if (clean.isEmpty()) {
            clean = "Documents/FeiArtical";
        }
        return new File(Environment.getExternalStorageDirectory(), clean);
    }

    private DocumentFile resolveSafRoot(String treeUriStr) {
        if (treeUriStr == null || treeUriStr.isEmpty()) return null;
        try {
            Uri uri = Uri.parse(treeUriStr);
            DocumentFile root = DocumentFile.fromTreeUri(getContext(), uri);
            if (root != null && root.exists() && root.isDirectory() && root.canWrite()) {
                return root;
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        SharedPreferences prefs = getPrefs();
        String mode = prefs.getString(KEY_MODE, "");
        String folderPath = prefs.getString(KEY_FOLDER_PATH, "");
        String treeUri = prefs.getString(KEY_TREE_URI, "");

        boolean writable = false;
        if ("saf".equals(mode)) {
            writable = resolveSafRoot(treeUri) != null;
        } else if ("path".equals(mode) && !folderPath.isEmpty()) {
            File dir = resolvePathRoot(folderPath);
            writable = dir.exists() && dir.isDirectory() && dir.canWrite();
        }

        JSObject res = new JSObject();
        res.put("configured", !mode.isEmpty());
        res.put("writable", writable);
        res.put("mode", mode);
        res.put("displayPath", folderPath);
        res.put("treeUri", treeUri);
        call.resolve(res);
    }

    @PluginMethod
    public void pickDirectory(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION |
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION |
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION |
            Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
        );
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                Uri initialUri = DocumentsContract.buildDocumentUri(
                    "com.android.externalstorage.documents",
                    "primary:Documents"
                );
                intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, initialUri);
            } catch (Exception ignored) {
            }
        }
        startActivityForResult(call, intent, "onPickDirectoryResult");
    }

    @ActivityCallback
    private void onPickDirectoryResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result == null || result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            JSObject res = new JSObject();
            res.put("cancelled", true);
            call.resolve(res);
            return;
        }

        Uri treeUri = result.getData().getData();
        if (treeUri == null) {
            JSObject res = new JSObject();
            res.put("cancelled", true);
            call.resolve(res);
            return;
        }

        try {
            int takeFlags =
                Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
            getContext().getContentResolver().takePersistableUriPermission(treeUri, takeFlags);
        } catch (Exception ignored) {
        }

        DocumentFile root = DocumentFile.fromTreeUri(getContext(), treeUri);
        if (root == null || !root.exists() || !root.canWrite()) {
            JSObject res = new JSObject();
            res.put("cancelled", false);
            res.put("ok", false);
            res.put("error", "所选目录不可写，请改选 Documents 或内部存储中的其他文件夹");
            call.resolve(res);
            return;
        }

        String displayPath = extractDisplayPathFromTreeUri(treeUri);
        saveConfig("saf", displayPath, treeUri.toString());

        JSObject res = new JSObject();
        res.put("cancelled", false);
        res.put("ok", true);
        res.put("mode", "saf");
        res.put("treeUri", treeUri.toString());
        res.put("displayPath", displayPath);
        call.resolve(res);
    }

    @PluginMethod
    public void configureDirectory(PluginCall call) {
        String mode = call.getString("mode", "path");
        String folderPath = call.getString("folderPath", "/Documents/FeiArtical");
        String treeUri = call.getString("treeUri", "");
        boolean requestPermission = Boolean.TRUE.equals(call.getBoolean("requestPermission", true));

        if ("saf".equals(mode) && treeUri != null && !treeUri.isEmpty()) {
            DocumentFile root = resolveSafRoot(treeUri);
            if (root != null) {
                String displayPath =
                    (folderPath != null && !folderPath.isEmpty())
                        ? folderPath
                        : extractDisplayPathFromTreeUri(Uri.parse(treeUri));
                saveConfig("saf", displayPath, treeUri);
                JSObject res = new JSObject();
                res.put("ok", true);
                res.put("mode", "saf");
                res.put("treeUri", treeUri);
                res.put("displayPath", displayPath);
                call.resolve(res);
                return;
            }
            JSObject res = new JSObject();
            res.put("ok", false);
            res.put("needsPermission", true);
            res.put("error", "原文件夹访问授权已失效，请点击「浏览选择文件夹」重新授权");
            call.resolve(res);
            return;
        }

        String cleanRel = normalizeRelPath(folderPath);
        if (cleanRel.isEmpty()) {
            cleanRel = "Documents/FeiArtical";
        }
        File targetDir = resolvePathRoot(cleanRel);
        if (tryEnsureWritableDir(targetDir)) {
            String normalizedDisplay = "/" + cleanRel;
            saveConfig("path", normalizedDisplay, "");
            JSObject res = new JSObject();
            res.put("ok", true);
            res.put("mode", "path");
            res.put("displayPath", normalizedDisplay);
            res.put("absolutePath", targetDir.getAbsolutePath());
            call.resolve(res);
            return;
        }

        if (!requestPermission) {
            JSObject res = new JSObject();
            res.put("ok", false);
            res.put("needsPermission", true);
            res.put("error", "需要手机存储权限才能创建并写入该目录");
            call.resolve(res);
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (!Environment.isExternalStorageManager()) {
                try {
                    Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                    intent.setData(Uri.parse("package:" + getContext().getPackageName()));
                    startActivityForResult(call, intent, "onManageAllFilesResult");
                    return;
                } catch (Exception e) {
                    try {
                        Intent fallback = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                        startActivityForResult(call, fallback, "onManageAllFilesResult");
                        return;
                    } catch (Exception ignored) {
                    }
                }
            }
            JSObject res = new JSObject();
            res.put("ok", false);
            res.put("needsPermission", true);
            res.put("error", "无法直接创建该目录，请点击上方「浏览选择文件夹」通过系统文件管理器授权");
            call.resolve(res);
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            requestPermissionForAlias("storage", call, "onLegacyStoragePermResult");
            return;
        }

        JSObject res = new JSObject();
        res.put("ok", false);
        res.put("error", "无法创建目录：" + targetDir.getAbsolutePath());
        call.resolve(res);
    }

    @ActivityCallback
    private void onManageAllFilesResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        finishPathConfigureAfterPermission(call);
    }

    @PermissionCallback
    private void onLegacyStoragePermResult(PluginCall call) {
        if (call == null) return;
        finishPathConfigureAfterPermission(call);
    }

    private void finishPathConfigureAfterPermission(PluginCall call) {
        String folderPath = call.getString("folderPath", "/Documents/FeiArtical");
        String cleanRel = normalizeRelPath(folderPath);
        if (cleanRel.isEmpty()) {
            cleanRel = "Documents/FeiArtical";
        }
        File targetDir = resolvePathRoot(cleanRel);
        if (tryEnsureWritableDir(targetDir)) {
            String normalizedDisplay = "/" + cleanRel;
            saveConfig("path", normalizedDisplay, "");
            JSObject res = new JSObject();
            res.put("ok", true);
            res.put("mode", "path");
            res.put("displayPath", normalizedDisplay);
            res.put("absolutePath", targetDir.getAbsolutePath());
            call.resolve(res);
            return;
        }
        JSObject res = new JSObject();
        res.put("ok", false);
        res.put("needsPermission", true);
        res.put(
            "error",
            "未获得手机存储写入权限，请在系统设置中开启“允许管理所有文件”，或点击上方「浏览选择文件夹」直接授权"
        );
        call.resolve(res);
    }

    @PluginMethod
    public void applyBatch(PluginCall call) {
        JSArray ops = call.getArray("ops");
        if (ops == null) {
            JSObject res = new JSObject();
            res.put("ok", true);
            res.put("applied", 0);
            call.resolve(res);
            return;
        }

        SharedPreferences prefs = getPrefs();
        final String mode = prefs.getString(KEY_MODE, "");
        final String folderPath = prefs.getString(KEY_FOLDER_PATH, "");
        final String treeUri = prefs.getString(KEY_TREE_URI, "");

        executor.execute(() -> {
            WORKSPACE_IO_LOCK.writeLock().lock();
            try {
                int applied = 0;
                if ("saf".equals(mode)) {
                    DocumentFile root = resolveSafRoot(treeUri);
                    if (root == null) {
                        JSObject err = new JSObject();
                        err.put("ok", false);
                        err.put("error", "本地文件夹访问授权已失效");
                        call.resolve(err);
                        return;
                    }
                    Map<String, DocumentFile> dirCache = new HashMap<>();
                    dirCache.put("", root);

                    for (int i = 0; i < ops.length(); i++) {
                        JSONObject item = ops.optJSONObject(i);
                        if (item == null) continue;
                        String op = item.optString("op", "");
                        String rel = normalizeRelPath(item.optString("path", ""));
                        if (rel.isEmpty()) continue;

                        if ("mkdir".equals(op)) {
                            ensureSafDir(root, rel, dirCache);
                            applied++;
                        } else if ("write".equals(op)) {
                            String content = item.optString("content", "");
                            writeSafFile(root, rel, content, dirCache);
                            applied++;
                        } else if ("delete".equals(op)) {
                            deleteSafFile(root, rel, dirCache);
                            applied++;
                        } else if ("rmdirIfEmpty".equals(op)) {
                            rmdirSafIfEmpty(root, rel, dirCache);
                            applied++;
                        }
                    }
                } else if ("path".equals(mode) && !folderPath.isEmpty()) {
                    File rootDir = resolvePathRoot(folderPath);
                    if (!rootDir.exists() && !rootDir.mkdirs()) {
                        JSObject err = new JSObject();
                        err.put("ok", false);
                        err.put("error", "无法创建本地文档目录");
                        call.resolve(err);
                        return;
                    }
                    String rootCanonical = rootDir.getCanonicalPath();

                    for (int i = 0; i < ops.length(); i++) {
                        JSONObject item = ops.optJSONObject(i);
                        if (item == null) continue;
                        String op = item.optString("op", "");
                        String rel = normalizeRelPath(item.optString("path", ""));
                        if (rel.isEmpty()) continue;

                        File target = new File(rootDir, rel);
                        String targetCanonical = target.getCanonicalPath();
                        if (
                            !targetCanonical.equals(rootCanonical) &&
                            !targetCanonical.startsWith(rootCanonical + File.separator)
                        ) {
                            continue;
                        }

                        if ("mkdir".equals(op)) {
                            target.mkdirs();
                            applied++;
                        } else if ("write".equals(op)) {
                            String content = item.optString("content", "");
                            File parent = target.getParentFile();
                            if (parent != null && !parent.exists()) {
                                parent.mkdirs();
                            }
                            try (FileOutputStream fos = new FileOutputStream(target, false)) {
                                fos.write(content.getBytes(StandardCharsets.UTF_8));
                                fos.flush();
                            }
                            applied++;
                        } else if ("delete".equals(op)) {
                            if (target.exists() && target.isFile()) {
                                target.delete();
                            }
                            applied++;
                        } else if ("rmdirIfEmpty".equals(op)) {
                            if (target.exists() && target.isDirectory()) {
                                String[] children = target.list();
                                if (children == null || children.length == 0) {
                                    target.delete();
                                }
                            }
                            applied++;
                        }
                    }
                } else {
                    JSObject err = new JSObject();
                    err.put("ok", false);
                    err.put("error", "尚未绑定本地文档目录");
                    call.resolve(err);
                    return;
                }

                String fingerprint = computeFingerprintInternal(mode, folderPath, treeUri);
                JSObject res = new JSObject();
                res.put("ok", true);
                res.put("applied", applied);
                res.put("fingerprint", fingerprint);
                call.resolve(res);
            } catch (Exception e) {
                JSObject err = new JSObject();
                err.put("ok", false);
                err.put("error", e.getMessage() != null ? e.getMessage() : "写入本地文件失败");
                call.resolve(err);
            } finally {
                WORKSPACE_IO_LOCK.writeLock().unlock();
            }
        });
    }

    @PluginMethod
    public void getWorkspaceFingerprint(PluginCall call) {
        SharedPreferences prefs = getPrefs();
        final String mode = prefs.getString(KEY_MODE, "");
        final String folderPath = prefs.getString(KEY_FOLDER_PATH, "");
        final String treeUri = prefs.getString(KEY_TREE_URI, "");

        executor.execute(() -> {
            WORKSPACE_IO_LOCK.readLock().lock();
            try {
                if (mode.isEmpty()) {
                    JSObject err = new JSObject();
                    err.put("ok", false);
                    call.resolve(err);
                    return;
                }
                String fp = computeFingerprintInternal(mode, folderPath, treeUri);
                if (fp == null) {
                    JSObject err = new JSObject();
                    err.put("ok", false);
                    call.resolve(err);
                    return;
                }
                JSObject res = new JSObject();
                res.put("ok", true);
                res.put("fingerprint", fp);
                call.resolve(res);
            } catch (Exception e) {
                JSObject err = new JSObject();
                err.put("ok", false);
                call.resolve(err);
            } finally {
                WORKSPACE_IO_LOCK.readLock().unlock();
            }
        });
    }

    private String computeFingerprintInternal(String mode, String folderPath, String treeUri) {
        List<String> lines = new ArrayList<>();
        if ("saf".equals(mode)) {
            DocumentFile root = resolveSafRoot(treeUri);
            if (root == null) return null;
            DocumentFile[] entries = root.listFiles();
            if (entries != null) {
                for (DocumentFile entry : entries) {
                    String name = entry.getName();
                    if (name == null || name.isEmpty() || name.startsWith(".")) continue;
                    if (entry.isDirectory()) {
                        if (isReservedMediaDir(name)) continue;
                        lines.add("D:" + name);
                        DocumentFile[] subFiles = entry.listFiles();
                        if (subFiles != null) {
                            for (DocumentFile sub : subFiles) {
                                if (!sub.isFile()) continue;
                                String subName = sub.getName();
                                if (detectDocFormat(subName) == null) continue;
                                lines.add("F:" + name + "/" + subName + ":" + sub.length() + ":" + sub.lastModified());
                            }
                        }
                    } else if (entry.isFile()) {
                        if (detectDocFormat(name) == null) continue;
                        lines.add("F:" + name + ":" + entry.length() + ":" + entry.lastModified());
                    }
                }
            }
        } else if ("path".equals(mode) && !folderPath.isEmpty()) {
            File rootDir = resolvePathRoot(folderPath);
            if (!rootDir.exists() || !rootDir.isDirectory()) return "";
            File[] entries = rootDir.listFiles();
            if (entries != null) {
                for (File entry : entries) {
                    String name = entry.getName();
                    if (name == null || name.isEmpty() || name.startsWith(".")) continue;
                    if (entry.isDirectory()) {
                        if (isReservedMediaDir(name)) continue;
                        lines.add("D:" + name);
                        File[] subFiles = entry.listFiles();
                        if (subFiles != null) {
                            for (File sub : subFiles) {
                                if (!sub.isFile()) continue;
                                String subName = sub.getName();
                                if (detectDocFormat(subName) == null) continue;
                                lines.add("F:" + name + "/" + subName + ":" + sub.length() + ":" + sub.lastModified());
                            }
                        }
                    } else if (entry.isFile()) {
                        if (detectDocFormat(name) == null) continue;
                        lines.add("F:" + name + ":" + entry.length() + ":" + entry.lastModified());
                    }
                }
            }
        } else {
            return null;
        }
        Collections.sort(lines);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < lines.size(); i++) {
            if (i > 0) sb.append('\\n');
            sb.append(lines.get(i));
        }
        return sb.toString();
    }

    @PluginMethod
    public void scanWorkspace(PluginCall call) {
        SharedPreferences prefs = getPrefs();
        final String mode = prefs.getString(KEY_MODE, "");
        final String folderPath = prefs.getString(KEY_FOLDER_PATH, "");
        final String treeUri = prefs.getString(KEY_TREE_URI, "");

        executor.execute(() -> {
            WORKSPACE_IO_LOCK.readLock().lock();
            try {
                JSArray foldersArr = new JSArray();
                JSArray filesArr = new JSArray();
                String indexJson = "";

                if ("saf".equals(mode)) {
                    DocumentFile root = resolveSafRoot(treeUri);
                    if (root == null) {
                        JSObject err = new JSObject();
                        err.put("ok", false);
                        err.put("error", "本地文件夹访问授权已失效");
                        call.resolve(err);
                        return;
                    }

                    DocumentFile[] entries = root.listFiles();
                    if (entries != null) {
                        for (DocumentFile entry : entries) {
                            String name = entry.getName();
                            if (name == null || name.isEmpty()) continue;

                            if (INDEX_FILE_NAME.equals(name) && entry.isFile()) {
                                indexJson = readSafText(entry);
                                continue;
                            }
                            if (name.startsWith(".")) continue;

                            if (entry.isDirectory()) {
                                if (isReservedMediaDir(name)) continue;
                                JSObject fObj = new JSObject();
                                fObj.put("name", name);
                                foldersArr.put(fObj);

                                DocumentFile[] subFiles = entry.listFiles();
                                if (subFiles != null) {
                                    for (DocumentFile sub : subFiles) {
                                        if (!sub.isFile()) continue;
                                        String subName = sub.getName();
                                        String fmt = detectDocFormat(subName);
                                        if (fmt == null) continue;
                                        if (sub.length() > MAX_SCAN_FILE_BYTES) continue;
                                        String text = readSafText(sub);
                                        JSObject docObj = new JSObject();
                                        docObj.put("relPath", name + "/" + subName);
                                        docObj.put("folderName", name);
                                        docObj.put("fileName", subName);
                                        docObj.put("format", fmt);
                                        docObj.put("content", text);
                                        docObj.put("lastModified", sub.lastModified());
                                        docObj.put("byteSize", sub.length());
                                        filesArr.put(docObj);
                                    }
                                }
                            } else if (entry.isFile()) {
                                String fmt = detectDocFormat(name);
                                if (fmt == null) continue;
                                if (entry.length() > MAX_SCAN_FILE_BYTES) continue;
                                String text = readSafText(entry);
                                JSObject docObj = new JSObject();
                                docObj.put("relPath", name);
                                docObj.put("folderName", JSONObject.NULL);
                                docObj.put("fileName", name);
                                docObj.put("format", fmt);
                                docObj.put("content", text);
                                docObj.put("lastModified", entry.lastModified());
                                docObj.put("byteSize", entry.length());
                                filesArr.put(docObj);
                            }
                        }
                    }
                } else if ("path".equals(mode) && !folderPath.isEmpty()) {
                    File rootDir = resolvePathRoot(folderPath);
                    if (!rootDir.exists() || !rootDir.isDirectory()) {
                        JSObject res = new JSObject();
                        res.put("ok", true);
                        res.put("indexJson", "");
                        res.put("folders", foldersArr);
                        res.put("files", filesArr);
                        call.resolve(res);
                        return;
                    }

                    File[] entries = rootDir.listFiles();
                    if (entries != null) {
                        for (File entry : entries) {
                            String name = entry.getName();
                            if (name == null || name.isEmpty()) continue;

                            if (INDEX_FILE_NAME.equals(name) && entry.isFile()) {
                                indexJson = readRegularFileText(entry);
                                continue;
                            }
                            if (name.startsWith(".")) continue;

                            if (entry.isDirectory()) {
                                if (isReservedMediaDir(name)) continue;
                                JSObject fObj = new JSObject();
                                fObj.put("name", name);
                                foldersArr.put(fObj);

                                File[] subFiles = entry.listFiles();
                                if (subFiles != null) {
                                    for (File sub : subFiles) {
                                        if (!sub.isFile()) continue;
                                        String subName = sub.getName();
                                        String fmt = detectDocFormat(subName);
                                        if (fmt == null) continue;
                                        if (sub.length() > MAX_SCAN_FILE_BYTES) continue;
                                        String text = readRegularFileText(sub);
                                        JSObject docObj = new JSObject();
                                        docObj.put("relPath", name + "/" + subName);
                                        docObj.put("folderName", name);
                                        docObj.put("fileName", subName);
                                        docObj.put("format", fmt);
                                        docObj.put("content", text);
                                        docObj.put("lastModified", sub.lastModified());
                                        docObj.put("byteSize", sub.length());
                                        filesArr.put(docObj);
                                    }
                                }
                            } else if (entry.isFile()) {
                                String fmt = detectDocFormat(name);
                                if (fmt == null) continue;
                                if (entry.length() > MAX_SCAN_FILE_BYTES) continue;
                                String text = readRegularFileText(entry);
                                JSObject docObj = new JSObject();
                                docObj.put("relPath", name);
                                docObj.put("folderName", JSONObject.NULL);
                                docObj.put("fileName", name);
                                docObj.put("format", fmt);
                                docObj.put("content", text);
                                docObj.put("lastModified", entry.lastModified());
                                docObj.put("byteSize", entry.length());
                                filesArr.put(docObj);
                            }
                        }
                    }
                } else {
                    JSObject err = new JSObject();
                    err.put("ok", false);
                    err.put("error", "尚未绑定本地文档目录");
                    call.resolve(err);
                    return;
                }

                JSObject res = new JSObject();
                res.put("ok", true);
                res.put("indexJson", indexJson);
                res.put("folders", foldersArr);
                res.put("files", filesArr);
                call.resolve(res);
            } catch (Exception e) {
                JSObject err = new JSObject();
                err.put("ok", false);
                err.put("error", e.getMessage() != null ? e.getMessage() : "扫描本地文件夹失败");
                call.resolve(err);
            } finally {
                WORKSPACE_IO_LOCK.readLock().unlock();
            }
        });
    }

    @PluginMethod
    public void writeBinaryFile(PluginCall call) {
        String rawPath = call.getString("path", "");
        String base64 = call.getString("base64", "");
        final String rel = normalizeRelPath(rawPath);
        if (rel.isEmpty() || base64 == null) {
            JSObject err = new JSObject();
            err.put("ok", false);
            err.put("error", "无效的写入路径或文件数据");
            call.resolve(err);
            return;
        }

        SharedPreferences prefs = getPrefs();
        final String mode = prefs.getString(KEY_MODE, "");
        final String folderPath = prefs.getString(KEY_FOLDER_PATH, "");
        final String treeUri = prefs.getString(KEY_TREE_URI, "");

        mediaExecutor.execute(() -> {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                if ("saf".equals(mode)) {
                    DocumentFile root = resolveSafRoot(treeUri);
                    if (root == null) {
                        JSObject err = new JSObject();
                        err.put("ok", false);
                        err.put("error", "本地文件夹访问授权已失效");
                        call.resolve(err);
                        return;
                    }
                    Map<String, DocumentFile> cache = new HashMap<>();
                    cache.put("", root);
                    writeSafBinaryFile(root, rel, bytes, cache);
                } else if ("path".equals(mode) && !folderPath.isEmpty()) {
                    File rootDir = resolvePathRoot(folderPath);
                    if (!rootDir.exists() && !rootDir.mkdirs()) {
                        JSObject err = new JSObject();
                        err.put("ok", false);
                        err.put("error", "无法创建本地文档目录");
                        call.resolve(err);
                        return;
                    }
                    String rootCanonical = rootDir.getCanonicalPath();
                    File target = new File(rootDir, rel);
                    String targetCanonical = target.getCanonicalPath();
                    if (
                        !targetCanonical.equals(rootCanonical) &&
                        !targetCanonical.startsWith(rootCanonical + File.separator)
                    ) {
                        JSObject err = new JSObject();
                        err.put("ok", false);
                        err.put("error", "非法文件路径");
                        call.resolve(err);
                        return;
                    }
                    File parent = target.getParentFile();
                    if (parent != null && !parent.exists()) {
                        parent.mkdirs();
                    }
                    try (FileOutputStream fos = new FileOutputStream(target, false)) {
                        fos.write(bytes);
                        fos.flush();
                    }
                } else {
                    JSObject err = new JSObject();
                    err.put("ok", false);
                    err.put("error", "尚未绑定本地文档目录");
                    call.resolve(err);
                    return;
                }

                JSObject res = new JSObject();
                res.put("ok", true);
                call.resolve(res);
            } catch (Exception e) {
                JSObject err = new JSObject();
                err.put("ok", false);
                err.put("error", e.getMessage() != null ? e.getMessage() : "写入本地图片失败");
                call.resolve(err);
            }
        });
    }

    @PluginMethod
    public void readBinaryFile(PluginCall call) {
        String rawPath = call.getString("path", "");
        final String rel = normalizeRelPath(rawPath);
        if (rel.isEmpty()) {
            JSObject err = new JSObject();
            err.put("ok", false);
            err.put("notFound", true);
            call.resolve(err);
            return;
        }

        SharedPreferences prefs = getPrefs();
        final String mode = prefs.getString(KEY_MODE, "");
        final String folderPath = prefs.getString(KEY_FOLDER_PATH, "");
        final String treeUri = prefs.getString(KEY_TREE_URI, "");

        mediaExecutor.execute(() -> {
            try {
                byte[] bytes = null;
                String resolvedName = rel;

                if ("saf".equals(mode)) {
                    DocumentFile root = resolveSafRoot(treeUri);
                    if (root == null) {
                        JSObject err = new JSObject();
                        err.put("ok", false);
                        err.put("notFound", true);
                        call.resolve(err);
                        return;
                    }
                    DocumentFile target = findSafFileFlexible(root, rel);
                    if (target == null || !target.isFile()) {
                        JSObject err = new JSObject();
                        err.put("ok", false);
                        err.put("notFound", true);
                        call.resolve(err);
                        return;
                    }
                    if (target.length() > MAX_BINARY_FILE_BYTES) {
                        JSObject err = new JSObject();
                        err.put("ok", false);
                        err.put("error", "图片文件过大");
                        call.resolve(err);
                        return;
                    }
                    if (target.getName() != null) {
                        resolvedName = target.getName();
                    }
                    try (InputStream is = getContext().getContentResolver().openInputStream(target.getUri())) {
                        if (is != null) {
                            bytes = readStreamBytes(is);
                        }
                    }
                } else if ("path".equals(mode) && !folderPath.isEmpty()) {
                    File rootDir = resolvePathRoot(folderPath);
                    if (!rootDir.exists() || !rootDir.isDirectory()) {
                        JSObject err = new JSObject();
                        err.put("ok", false);
                        err.put("notFound", true);
                        call.resolve(err);
                        return;
                    }
                    String rootCanonical = rootDir.getCanonicalPath();
                    File target = findRegularFileFlexible(rootDir, rel);
                    if (target == null || !target.exists() || !target.isFile()) {
                        JSObject err = new JSObject();
                        err.put("ok", false);
                        err.put("notFound", true);
                        call.resolve(err);
                        return;
                    }
                    String targetCanonical = target.getCanonicalPath();
                    if (
                        !targetCanonical.equals(rootCanonical) &&
                        !targetCanonical.startsWith(rootCanonical + File.separator)
                    ) {
                        JSObject err = new JSObject();
                        err.put("ok", false);
                        err.put("notFound", true);
                        call.resolve(err);
                        return;
                    }
                    if (target.length() > MAX_BINARY_FILE_BYTES) {
                        JSObject err = new JSObject();
                        err.put("ok", false);
                        err.put("error", "图片文件过大");
                        call.resolve(err);
                        return;
                    }
                    resolvedName = target.getName();
                    try (InputStream is = new FileInputStream(target)) {
                        bytes = readStreamBytes(is);
                    }
                } else {
                    JSObject err = new JSObject();
                    err.put("ok", false);
                    err.put("notFound", true);
                    call.resolve(err);
                    return;
                }

                if (bytes == null || bytes.length == 0) {
                    JSObject err = new JSObject();
                    err.put("ok", false);
                    err.put("notFound", true);
                    call.resolve(err);
                    return;
                }

                JSObject res = new JSObject();
                res.put("ok", true);
                res.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                res.put("mimeType", guessMimeType(resolvedName));
                call.resolve(res);
            } catch (Exception e) {
                JSObject err = new JSObject();
                err.put("ok", false);
                err.put("error", e.getMessage() != null ? e.getMessage() : "读取本地图片失败");
                call.resolve(err);
            }
        });
    }

    @PluginMethod
    public void listBinaryFiles(PluginCall call) {
        final String prefix = normalizeRelPath(call.getString("prefix", "images"));
        mediaExecutor.execute(() -> {
            try {
                List<BinaryFileMeta> list = listBinaryFilesInternal(prefix.isEmpty() ? "images" : prefix);
                JSArray arr = new JSArray();
                for (BinaryFileMeta item : list) {
                    JSObject obj = new JSObject();
                    obj.put("relPath", item.relPath);
                    obj.put("size", item.size);
                    obj.put("lastModified", item.lastModified);
                    arr.put(obj);
                }
                JSObject res = new JSObject();
                res.put("ok", true);
                res.put("files", arr);
                call.resolve(res);
            } catch (Exception e) {
                JSObject err = new JSObject();
                err.put("ok", false);
                err.put("error", e.getMessage() != null ? e.getMessage() : "列出本地图片失败");
                call.resolve(err);
            }
        });
    }

    public static List<BinaryFileMeta> listBinaryFilesSync(String prefix) {
        LocalStoragePlugin inst = activeInstance;
        if (inst == null) return Collections.emptyList();
        return inst.listBinaryFilesInternal(prefix);
    }

    public static byte[] readBinaryBytesSync(String rawPath) {
        LocalStoragePlugin inst = activeInstance;
        if (inst == null) return null;
        return inst.readBinaryBytesInternal(rawPath);
    }

    public static boolean writeBinaryBytesSync(String rawPath, byte[] bytes) {
        LocalStoragePlugin inst = activeInstance;
        if (inst == null || bytes == null) return false;
        return inst.writeBinaryBytesInternal(rawPath, bytes);
    }

    private List<BinaryFileMeta> listBinaryFilesInternal(String rawPrefix) {
        List<BinaryFileMeta> out = new ArrayList<>();
        String prefix = normalizeRelPath(rawPrefix);
        if (prefix.isEmpty()) prefix = "images";

        SharedPreferences prefs = getPrefs();
        String mode = prefs.getString(KEY_MODE, "");
        String folderPath = prefs.getString(KEY_FOLDER_PATH, "");
        String treeUri = prefs.getString(KEY_TREE_URI, "");

        try {
            if ("saf".equals(mode)) {
                DocumentFile root = resolveSafRoot(treeUri);
                if (root == null) return out;
                DocumentFile start = findSafDir(root, prefix, new HashMap<>());
                if (start == null || !start.isDirectory()) return out;
                walkSafBinaryDir(start, prefix, out, 0);
            } else if ("path".equals(mode) && !folderPath.isEmpty()) {
                File rootDir = resolvePathRoot(folderPath);
                if (!rootDir.exists() || !rootDir.isDirectory()) return out;
                File start = new File(rootDir, prefix);
                if (!start.exists() || !start.isDirectory()) return out;
                String rootCanonical = rootDir.getCanonicalPath();
                walkPathBinaryDir(start, prefix, rootCanonical, out, 0);
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    private void walkSafBinaryDir(DocumentFile dir, String currentRel, List<BinaryFileMeta> out, int depth) {
        if (depth > 8 || dir == null) return;
        DocumentFile[] children = dir.listFiles();
        if (children == null) return;
        for (DocumentFile child : children) {
            String name = child.getName();
            if (name == null || name.isEmpty() || name.startsWith(".")) continue;
            String nextRel = currentRel.isEmpty() ? name : (currentRel + "/" + name);
            if (child.isDirectory()) {
                walkSafBinaryDir(child, nextRel, out, depth + 1);
            } else if (child.isFile()) {
                long len = child.length();
                if (len > 0 && len <= MAX_BINARY_FILE_BYTES) {
                    out.add(new BinaryFileMeta(nextRel, len, child.lastModified()));
                }
            }
        }
    }

    private void walkPathBinaryDir(File dir, String currentRel, String rootCanonical, List<BinaryFileMeta> out, int depth) {
        if (depth > 8 || dir == null) return;
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File child : children) {
            String name = child.getName();
            if (name == null || name.isEmpty() || name.startsWith(".")) continue;
            try {
                String cPath = child.getCanonicalPath();
                if (!cPath.startsWith(rootCanonical + File.separator)) continue;
            } catch (IOException e) {
                continue;
            }
            String nextRel = currentRel.isEmpty() ? name : (currentRel + "/" + name);
            if (child.isDirectory()) {
                walkPathBinaryDir(child, nextRel, rootCanonical, out, depth + 1);
            } else if (child.isFile()) {
                long len = child.length();
                if (len > 0 && len <= MAX_BINARY_FILE_BYTES) {
                    out.add(new BinaryFileMeta(nextRel, len, child.lastModified()));
                }
            }
        }
    }

    private byte[] readBinaryBytesInternal(String rawPath) {
        String rel = normalizeRelPath(rawPath);
        if (rel.isEmpty()) return null;

        SharedPreferences prefs = getPrefs();
        String mode = prefs.getString(KEY_MODE, "");
        String folderPath = prefs.getString(KEY_FOLDER_PATH, "");
        String treeUri = prefs.getString(KEY_TREE_URI, "");

        try {
            if ("saf".equals(mode)) {
                DocumentFile root = resolveSafRoot(treeUri);
                if (root == null) return null;
                DocumentFile target = findSafFileFlexible(root, rel);
                if (target == null || !target.isFile() || target.length() > MAX_BINARY_FILE_BYTES) return null;
                try (InputStream is = getContext().getContentResolver().openInputStream(target.getUri())) {
                    return is != null ? readStreamBytes(is) : null;
                }
            } else if ("path".equals(mode) && !folderPath.isEmpty()) {
                File rootDir = resolvePathRoot(folderPath);
                if (!rootDir.exists() || !rootDir.isDirectory()) return null;
                String rootCanonical = rootDir.getCanonicalPath();
                File target = findRegularFileFlexible(rootDir, rel);
                if (target == null || !target.exists() || !target.isFile()) return null;
                String targetCanonical = target.getCanonicalPath();
                if (!targetCanonical.equals(rootCanonical) && !targetCanonical.startsWith(rootCanonical + File.separator)) {
                    return null;
                }
                if (target.length() > MAX_BINARY_FILE_BYTES) return null;
                try (InputStream is = new FileInputStream(target)) {
                    return readStreamBytes(is);
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private boolean writeBinaryBytesInternal(String rawPath, byte[] bytes) {
        String rel = normalizeRelPath(rawPath);
        if (rel.isEmpty() || bytes == null || bytes.length == 0 || bytes.length > MAX_BINARY_FILE_BYTES) {
            return false;
        }

        SharedPreferences prefs = getPrefs();
        String mode = prefs.getString(KEY_MODE, "");
        String folderPath = prefs.getString(KEY_FOLDER_PATH, "");
        String treeUri = prefs.getString(KEY_TREE_URI, "");

        try {
            if ("saf".equals(mode)) {
                DocumentFile root = resolveSafRoot(treeUri);
                if (root == null) return false;
                Map<String, DocumentFile> cache = new HashMap<>();
                cache.put("", root);
                writeSafBinaryFile(root, rel, bytes, cache);
                return true;
            } else if ("path".equals(mode) && !folderPath.isEmpty()) {
                File rootDir = resolvePathRoot(folderPath);
                if (!rootDir.exists() && !rootDir.mkdirs()) return false;
                String rootCanonical = rootDir.getCanonicalPath();
                File target = new File(rootDir, rel);
                String targetCanonical = target.getCanonicalPath();
                if (!targetCanonical.equals(rootCanonical) && !targetCanonical.startsWith(rootCanonical + File.separator)) {
                    return false;
                }
                File parent = target.getParentFile();
                if (parent != null && !parent.exists()) {
                    parent.mkdirs();
                }
                try (FileOutputStream fos = new FileOutputStream(target, false)) {
                    fos.write(bytes);
                    fos.flush();
                }
                return true;
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    static boolean isReservedMediaDir(String name) {
        if (name == null) return false;
        return "images".equalsIgnoreCase(name) || "assets".equalsIgnoreCase(name);
    }

    static boolean isIgnoredTempFileName(String fileName) {
        if (fileName == null) return true;
        String trimmed = fileName.trim();
        if (trimmed.isEmpty()) return true;
        String lower = trimmed.toLowerCase(Locale.ROOT);
        if (trimmed.startsWith(".") || trimmed.startsWith("~$") || trimmed.startsWith("~")) {
            return true;
        }
        if (
            "desktop.ini".equals(lower) ||
            "thumbs.db".equals(lower) ||
            ".ds_store".equals(lower) ||
            "4913".equals(lower)
        ) {
            return true;
        }
        return (
            lower.endsWith(".tmp") ||
            lower.endsWith(".temp") ||
            lower.endsWith(".swp") ||
            lower.endsWith(".swo") ||
            lower.endsWith(".swx") ||
            lower.endsWith(".bak") ||
            lower.endsWith(".orig") ||
            lower.endsWith(".part") ||
            lower.endsWith(".crdownload") ||
            lower.endsWith(".wbk") ||
            lower.endsWith("~")
        );
    }

    private static String detectDocFormat(String fileName) {
        if (isIgnoredTempFileName(fileName)) return null;
        String lower = fileName.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "md";
        if (lower.endsWith(".txt")) return "txt";
        return null;
    }

    private static String guessMimeType(String fileName) {
        String lower = fileName.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".txt")) return "text/plain";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".md")) return "text/markdown";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".bmp")) return "image/bmp";
        if (lower.endsWith(".avif")) return "image/avif";
        return "application/octet-stream";
    }

    private static File findRegularFileFlexible(File rootDir, String relPath) {
        File direct = new File(rootDir, relPath);
        if (direct.exists() && direct.isFile()) return direct;

        String[] parts = relPath.split("/");
        File current = rootDir;
        for (int i = 0; i < parts.length; i++) {
            String seg = parts[i];
            if (seg.isEmpty()) continue;
            File exact = new File(current, seg);
            if (exact.exists()) {
                current = exact;
                continue;
            }
            File[] children = current.listFiles();
            if (children == null) return null;
            File matched = null;
            for (File c : children) {
                if (seg.equalsIgnoreCase(c.getName())) {
                    matched = c;
                    break;
                }
            }
            if (matched == null) return null;
            current = matched;
        }
        return current.isFile() ? current : null;
    }

    private DocumentFile findSafFileFlexible(DocumentFile root, String relPath) {
        String[] parts = relPath.split("/");
        DocumentFile current = root;
        for (int i = 0; i < parts.length; i++) {
            String seg = parts[i];
            if (seg.isEmpty()) continue;
            DocumentFile next = current.findFile(seg);
            if (next == null) {
                DocumentFile[] children = current.listFiles();
                if (children != null) {
                    for (DocumentFile c : children) {
                        if (seg.equalsIgnoreCase(c.getName())) {
                            next = c;
                            break;
                        }
                    }
                }
            }
            if (next == null) return null;
            current = next;
        }
        return current.isFile() ? current : null;
    }

    private void writeSafBinaryFile(
        DocumentFile root,
        String relPath,
        byte[] bytes,
        Map<String, DocumentFile> cache
    ) throws IOException {
        int slash = relPath.lastIndexOf('/');
        String dirPart = slash >= 0 ? relPath.substring(0, slash) : "";
        String fileName = slash >= 0 ? relPath.substring(slash + 1) : relPath;
        DocumentFile parent = ensureSafDir(root, dirPart, cache);
        if (parent == null) {
            throw new IOException("无法创建子目录：" + dirPart);
        }

        DocumentFile target = parent.findFile(fileName);
        if (target == null) {
            // Use application/octet-stream so Android SAF preserves the exact image extension without doubling it
            target = parent.createFile("application/octet-stream", fileName);
            if (target == null) {
                target = parent.createFile(guessMimeType(fileName), fileName);
            }
        }
        if (target == null) {
            throw new IOException("无法创建图片文件：" + fileName);
        }

        OutputStream os = null;
        try {
            try {
                os = getContext().getContentResolver().openOutputStream(target.getUri(), "wt");
            } catch (IllegalArgumentException e) {
                try {
                    os = getContext().getContentResolver().openOutputStream(target.getUri(), "rwt");
                } catch (IllegalArgumentException e2) {
                    os = getContext().getContentResolver().openOutputStream(target.getUri(), "w");
                }
            }
            if (os == null) {
                throw new IOException("无法打开图片输出流：" + fileName);
            }
            os.write(bytes);
            os.flush();
        } finally {
            if (os != null) {
                try {
                    os.close();
                } catch (IOException ignored) {
                }
            }
        }
    }

    private static byte[] readStreamBytes(InputStream is) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = is.read(buf)) != -1) {
            baos.write(buf, 0, n);
        }
        return baos.toByteArray();
    }

    private DocumentFile ensureSafDir(
        DocumentFile root,
        String relDirPath,
        Map<String, DocumentFile> cache
    ) {
        if (relDirPath == null || relDirPath.isEmpty()) return root;
        DocumentFile cached = cache.get(relDirPath);
        if (cached != null && cached.exists()) return cached;

        String[] parts = relDirPath.split("/");
        DocumentFile current = root;
        StringBuilder pathBuilder = new StringBuilder();
        for (String seg : parts) {
            if (seg.isEmpty()) continue;
            if (pathBuilder.length() > 0) pathBuilder.append('/');
            pathBuilder.append(seg);
            String key = pathBuilder.toString();

            DocumentFile next = cache.get(key);
            if (next == null || !next.exists()) {
                next = current.findFile(seg);
                if (next == null || !next.isDirectory()) {
                    next = current.createDirectory(seg);
                }
                if (next == null) return null;
                cache.put(key, next);
            }
            current = next;
        }
        return current;
    }

    private DocumentFile findSafDir(
        DocumentFile root,
        String relDirPath,
        Map<String, DocumentFile> cache
    ) {
        if (relDirPath == null || relDirPath.isEmpty()) return root;
        DocumentFile cached = cache.get(relDirPath);
        if (cached != null && cached.exists()) return cached;

        String[] parts = relDirPath.split("/");
        DocumentFile current = root;
        StringBuilder pathBuilder = new StringBuilder();
        for (String seg : parts) {
            if (seg.isEmpty()) continue;
            if (pathBuilder.length() > 0) pathBuilder.append('/');
            pathBuilder.append(seg);
            String key = pathBuilder.toString();

            DocumentFile next = cache.get(key);
            if (next == null || !next.exists()) {
                next = current.findFile(seg);
                if (next == null || !next.isDirectory()) return null;
                cache.put(key, next);
            }
            current = next;
        }
        return current;
    }

    private void writeSafFile(
        DocumentFile root,
        String relPath,
        String content,
        Map<String, DocumentFile> cache
    ) throws IOException {
        int slash = relPath.lastIndexOf('/');
        String dirPart = slash >= 0 ? relPath.substring(0, slash) : "";
        String fileName = slash >= 0 ? relPath.substring(slash + 1) : relPath;
        DocumentFile parent = ensureSafDir(root, dirPart, cache);
        if (parent == null) {
            throw new IOException("无法创建子目录：" + dirPart);
        }

        DocumentFile target = parent.findFile(fileName);
        if (target == null) {
            target = parent.createFile(guessMimeType(fileName), fileName);
            if (target == null) {
                target = parent.createFile("application/octet-stream", fileName);
            }
        }
        if (target == null) {
            throw new IOException("无法创建文件：" + fileName);
        }

        byte[] bytes = (content != null ? content : "").getBytes(StandardCharsets.UTF_8);
        OutputStream os = null;
        try {
            try {
                os = getContext().getContentResolver().openOutputStream(target.getUri(), "wt");
            } catch (IllegalArgumentException e) {
                try {
                    os = getContext().getContentResolver().openOutputStream(target.getUri(), "rwt");
                } catch (IllegalArgumentException e2) {
                    os = getContext().getContentResolver().openOutputStream(target.getUri(), "w");
                }
            }
            if (os == null) {
                throw new IOException("无法打开文件输出流：" + fileName);
            }
            os.write(bytes);
            os.flush();
        } finally {
            if (os != null) {
                try {
                    os.close();
                } catch (IOException ignored) {
                }
            }
        }
    }

    private void deleteSafFile(
        DocumentFile root,
        String relPath,
        Map<String, DocumentFile> cache
    ) {
        int slash = relPath.lastIndexOf('/');
        String dirPart = slash >= 0 ? relPath.substring(0, slash) : "";
        String fileName = slash >= 0 ? relPath.substring(slash + 1) : relPath;
        DocumentFile parent = findSafDir(root, dirPart, cache);
        if (parent == null) return;
        DocumentFile target = parent.findFile(fileName);
        if (target != null && target.isFile()) {
            target.delete();
        }
    }

    private void rmdirSafIfEmpty(
        DocumentFile root,
        String relDirPath,
        Map<String, DocumentFile> cache
    ) {
        DocumentFile dir = findSafDir(root, relDirPath, cache);
        if (dir == null || dir == root || !dir.isDirectory()) return;
        DocumentFile[] children = dir.listFiles();
        if (children == null || children.length == 0) {
            dir.delete();
            cache.remove(relDirPath);
        }
    }

    private String readSafText(DocumentFile file) {
        try (InputStream is = getContext().getContentResolver().openInputStream(file.getUri())) {
            if (is == null) return "";
            return readStreamUtf8(is);
        } catch (Exception e) {
            return "";
        }
    }

    private static String readRegularFileText(File file) {
        try (InputStream is = new FileInputStream(file)) {
            return readStreamUtf8(is);
        } catch (Exception e) {
            return "";
        }
    }

    private static String readStreamUtf8(InputStream is) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) != -1) {
            baos.write(buf, 0, n);
        }
        byte[] rawBytes = baos.toByteArray();
        if (rawBytes.length == 0) {
            return "";
        }
        if (rawBytes.length >= 3
                && (rawBytes[0] & 0xFF) == 0xEF
                && (rawBytes[1] & 0xFF) == 0xBB
                && (rawBytes[2] & 0xFF) == 0xBF) {
            return new String(rawBytes, 3, rawBytes.length - 3, StandardCharsets.UTF_8);
        }
        if (rawBytes.length >= 2
                && (rawBytes[0] & 0xFF) == 0xFF
                && (rawBytes[1] & 0xFF) == 0xFE) {
            return new String(rawBytes, 2, rawBytes.length - 2, StandardCharsets.UTF_16LE);
        }
        if (rawBytes.length >= 2
                && (rawBytes[0] & 0xFF) == 0xFE
                && (rawBytes[1] & 0xFF) == 0xFF) {
            return new String(rawBytes, 2, rawBytes.length - 2, StandardCharsets.UTF_16BE);
        }
        try {
            CharsetDecoder utf8Decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
            String text = utf8Decoder.decode(ByteBuffer.wrap(rawBytes)).toString();
            if (!text.isEmpty() && text.charAt(0) == '\\uFEFF') {
                return text.substring(1);
            }
            return text;
        } catch (CharacterCodingException ignored) {
            try {
                return new String(rawBytes, Charset.forName("GB18030"));
            } catch (Exception ignored2) {
                try {
                    return new String(rawBytes, Charset.forName("GBK"));
                } catch (Exception ignored3) {
                    return new String(rawBytes, StandardCharsets.UTF_8);
                }
            }
        }
    }
}
`;

  const mainActivityJava = `package com.feiartical.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.ActionMode;
import android.view.KeyEvent;
import android.view.Menu;
import android.view.MenuInflater;
import android.view.MotionEvent;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.WebView;
import android.widget.PopupMenu;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import java.util.Arrays;

public class MainActivity extends BridgeActivity {
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private boolean nativePressActive = false;
    private float nativePressRawX = 0f;
    private float nativePressRawY = 0f;
    private long lastTouchMoveDispatchMs = 0L;
    private float lastTouchMoveCssX = -1f;
    private float lastTouchMoveCssY = -1f;

    private float[] rawToWebViewCss(float rawX, float rawY) {
        float density = getResources().getDisplayMetrics().density;
        if (density <= 0f) density = 1f;
        float cssX = rawX / density;
        float cssY = rawY / density;
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webView = getBridge().getWebView();
            int[] loc = new int[2];
            webView.getLocationOnScreen(loc);
            cssX = (rawX - loc[0]) / density;
            cssY = (rawY - loc[1]) / density;
        }
        return new float[]{cssX, cssY};
    }

    private final Runnable nativeLongPressRunnable = new Runnable() {
        @Override
        public void run() {
            if (!nativePressActive) return;
            nativePressActive = false;
            if (!ReaderNativePlugin.inputPasteTrackingEnabled) return;
            float[] css = rawToWebViewCss(nativePressRawX, nativePressRawY);
            ReaderNativePlugin.dispatchNativeLongPress(css[0], css[1]);
        }
    };

    private void cancelNativeLongPress() {
        nativePressActive = false;
        mainHandler.removeCallbacks(nativeLongPressRunnable);
    }
    private final class SilentActionMode extends ActionMode {
        private final ActionMode.Callback callback;
        private final Menu emptyMenu;
        private boolean finished = false;

        SilentActionMode(ActionMode.Callback callback) {
            this.callback = callback;
            View anchor = getWindow() != null ? getWindow().getDecorView() : new View(MainActivity.this);
            this.emptyMenu = new PopupMenu(MainActivity.this, anchor).getMenu();
        }

        @Override
        public void setTitle(CharSequence title) {}

        @Override
        public void setTitle(int resId) {}

        @Override
        public void setSubtitle(CharSequence subtitle) {}

        @Override
        public void setSubtitle(int resId) {}

        @Override
        public void setCustomView(View view) {}

        @Override
        public void invalidate() {
            emptyMenu.clear();
        }

        @Override
        public void finish() {
            if (finished) return;
            finished = true;
            if (callback != null) {
                try {
                    callback.onDestroyActionMode(this);
                } catch (Exception ignored) {
                }
            }
        }

        @Override
        public Menu getMenu() {
            return emptyMenu;
        }

        @Override
        public CharSequence getTitle() {
            return "";
        }

        @Override
        public CharSequence getSubtitle() {
            return "";
        }

        @Override
        public View getCustomView() {
            return null;
        }

        @Override
        public MenuInflater getMenuInflater() {
            return MainActivity.this.getMenuInflater();
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WebDavPlugin.class);
        registerPlugin(LanServerPlugin.class);
        registerPlugin(LanWebDavPlugin.class);
        registerPlugin(WifiSyncPlugin.class);
        registerPlugin(ReaderNativePlugin.class);
        registerPlugin(LocalStoragePlugin.class);
        super.onCreate(savedInstanceState);
        installAudioPermissionWebChromeClient();
        applySystemBarAndCutoutInsets();
    }

    private void installAudioPermissionWebChromeClient() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        getBridge().getWebView().setWebChromeClient(new BridgeWebChromeClient(getBridge()) {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                if (request == null) return;
                String[] resources = request.getResources();
                boolean asksAudio = false;
                boolean asksVideo = false;
                if (resources != null) {
                    for (String res : resources) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) {
                            asksAudio = true;
                        } else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)) {
                            asksVideo = true;
                        }
                    }
                }
                if (
                    asksAudio &&
                    !asksVideo &&
                    ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.RECORD_AUDIO)
                        == PackageManager.PERMISSION_GRANTED
                ) {
                    runOnUiThread(() -> {
                        try {
                            request.grant(resources);
                        } catch (Exception ignored) {
                        }
                    });
                    return;
                }
                super.onPermissionRequest(request);
            }
        });
    }

    @Override
    public ActionMode onWindowStartingActionMode(ActionMode.Callback callback) {
        return createSilentActionMode(callback);
    }

    @Override
    public ActionMode onWindowStartingActionMode(ActionMode.Callback callback, int type) {
        return createSilentActionMode(callback);
    }

    private ActionMode createSilentActionMode(ActionMode.Callback callback) {
        if (callback == null) return null;
        SilentActionMode mode = new SilentActionMode(callback);
        try {
            callback.onCreateActionMode(mode, mode.getMenu());
        } catch (Exception ignored) {
        }
        mode.getMenu().clear();
        ReaderNativePlugin.dispatchInputActionMode();
        return mode;
    }

    @Override
    public void onActionModeStarted(ActionMode mode) {
        super.onActionModeStarted(mode);
        if (mode != null && !(mode instanceof SilentActionMode)) {
            try {
                mode.getMenu().clear();
            } catch (Exception ignored) {
            }
            ReaderNativePlugin.dispatchInputActionMode();
        }
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        if (ev != null) {
            int action = ev.getActionMasked();
            if (action == MotionEvent.ACTION_DOWN) {
                float[] css = rawToWebViewCss(ev.getRawX(), ev.getRawY());
                lastTouchMoveDispatchMs = System.currentTimeMillis();
                lastTouchMoveCssX = css[0];
                lastTouchMoveCssY = css[1];
                ReaderNativePlugin.dispatchTouchState(true, css[0], css[1], true);
                cancelNativeLongPress();
                if (ReaderNativePlugin.inputPasteTrackingEnabled) {
                    nativePressActive = true;
                    nativePressRawX = ev.getRawX();
                    nativePressRawY = ev.getRawY();
                    mainHandler.postDelayed(nativeLongPressRunnable, 380L);
                }
            } else if (action == MotionEvent.ACTION_POINTER_DOWN) {
                cancelNativeLongPress();
            } else if (action == MotionEvent.ACTION_MOVE) {
                if (nativePressActive) {
                    float density = getResources().getDisplayMetrics().density;
                    float slopPx = Math.max(24f * (density > 0f ? density : 1f), 24f);
                    float dx = ev.getRawX() - nativePressRawX;
                    float dy = ev.getRawY() - nativePressRawY;
                    if (dx * dx + dy * dy > slopPx * slopPx) {
                        cancelNativeLongPress();
                    }
                }
                if (ReaderNativePlugin.touchStateTrackingEnabled && ev.getPointerCount() == 1) {
                    long nowMs = System.currentTimeMillis();
                    if (nowMs - lastTouchMoveDispatchMs >= 24L) {
                        float[] css = rawToWebViewCss(ev.getRawX(), ev.getRawY());
                        float dCssX = css[0] - lastTouchMoveCssX;
                        float dCssY = css[1] - lastTouchMoveCssY;
                        if (dCssX * dCssX + dCssY * dCssY >= 9f) {
                            lastTouchMoveDispatchMs = nowMs;
                            lastTouchMoveCssX = css[0];
                            lastTouchMoveCssY = css[1];
                            ReaderNativePlugin.dispatchTouchMove(css[0], css[1]);
                        }
                    }
                }
            } else if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                cancelNativeLongPress();
                float[] css = rawToWebViewCss(ev.getRawX(), ev.getRawY());
                ReaderNativePlugin.dispatchTouchState(false, css[0], css[1], true);
            }
        }
        return super.dispatchTouchEvent(ev);
    }

    @Override
    public void onPause() {
        cancelNativeLongPress();
        ReaderNativePlugin.dispatchTouchState(false);
        super.onPause();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (ReaderNativePlugin.volumeKeyInterceptEnabled && event != null) {
            int code = event.getKeyCode();
            if (code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN) {
                if (event.getAction() == KeyEvent.ACTION_DOWN) {
                    ReaderNativePlugin.dispatchVolumeKey(
                        code == KeyEvent.KEYCODE_VOLUME_UP ? "up" : "down"
                    );
                }
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applySystemBarAppearance(newConfig);
    }

    private void updateBottomToolbarGestureExclusion(View content) {
        if (content == null) return;
        int w = content.getWidth();
        int h = content.getHeight();
        if (w <= 0 || h <= 0) return;
        float density = getResources().getDisplayMetrics().density;
        if (density <= 0f) density = 1f;
        int toolbarHeightPx = Math.round(72f * density);
        int cornerWidthPx = Math.round(72f * density);
        int bottom = Math.max(0, h - content.getPaddingBottom());
        int top = Math.max(0, bottom - toolbarHeightPx);
        int leftStart = Math.max(0, content.getPaddingLeft());
        int leftEnd = Math.min(w, leftStart + cornerWidthPx);
        int rightEnd = Math.max(0, w - content.getPaddingRight());
        int rightStart = Math.max(0, rightEnd - cornerWidthPx);
        if (bottom > top && leftEnd > leftStart && rightEnd > rightStart) {
            ViewCompat.setSystemGestureExclusionRects(
                content,
                Arrays.asList(
                    new Rect(leftStart, top, leftEnd, bottom),
                    new Rect(rightStart, top, rightEnd, bottom)
                )
            );
        }
    }

    private void applySystemBarAndCutoutInsets() {
        View content = findViewById(android.R.id.content);
        if (content == null) return;
        applySystemBarAppearance(getResources().getConfiguration());
        content.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) ->
            updateBottomToolbarGestureExclusion(v)
        );
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            v.post(() -> updateBottomToolbarGestureExclusion(v));
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(content);
    }

    private void applySystemBarAppearance(Configuration config) {
        boolean isNight = (config.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int bgColor = isNight ? 0xFF1A1A1A : 0xFFFFFFFF;
        View content = findViewById(android.R.id.content);
        if (content != null) {
            content.setBackgroundColor(bgColor);
        }
        getWindow().getDecorView().setBackgroundColor(bgColor);
        WindowInsetsControllerCompat controller = new WindowInsetsControllerCompat(
            getWindow(),
            getWindow().getDecorView()
        );
        controller.setAppearanceLightStatusBars(!isNight);
        controller.setAppearanceLightNavigationBars(!isNight);
    }
}
`;

  const wifiSyncPluginJava = `package com.feiartical.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "WifiSyncNative")
public class WifiSyncPlugin extends Plugin {
    private static final int DEFAULT_SYNC_PORT = 48765;
    private static final int DISCOVERY_UDP_PORT = 48766;
    private static final int MAX_RPC_BODY_BYTES = 40 * 1024 * 1024;
    private static final int GCM_IV_LEN = 12;
    private static final int GCM_TAG_BITS = 128;

    private static class ServerSession {
        final byte[] sessionKey;
        final long expiresAt;

        ServerSession(byte[] sessionKey, long expiresAt) {
            this.sessionKey = sessionKey;
            this.expiresAt = expiresAt;
        }
    }

    private static class ClientSession {
        final String host;
        final int port;
        final String token;
        final byte[] sessionKey;
        final String peerName;

        ClientSession(String host, int port, String token, byte[] sessionKey, String peerName) {
            this.host = host;
            this.port = port;
            this.token = token;
            this.sessionKey = sessionKey;
            this.peerName = peerName;
        }
    }

    private static class PendingJsRequest {
        final CountDownLatch latch = new CountDownLatch(1);
        volatile boolean ok = false;
        volatile String payloadJson = "{}";
    }

    private static class DiscoveredPeer {
        final String id;
        final String name;
        final String ip;
        final int port;
        final String stateHash;
        volatile long lastSeenAt;

        DiscoveredPeer(String id, String name, String ip, int port, String stateHash, long lastSeenAt) {
            this.id = id;
            this.name = name;
            this.ip = ip;
            this.port = port;
            this.stateHash = stateHash != null ? stateHash : "";
            this.lastSeenAt = lastSeenAt;
        }
    }

    private final ExecutorService serverPool = Executors.newCachedThreadPool();
    private final ExecutorService clientPool = Executors.newFixedThreadPool(2);
    private final SecureRandom secureRandom = new SecureRandom();
    private final String instanceId = UUID.randomUUID().toString().replace("-", "").substring(0, 12);

    private final Map<String, Long> serverChallenges = new ConcurrentHashMap<>();
    private final Map<String, ServerSession> serverSessions = new ConcurrentHashMap<>();
    private final Map<String, long[]> failedAuthByIp = new ConcurrentHashMap<>();
    private final Map<String, PendingJsRequest> pendingJsRequests = new ConcurrentHashMap<>();
    private final Map<String, ClientSession> clientSessions = new ConcurrentHashMap<>();
    private final Map<String, DiscoveredPeer> discoveredPeers = new ConcurrentHashMap<>();

    private static final String NSD_SERVICE_TYPE = "_feiartical._tcp.";
    private static final String PREFS_NAME = "FeiArticalWifiSyncPrefs";
    private static final String PREF_RECENT_PEER_IPS = "recent_peer_ips";

    private volatile ServerSocket serverSocket;
    private volatile DatagramSocket discoverySocket;
    private volatile WifiManager.MulticastLock multicastLock;
    private volatile NsdManager nsdManager;
    private volatile NsdManager.RegistrationListener nsdRegListener;
    private volatile NsdManager.DiscoveryListener nsdDiscListener;
    private volatile String registeredNsdName = "";
    private volatile boolean running = false;
    private volatile int activePort = DEFAULT_SYNC_PORT;
    private volatile String activeIp = "";
    private volatile String activePassword = "";
    private volatile String activeDeviceName = "";
    private volatile String activeStateHash = "";

    @PluginMethod
    public void startServer(PluginCall call) {
        String password = call.getString("password", "");
        if (password == null || password.isEmpty()) {
            call.reject("请先在设置中配置加密密码后，再使用 Wi-Fi 同步");
            return;
        }
        int preferredPort = call.getInt("port", DEFAULT_SYNC_PORT);
        String customName = call.getString("deviceName", "");
        String resolvedName = (customName != null && !customName.trim().isEmpty())
            ? customName.trim()
            : buildDefaultDeviceName();
        String stateHash = call.getString("stateHash", "");

        this.activePassword = password;
        this.activeDeviceName = resolvedName;
        this.activeStateHash = stateHash != null ? stateHash : "";

        if (running && serverSocket != null && !serverSocket.isClosed()) {
            triggerImmediateBeacon();
            JSObject res = new JSObject();
            res.put("running", true);
            res.put("ip", activeIp);
            res.put("port", activePort);
            res.put("deviceName", activeDeviceName);
            res.put("instanceId", instanceId);
            call.resolve(res);
            return;
        }

        String ip = resolveLanIpv4();
        if (ip == null || ip.isEmpty()) {
            call.reject("未检测到局域网 Wi-Fi，请确认设备已连接 Wi-Fi");
            return;
        }

        ServerSocket sock = null;
        int boundPort = preferredPort;
        for (int p = preferredPort; p <= preferredPort + 10; p++) {
            try {
                sock = new ServerSocket(p);
                boundPort = p;
                break;
            } catch (IOException ignored) {
            }
        }
        if (sock == null) {
            call.reject("无法启动 Wi-Fi 同步端口，请重试");
            return;
        }

        this.serverSocket = sock;
        this.activePort = boundPort;
        this.activeIp = ip;
        this.running = true;
        this.serverChallenges.clear();
        this.serverSessions.clear();
        this.failedAuthByIp.clear();
        this.discoveredPeers.clear();

        final ServerSocket listening = sock;
        serverPool.execute(() -> {
            while (running && !listening.isClosed()) {
                try {
                    Socket client = listening.accept();
                    serverPool.execute(() -> handleServerConnection(client));
                } catch (IOException e) {
                    if (!running) break;
                }
            }
        });

        startUdpDiscovery();
        startNsdDiscovery();

        JSObject res = new JSObject();
        res.put("running", true);
        res.put("ip", activeIp);
        res.put("port", activePort);
        res.put("deviceName", activeDeviceName);
        res.put("instanceId", instanceId);
        call.resolve(res);
    }

    @PluginMethod
    public void stopServer(PluginCall call) {
        stopInternal();
        JSObject res = new JSObject();
        res.put("running", false);
        call.resolve(res);
    }

    @PluginMethod
    public void updateStateHash(PluginCall call) {
        String nextHash = call.getString("stateHash", "");
        String normalized = nextHash != null ? nextHash : "";
        boolean changed = !normalized.equals(this.activeStateHash);
        this.activeStateHash = normalized;
        if (changed && running) {
            triggerImmediateBeacon();
        }
        JSObject res = new JSObject();
        res.put("ok", true);
        call.resolve(res);
    }

    @PluginMethod
    public void resolveServerRequest(PluginCall call) {
        String reqId = call.getString("reqId", "");
        boolean ok = Boolean.TRUE.equals(call.getBoolean("ok", true));
        String payloadJson = call.getString("payloadJson", "{}");
        PendingJsRequest pending = pendingJsRequests.remove(reqId);
        if (pending != null) {
            pending.ok = ok;
            pending.payloadJson = payloadJson != null ? payloadJson : "{}";
            pending.latch.countDown();
        }
        JSObject res = new JSObject();
        res.put("ok", true);
        call.resolve(res);
    }

    @PluginMethod
    public void peerConnect(PluginCall call) {
        final String host = call.getString("host", "").trim();
        final int port = call.getInt("port", DEFAULT_SYNC_PORT);
        final String password = call.getString("password", "");
        if (host.isEmpty() || password == null || password.isEmpty()) {
            call.reject("缺少对方设备地址或加密密码");
            return;
        }

        clientPool.execute(() -> {
            try {
                // Step 1: GET /wifi-sync/challenge (direct raw TCP socket bypasses Android cleartext & HTTP proxy blocks)
                HttpResult chRes = httpRequest("GET", host, port, "/wifi-sync/challenge", null, null, 8000);
                if (chRes.status == 429) {
                    call.reject("密码错误次数过多，对方设备已暂时锁定，请 1 分钟后再试");
                    return;
                }
                if (chRes.status != 200) {
                    call.reject("无法连接对方设备（HTTP " + chRes.status + "），请确认对方处于目录界面");
                    return;
                }
                JSONObject chObj = new JSONObject(new String(chRes.body, StandardCharsets.UTF_8));
                String serverNonce = chObj.optString("serverNonce", "");
                String peerName = chObj.optString("deviceName", host);
                if (serverNonce.isEmpty()) {
                    call.reject("对方设备握手协议异常");
                    return;
                }

                // Step 2: Compute mutual HMAC-SHA256 challenge-response (password never leaves device)
                String clientNonce = randomHex(16);
                byte[] authKey = sha256("fei-wifi-auth-v1:" + password);
                String clientProof = hmacSha256Hex(authKey, "client:" + serverNonce + ":" + clientNonce);

                JSONObject authReq = new JSONObject();
                authReq.put("serverNonce", serverNonce);
                authReq.put("clientNonce", clientNonce);
                authReq.put("clientProof", clientProof);

                Map<String, String> headers = new HashMap<>();
                headers.put("Content-Type", "application/json; charset=utf-8");
                HttpResult authRes = httpRequest(
                    "POST",
                    host,
                    port,
                    "/wifi-sync/auth",
                    headers,
                    authReq.toString().getBytes(StandardCharsets.UTF_8),
                    8000
                );
                if (authRes.status == 429) {
                    call.reject("密码错误次数过多，对方设备已锁定 1 分钟");
                    return;
                }
                if (authRes.status == 401) {
                    call.reject("加密密码不一致，请确认两台设备设置了相同的加密密码");
                    return;
                }
                if (authRes.status != 200) {
                    call.reject("身份验证失败（HTTP " + authRes.status + "）");
                    return;
                }

                JSONObject authObj = new JSONObject(new String(authRes.body, StandardCharsets.UTF_8));
                String token = authObj.optString("token", "");
                String serverProof = authObj.optString("serverProof", "");
                String expectedServerProof = hmacSha256Hex(authKey, "server:" + serverNonce + ":" + clientNonce);
                if (token.isEmpty() || !constantTimeEquals(expectedServerProof, serverProof.toLowerCase(Locale.ROOT))) {
                    call.reject("对方设备双向身份校验失败，已中止连接");
                    return;
                }

                byte[] sessionKey = hmacSha256Raw(authKey, "session:" + serverNonce + ":" + clientNonce);
                String sessionId = randomHex(12);
                clientSessions.put(sessionId, new ClientSession(host, port, token, sessionKey, peerName));
                rememberPeerIp(host);

                JSObject out = new JSObject();
                out.put("ok", true);
                out.put("sessionId", sessionId);
                out.put("deviceName", peerName);
                call.resolve(out);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "连接对方设备失败");
            }
        });
    }

    @PluginMethod
    public void peerRpc(PluginCall call) {
        final String sessionId = call.getString("sessionId", "");
        final String action = call.getString("action", "");
        final String payloadJson = call.getString("payloadJson", "{}");
        final ClientSession session = clientSessions.get(sessionId);
        if (session == null) {
            call.reject("同步会话已失效");
            return;
        }

        clientPool.execute(() -> {
            try {
                JSONObject env = new JSONObject();
                env.put("action", action);
                env.put("payload", payloadJson != null ? payloadJson : "{}");
                byte[] encrypted = encryptAesGcm(session.sessionKey, env.toString().getBytes(StandardCharsets.UTF_8));

                Map<String, String> headers = new HashMap<>();
                headers.put("Content-Type", "application/octet-stream");
                headers.put("X-Wifi-Token", session.token);

                HttpResult res = httpRequest(
                    "POST",
                    session.host,
                    session.port,
                    "/wifi-sync/rpc",
                    headers,
                    encrypted,
                    35000
                );
                if (res.status != 200) {
                    call.reject("同步通信失败（HTTP " + res.status + "）");
                    return;
                }
                byte[] plain = decryptAesGcm(session.sessionKey, res.body);
                JSObject out = new JSObject();
                out.put("ok", true);
                out.put("payloadJson", new String(plain, StandardCharsets.UTF_8));
                call.resolve(out);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "同步数据通信失败");
            }
        });
    }

    @PluginMethod
    public void peerPullImage(PluginCall call) {
        final String sessionId = call.getString("sessionId", "");
        final String relPath = call.getString("relPath", "");
        final ClientSession session = clientSessions.get(sessionId);
        if (session == null || relPath == null || relPath.isEmpty()) {
            JSObject err = new JSObject();
            err.put("ok", false);
            call.resolve(err);
            return;
        }

        clientPool.execute(() -> {
            try {
                byte[] encPath = encryptAesGcm(session.sessionKey, relPath.getBytes(StandardCharsets.UTF_8));
                Map<String, String> headers = new HashMap<>();
                headers.put("Content-Type", "application/octet-stream");
                headers.put("X-Wifi-Token", session.token);

                HttpResult res = httpRequest(
                    "POST",
                    session.host,
                    session.port,
                    "/wifi-sync/image/get",
                    headers,
                    encPath,
                    30000
                );
                if (res.status != 200 || res.body == null || res.body.length == 0) {
                    JSObject err = new JSObject();
                    err.put("ok", false);
                    call.resolve(err);
                    return;
                }
                byte[] plainBytes = decryptAesGcm(session.sessionKey, res.body);
                boolean saved = LocalStoragePlugin.writeBinaryBytesSync(relPath, plainBytes);
                JSObject out = new JSObject();
                out.put("ok", saved);
                out.put("bytes", plainBytes.length);
                call.resolve(out);
            } catch (Exception e) {
                JSObject err = new JSObject();
                err.put("ok", false);
                err.put("error", e.getMessage() != null ? e.getMessage() : "拉取图片失败");
                call.resolve(err);
            }
        });
    }

    @PluginMethod
    public void peerPushImage(PluginCall call) {
        final String sessionId = call.getString("sessionId", "");
        final String relPath = call.getString("relPath", "");
        final ClientSession session = clientSessions.get(sessionId);
        if (session == null || relPath == null || relPath.isEmpty()) {
            JSObject err = new JSObject();
            err.put("ok", false);
            call.resolve(err);
            return;
        }

        clientPool.execute(() -> {
            try {
                byte[] rawBytes = LocalStoragePlugin.readBinaryBytesSync(relPath);
                if (rawBytes == null || rawBytes.length == 0) {
                    JSObject err = new JSObject();
                    err.put("ok", false);
                    call.resolve(err);
                    return;
                }
                byte[] encPath = encryptAesGcm(session.sessionKey, relPath.getBytes(StandardCharsets.UTF_8));
                byte[] encBody = encryptAesGcm(session.sessionKey, rawBytes);

                Map<String, String> headers = new HashMap<>();
                headers.put("Content-Type", "application/octet-stream");
                headers.put("X-Wifi-Token", session.token);
                headers.put("X-Image-Path", Base64.encodeToString(encPath, Base64.NO_WRAP));

                HttpResult res = httpRequest(
                    "POST",
                    session.host,
                    session.port,
                    "/wifi-sync/image/put",
                    headers,
                    encBody,
                    30000
                );
                JSObject out = new JSObject();
                out.put("ok", res.status == 200);
                out.put("bytes", rawBytes.length);
                call.resolve(out);
            } catch (Exception e) {
                JSObject err = new JSObject();
                err.put("ok", false);
                err.put("error", e.getMessage() != null ? e.getMessage() : "发送图片失败");
                call.resolve(err);
            }
        });
    }

    @PluginMethod
    public void peerDisconnect(PluginCall call) {
        String sessionId = call.getString("sessionId", "");
        final ClientSession removed = sessionId != null ? clientSessions.remove(sessionId) : null;
        if (removed != null) {
            clientPool.execute(() -> {
                try {
                    Map<String, String> headers = new HashMap<>();
                    headers.put("X-Wifi-Token", removed.token);
                    httpRequest(
                        "POST",
                        removed.host,
                        removed.port,
                        "/wifi-sync/bye",
                        headers,
                        new byte[0],
                        2000
                    );
                } catch (Exception ignored) {
                }
            });
        }
        JSObject out = new JSObject();
        out.put("ok", true);
        call.resolve(out);
    }

    @Override
    protected void handleOnDestroy() {
        stopInternal();
        clientSessions.clear();
        super.handleOnDestroy();
    }

    private void stopInternal() {
        running = false;
        activePassword = "";
        serverChallenges.clear();
        serverSessions.clear();
        failedAuthByIp.clear();
        discoveredPeers.clear();
        for (PendingJsRequest p : pendingJsRequests.values()) {
            p.ok = false;
            p.latch.countDown();
        }
        pendingJsRequests.clear();

        ServerSocket s = serverSocket;
        serverSocket = null;
        if (s != null) {
            try { s.close(); } catch (IOException ignored) {}
        }

        DatagramSocket ds = discoverySocket;
        discoverySocket = null;
        if (ds != null) {
            try { ds.close(); } catch (Exception ignored) {}
        }

        stopNsdDiscovery();

        WifiManager.MulticastLock lock = multicastLock;
        multicastLock = null;
        if (lock != null && lock.isHeld()) {
            try { lock.release(); } catch (Exception ignored) {}
        }
    }

    private void upsertDiscoveredPeer(String peerId, String peerName, String peerIp, int peerPort, String peerHash) {
        if (peerId == null || peerId.isEmpty() || peerId.equals(instanceId)) return;
        if (peerIp == null || peerIp.isEmpty() || peerIp.equals(activeIp)) return;
        String safeName = (peerName != null && !peerName.isEmpty()) ? peerName : peerIp;
        String safeHash = peerHash != null ? peerHash : "";
        long nowMs = System.currentTimeMillis();
        DiscoveredPeer prev = discoveredPeers.get(peerId);
        // If NSD resolves with empty hash while UDP already gave us a real hash, keep the existing hash
        String resolvedHash = (!safeHash.isEmpty() || prev == null) ? safeHash : prev.stateHash;
        boolean peerChanged = prev == null
            || !safeName.equals(prev.name)
            || !peerIp.equals(prev.ip)
            || peerPort != prev.port
            || !resolvedHash.equals(prev.stateHash);
        if (peerChanged) {
            discoveredPeers.put(peerId, new DiscoveredPeer(peerId, safeName, peerIp, peerPort, resolvedHash, nowMs));
            rememberPeerIp(peerIp);
            emitPeersToJs();
        } else {
            prev.lastSeenAt = nowMs;
        }
    }

    private void startNsdDiscovery() {
        try {
            NsdManager mgr = (NsdManager) getContext().getApplicationContext().getSystemService(Context.NSD_SERVICE);
            if (mgr == null) return;
            this.nsdManager = mgr;

            NsdServiceInfo svc = new NsdServiceInfo();
            svc.setServiceName("FeiArtical-" + instanceId);
            svc.setServiceType(NSD_SERVICE_TYPE);
            svc.setPort(activePort);
            svc.setAttribute("id", instanceId);
            svc.setAttribute("name", activeDeviceName);
            if (activeStateHash != null && !activeStateHash.isEmpty()) {
                svc.setAttribute("hash", activeStateHash);
            }

            NsdManager.RegistrationListener regListener = new NsdManager.RegistrationListener() {
                @Override
                public void onServiceRegistered(NsdServiceInfo info) {
                    registeredNsdName = info.getServiceName() != null ? info.getServiceName() : "";
                }
                @Override
                public void onRegistrationFailed(NsdServiceInfo info, int errorCode) {}
                @Override
                public void onServiceUnregistered(NsdServiceInfo info) {}
                @Override
                public void onUnregistrationFailed(NsdServiceInfo info, int errorCode) {}
            };
            this.nsdRegListener = regListener;
            mgr.registerService(svc, NsdManager.PROTOCOL_DNS_SD, regListener);

            NsdManager.DiscoveryListener discListener = new NsdManager.DiscoveryListener() {
                @Override
                public void onDiscoveryStarted(String regType) {}
                @Override
                public void onServiceFound(NsdServiceInfo serviceInfo) {
                    if (!running) return;
                    String svcName = serviceInfo.getServiceName();
                    if (svcName == null || !svcName.startsWith("FeiArtical-")) return;
                    if (svcName.equals(registeredNsdName) || svcName.equals("FeiArtical-" + instanceId)) return;
                    try {
                        mgr.resolveService(serviceInfo, new NsdManager.ResolveListener() {
                            @Override
                            public void onResolveFailed(NsdServiceInfo info, int errorCode) {}
                            @Override
                            public void onServiceResolved(NsdServiceInfo resolved) {
                                if (!running) return;
                                InetAddress hostAddr = resolved.getHost();
                                if (hostAddr == null) return;
                                String peerIp = hostAddr.getHostAddress();
                                int peerPort = resolved.getPort();
                                Map<String, byte[]> attrs = resolved.getAttributes();
                                String peerId = readNsdAttr(attrs, "id");
                                if (peerId.isEmpty() && resolved.getServiceName() != null && resolved.getServiceName().startsWith("FeiArtical-")) {
                                    peerId = resolved.getServiceName().substring("FeiArtical-".length());
                                }
                                String peerName = readNsdAttr(attrs, "name");
                                String peerHash = readNsdAttr(attrs, "hash");
                                upsertDiscoveredPeer(peerId, peerName, peerIp, peerPort, peerHash);
                                // Immediately unicast our UDP beacon to this resolved IP so both sides exchange fresh stateHash
                                sendUnicastBeaconToIp(peerIp);
                            }
                        });
                    } catch (Exception ignored) {
                    }
                }
                @Override
                public void onServiceLost(NsdServiceInfo serviceInfo) {}
                @Override
                public void onDiscoveryStopped(String serviceType) {}
                @Override
                public void onStartDiscoveryFailed(String serviceType, int errorCode) {}
                @Override
                public void onStopDiscoveryFailed(String serviceType, int errorCode) {}
            };
            this.nsdDiscListener = discListener;
            mgr.discoverServices(NSD_SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discListener);
        } catch (Exception ignored) {
        }
    }

    private void stopNsdDiscovery() {
        NsdManager mgr = nsdManager;
        nsdManager = null;
        NsdManager.RegistrationListener reg = nsdRegListener;
        nsdRegListener = null;
        NsdManager.DiscoveryListener disc = nsdDiscListener;
        nsdDiscListener = null;
        registeredNsdName = "";
        if (mgr != null) {
            if (disc != null) {
                try { mgr.stopServiceDiscovery(disc); } catch (Exception ignored) {}
            }
            if (reg != null) {
                try { mgr.unregisterService(reg); } catch (Exception ignored) {}
            }
        }
    }

    private static String readNsdAttr(Map<String, byte[]> attrs, String key) {
        if (attrs == null) return "";
        byte[] val = attrs.get(key);
        if (val == null || val.length == 0) return "";
        return new String(val, StandardCharsets.UTF_8).trim();
    }

    private void rememberPeerIp(String ip) {
        if (ip == null || ip.isEmpty() || ip.equals(activeIp)) return;
        try {
            SharedPreferences prefs = getContext().getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String existing = prefs.getString(PREF_RECENT_PEER_IPS, "");
            java.util.LinkedHashSet<String> set = new java.util.LinkedHashSet<>();
            set.add(ip);
            if (existing != null && !existing.isEmpty()) {
                for (String part : existing.split(",")) {
                    String trimmed = part.trim();
                    if (!trimmed.isEmpty() && !trimmed.equals(activeIp) && set.size() < 6) {
                        set.add(trimmed);
                    }
                }
            }
            StringBuilder sb = new StringBuilder();
            for (String s : set) {
                if (sb.length() > 0) sb.append(",");
                sb.append(s);
            }
            prefs.edit().putString(PREF_RECENT_PEER_IPS, sb.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    private Set<String> loadRememberedPeerIps() {
        Set<String> ips = new HashSet<>();
        try {
            SharedPreferences prefs = getContext().getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String existing = prefs.getString(PREF_RECENT_PEER_IPS, "");
            if (existing != null && !existing.isEmpty()) {
                for (String part : existing.split(",")) {
                    String trimmed = part.trim();
                    if (!trimmed.isEmpty() && !trimmed.equals(activeIp)) {
                        ips.add(trimmed);
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return ips;
    }

    private void sendUnicastBeaconToIp(String targetIp) {
        final DatagramSocket ds = discoverySocket;
        if (!running || ds == null || ds.isClosed() || targetIp == null || targetIp.isEmpty() || targetIp.equals(activeIp)) return;
        serverPool.execute(() -> {
            try {
                byte[] payload = buildBeaconBytes();
                sendBroadcastPacket(ds, payload, InetAddress.getByName(targetIp));
            } catch (Exception ignored) {
            }
        });
    }

    private void startUdpDiscovery() {
        try {
            WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                WifiManager.MulticastLock lock = wm.createMulticastLock("FeiArticalWifiSync");
                lock.setReferenceCounted(false);
                lock.acquire();
                this.multicastLock = lock;
            }
        } catch (Exception ignored) {
        }

        try {
            DatagramSocket ds = new DatagramSocket(null);
            ds.setReuseAddress(true);
            ds.setBroadcast(true);
            ds.bind(new InetSocketAddress(DISCOVERY_UDP_PORT));
            ds.setSoTimeout(1500);
            this.discoverySocket = ds;

            // Listener thread
            serverPool.execute(() -> {
                byte[] buf = new byte[1024];
                while (running && !ds.isClosed()) {
                    try {
                        DatagramPacket pkt = new DatagramPacket(buf, buf.length);
                        ds.receive(pkt);
                        String text = new String(pkt.getData(), 0, pkt.getLength(), StandardCharsets.UTF_8);
                        JSONObject obj = new JSONObject(text);
                        if (!"feiartical".equals(obj.optString("app"))) continue;
                        String peerId = obj.optString("id", "");
                        if (peerId.isEmpty() || peerId.equals(instanceId)) continue;
                        String peerIp = pkt.getAddress() != null ? pkt.getAddress().getHostAddress() : "";
                        int peerPort = obj.optInt("port", DEFAULT_SYNC_PORT);
                        String peerName = obj.optString("name", peerIp);
                        String peerHash = obj.optString("hash", "");
                        boolean isNewPeer = !discoveredPeers.containsKey(peerId);
                        upsertDiscoveredPeer(peerId, peerName, peerIp, peerPort, peerHash);
                        if (isNewPeer && peerIp != null && !peerIp.isEmpty()) {
                            sendUnicastBeaconToIp(peerIp);
                        }
                    } catch (IOException ignored) {
                        pruneAndEmitPeers();
                    } catch (Exception ignored) {
                    }
                }
            });

            // Broadcaster thread
            serverPool.execute(() -> {
                while (running && !ds.isClosed()) {
                    try {
                        sendCurrentBeacon(ds);
                        pruneAndEmitPeers();
                    } catch (Exception ignored) {
                    }
                    try {
                        Thread.sleep(2500);
                    } catch (InterruptedException e) {
                        break;
                    }
                }
            });
        } catch (Exception ignored) {
        }
    }

    private void triggerImmediateBeacon() {
        final DatagramSocket ds = discoverySocket;
        if (!running || ds == null || ds.isClosed()) return;
        serverPool.execute(() -> {
            try {
                sendCurrentBeacon(ds);
            } catch (Exception ignored) {
            }
        });
    }

    private byte[] buildBeaconBytes() throws Exception {
        JSONObject beacon = new JSONObject();
        beacon.put("app", "feiartical");
        beacon.put("v", 1);
        beacon.put("id", instanceId);
        beacon.put("name", activeDeviceName);
        beacon.put("port", activePort);
        beacon.put("hash", activeStateHash != null ? activeStateHash : "");
        return beacon.toString().getBytes(StandardCharsets.UTF_8);
    }

    private void sendCurrentBeacon(DatagramSocket ds) throws Exception {
        if (!running || ds == null || ds.isClosed()) return;
        byte[] payload = buildBeaconBytes();

        Set<String> sentTargets = new HashSet<>();
        sendBroadcastPacket(ds, payload, InetAddress.getByName("255.255.255.255"));
        sentTargets.add("255.255.255.255");

        for (InetAddress bcast : resolveSubnetBroadcasts()) {
            String hostAddr = bcast.getHostAddress();
            if (hostAddr != null && sentTargets.add(hostAddr)) {
                sendBroadcastPacket(ds, payload, bcast);
            }
        }

        // Fallback /24 subnet broadcast derived from activeIp in case InterfaceAddress.getBroadcast() returned null
        if (activeIp != null && !activeIp.isEmpty()) {
            int lastDot = activeIp.lastIndexOf('.');
            if (lastDot > 0) {
                String fallbackBcast = activeIp.substring(0, lastDot) + ".255";
                if (sentTargets.add(fallbackBcast)) {
                    try {
                        sendBroadcastPacket(ds, payload, InetAddress.getByName(fallbackBcast));
                    } catch (Exception ignored) {
                    }
                }
            }
        }

        // Direct unicast to currently discovered peers & recently paired LAN IPs (immune to router broadcast filtering)
        for (DiscoveredPeer p : discoveredPeers.values()) {
            if (p.ip != null && !p.ip.isEmpty() && !p.ip.equals(activeIp) && sentTargets.add(p.ip)) {
                try {
                    sendBroadcastPacket(ds, payload, InetAddress.getByName(p.ip));
                } catch (Exception ignored) {
                }
            }
        }
        for (String cachedIp : loadRememberedPeerIps()) {
            if (!cachedIp.equals(activeIp) && sentTargets.add(cachedIp)) {
                try {
                    sendBroadcastPacket(ds, payload, InetAddress.getByName(cachedIp));
                } catch (Exception ignored) {
                }
            }
        }
    }

    private void sendBroadcastPacket(DatagramSocket ds, byte[] data, InetAddress target) {
        try {
            DatagramPacket pkt = new DatagramPacket(data, data.length, target, DISCOVERY_UDP_PORT);
            ds.send(pkt);
        } catch (Exception ignored) {
        }
    }

    private void pruneAndEmitPeers() {
        long now = System.currentTimeMillis();
        boolean removed = discoveredPeers.entrySet().removeIf(e -> now - e.getValue().lastSeenAt > 9000L);
        if (removed) {
            emitPeersToJs();
        }
    }

    private void emitPeersToJs() {
        JSArray arr = new JSArray();
        for (DiscoveredPeer p : discoveredPeers.values()) {
            JSObject obj = new JSObject();
            obj.put("id", p.id);
            obj.put("name", p.name);
            obj.put("ip", p.ip);
            obj.put("port", p.port);
            obj.put("stateHash", p.stateHash);
            arr.put(obj);
        }
        JSObject payload = new JSObject();
        payload.put("peers", arr);
        notifyListeners("wifiPeers", payload);
    }

    private void handleServerConnection(Socket client) {
        try (Socket sock = client) {
            sock.setSoTimeout(35000);
            String remoteIp = sock.getInetAddress() != null ? sock.getInetAddress().getHostAddress() : "unknown";
            InputStream in = new BufferedInputStream(sock.getInputStream());
            OutputStream out = sock.getOutputStream();

            String headerBlock = readHeaderBlock(in);
            if (headerBlock == null || headerBlock.isEmpty()) return;
            String[] lines = headerBlock.split("\\r\\n");
            if (lines.length == 0) return;
            String[] reqParts = lines[0].split(" ");
            if (reqParts.length < 2) return;

            String method = reqParts[0].toUpperCase(Locale.ROOT);
            String path = reqParts[1];
            int qIdx = path.indexOf('?');
            if (qIdx >= 0) path = path.substring(0, qIdx);

            int contentLength = 0;
            String token = "";
            String encImagePathB64 = "";
            for (int i = 1; i < lines.length; i++) {
                int colon = lines[i].indexOf(':');
                if (colon > 0) {
                    String k = lines[i].substring(0, colon).trim().toLowerCase(Locale.ROOT);
                    String v = lines[i].substring(colon + 1).trim();
                    if ("content-length".equals(k)) {
                        try { contentLength = Integer.parseInt(v); } catch (NumberFormatException ignored) {}
                    } else if ("x-wifi-token".equals(k)) {
                        token = v;
                    } else if ("x-image-path".equals(k)) {
                        encImagePathB64 = v;
                    }
                }
            }

            byte[] reqBytes = new byte[0];
            if (contentLength > 0 && contentLength <= MAX_RPC_BODY_BYTES) {
                reqBytes = readExactBytes(in, contentLength);
            }

            if ("GET".equals(method) && "/wifi-sync/challenge".equals(path)) {
                if (isIpLockedOut(remoteIp)) {
                    writeBytesResponse(out, 429, "Too Many Requests", "application/json", "{\\"error\\":\\"locked\\"}".getBytes(StandardCharsets.UTF_8));
                    return;
                }
                String serverNonce = randomHex(16);
                long now = System.currentTimeMillis();
                serverChallenges.entrySet().removeIf(e -> now > e.getValue());
                serverChallenges.put(serverNonce, now + 90_000L);

                JSONObject resp = new JSONObject();
                resp.put("serverNonce", serverNonce);
                resp.put("deviceName", activeDeviceName);
                resp.put("instanceId", instanceId);
                resp.put("protocolVersion", 1);
                writeBytesResponse(out, 200, "OK", "application/json; charset=utf-8", resp.toString().getBytes(StandardCharsets.UTF_8));
                return;
            }

            if ("POST".equals(method) && "/wifi-sync/auth".equals(path)) {
                if (isIpLockedOut(remoteIp)) {
                    writeBytesResponse(out, 429, "Too Many Requests", "application/json", "{\\"error\\":\\"locked\\"}".getBytes(StandardCharsets.UTF_8));
                    return;
                }
                JSONObject reqObj = new JSONObject(new String(reqBytes, StandardCharsets.UTF_8));
                String serverNonce = reqObj.optString("serverNonce", "");
                String clientNonce = reqObj.optString("clientNonce", "");
                String clientProof = reqObj.optString("clientProof", "");

                Long exp = serverChallenges.remove(serverNonce);
                if (exp == null || System.currentTimeMillis() > exp || clientNonce.length() < 16) {
                    writeBytesResponse(out, 401, "Unauthorized", "application/json", "{\\"error\\":\\"expired\\"}".getBytes(StandardCharsets.UTF_8));
                    return;
                }

                byte[] authKey = sha256("fei-wifi-auth-v1:" + activePassword);
                String expectedClient = hmacSha256Hex(authKey, "client:" + serverNonce + ":" + clientNonce);
                if (!constantTimeEquals(expectedClient, clientProof.toLowerCase(Locale.ROOT))) {
                    recordFailedAuth(remoteIp);
                    writeBytesResponse(out, 401, "Unauthorized", "application/json", "{\\"error\\":\\"invalid_password\\"}".getBytes(StandardCharsets.UTF_8));
                    return;
                }

                failedAuthByIp.remove(remoteIp);
                byte[] sessionKey = hmacSha256Raw(authKey, "session:" + serverNonce + ":" + clientNonce);
                String serverProof = hmacSha256Hex(authKey, "server:" + serverNonce + ":" + clientNonce);
                String newToken = randomHex(24);
                long now = System.currentTimeMillis();
                serverSessions.entrySet().removeIf(e -> now > e.getValue().expiresAt);
                serverSessions.put(newToken, new ServerSession(sessionKey, now + 30L * 60L * 1000L));

                JSONObject resp = new JSONObject();
                resp.put("ok", true);
                resp.put("token", newToken);
                resp.put("serverProof", serverProof);
                resp.put("deviceName", activeDeviceName);
                writeBytesResponse(out, 200, "OK", "application/json; charset=utf-8", resp.toString().getBytes(StandardCharsets.UTF_8));

                JSObject startEvt = new JSObject();
                startEvt.put("status", "start");
                notifyListeners("wifiIncomingSync", startEvt);
                return;
            }

            ServerSession session = serverSessions.get(token);
            if (session == null || System.currentTimeMillis() > session.expiresAt) {
                writeBytesResponse(out, 401, "Unauthorized", "application/json", "{\\"error\\":\\"unauthorized\\"}".getBytes(StandardCharsets.UTF_8));
                return;
            }

            if ("POST".equals(method) && "/wifi-sync/bye".equals(path)) {
                serverSessions.remove(token);
                writeBytesResponse(out, 200, "OK", "application/json; charset=utf-8", "{\\"ok\\":true}".getBytes(StandardCharsets.UTF_8));
                JSObject endEvt = new JSObject();
                endEvt.put("status", "end");
                notifyListeners("wifiIncomingSync", endEvt);
                return;
            }

            if ("POST".equals(method) && "/wifi-sync/rpc".equals(path)) {
                byte[] plainReq = decryptAesGcm(session.sessionKey, reqBytes);
                JSONObject env = new JSONObject(new String(plainReq, StandardCharsets.UTF_8));
                String action = env.optString("action", "");
                String payloadStr = env.optString("payload", "{}");

                String responseJson;
                if ("listImages".equals(action)) {
                    List<LocalStoragePlugin.BinaryFileMeta> list = LocalStoragePlugin.listBinaryFilesSync("images");
                    JSONArray arr = new JSONArray();
                    for (LocalStoragePlugin.BinaryFileMeta m : list) {
                        JSONObject item = new JSONObject();
                        item.put("relPath", m.relPath);
                        item.put("size", m.size);
                        item.put("lastModified", m.lastModified);
                        arr.put(item);
                    }
                    JSONObject r = new JSONObject();
                    r.put("ok", true);
                    r.put("files", arr);
                    responseJson = r.toString();
                } else {
                    String reqId = randomHex(10);
                    PendingJsRequest pending = new PendingJsRequest();
                    pendingJsRequests.put(reqId, pending);

                    JSObject evt = new JSObject();
                    evt.put("reqId", reqId);
                    evt.put("action", action);
                    evt.put("payloadJson", payloadStr);
                    notifyListeners("wifiServerRequest", evt);

                    boolean done = pending.latch.await(30, TimeUnit.SECONDS);
                    pendingJsRequests.remove(reqId);
                    if (!done || !pending.ok) {
                        writeBytesResponse(out, 500, "Server Error", "text/plain", "js_timeout".getBytes(StandardCharsets.UTF_8));
                        return;
                    }
                    responseJson = pending.payloadJson;
                }

                byte[] encResp = encryptAesGcm(session.sessionKey, responseJson.getBytes(StandardCharsets.UTF_8));
                writeBytesResponse(out, 200, "OK", "application/octet-stream", encResp);
                return;
            }

            if ("POST".equals(method) && "/wifi-sync/image/get".equals(path)) {
                byte[] plainPath = decryptAesGcm(session.sessionKey, reqBytes);
                String relPath = new String(plainPath, StandardCharsets.UTF_8);
                byte[] imgBytes = LocalStoragePlugin.readBinaryBytesSync(relPath);
                if (imgBytes == null || imgBytes.length == 0) {
                    writeBytesResponse(out, 404, "Not Found", "text/plain", "not_found".getBytes(StandardCharsets.UTF_8));
                    return;
                }
                byte[] encImg = encryptAesGcm(session.sessionKey, imgBytes);
                writeBytesResponse(out, 200, "OK", "application/octet-stream", encImg);
                return;
            }

            if ("POST".equals(method) && "/wifi-sync/image/put".equals(path)) {
                if (encImagePathB64.isEmpty()) {
                    writeBytesResponse(out, 400, "Bad Request", "text/plain", "missing_path".getBytes(StandardCharsets.UTF_8));
                    return;
                }
                byte[] encPathBytes = Base64.decode(encImagePathB64, Base64.DEFAULT);
                String relPath = new String(decryptAesGcm(session.sessionKey, encPathBytes), StandardCharsets.UTF_8);
                byte[] imgBytes = decryptAesGcm(session.sessionKey, reqBytes);
                boolean saved = LocalStoragePlugin.writeBinaryBytesSync(relPath, imgBytes);
                if (!saved) {
                    writeBytesResponse(out, 500, "Server Error", "text/plain", "write_failed".getBytes(StandardCharsets.UTF_8));
                    return;
                }
                JSObject evt = new JSObject();
                evt.put("relPath", relPath);
                notifyListeners("wifiImageReceived", evt);
                byte[] encOk = encryptAesGcm(session.sessionKey, "{\\"ok\\":true}".getBytes(StandardCharsets.UTF_8));
                writeBytesResponse(out, 200, "OK", "application/octet-stream", encOk);
                return;
            }

            writeBytesResponse(out, 404, "Not Found", "text/plain", "not_found".getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {
        }
    }

    private boolean isIpLockedOut(String ip) {
        long[] info = failedAuthByIp.get(ip);
        if (info == null) return false;
        long now = System.currentTimeMillis();
        if (now - info[1] > 60_000L) {
            failedAuthByIp.remove(ip);
            return false;
        }
        return info[0] >= 5L;
    }

    private void recordFailedAuth(String ip) {
        long now = System.currentTimeMillis();
        long[] info = failedAuthByIp.get(ip);
        if (info == null || now - info[1] > 60_000L) {
            failedAuthByIp.put(ip, new long[] { 1L, now });
        } else {
            info[0] += 1L;
            info[1] = now;
        }
    }

    private byte[] encryptAesGcm(byte[] key, byte[] plaintext) throws Exception {
        byte[] iv = new byte[GCM_IV_LEN];
        secureRandom.nextBytes(iv);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(GCM_TAG_BITS, iv));
        byte[] ct = cipher.doFinal(plaintext);
        byte[] out = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, out, 0, iv.length);
        System.arraycopy(ct, 0, out, iv.length, ct.length);
        return out;
    }

    private static byte[] decryptAesGcm(byte[] key, byte[] combined) throws Exception {
        if (combined == null || combined.length <= GCM_IV_LEN) {
            throw new IllegalArgumentException("加密数据包损坏");
        }
        byte[] iv = new byte[GCM_IV_LEN];
        System.arraycopy(combined, 0, iv, 0, GCM_IV_LEN);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(GCM_TAG_BITS, iv));
        return cipher.doFinal(combined, GCM_IV_LEN, combined.length - GCM_IV_LEN);
    }

    private String randomHex(int byteLen) {
        byte[] b = new byte[byteLen];
        secureRandom.nextBytes(b);
        return toHex(b);
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format(Locale.ROOT, "%02x", b & 0xff));
        }
        return sb.toString();
    }

    private static byte[] sha256(String input) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        return md.digest(input.getBytes(StandardCharsets.UTF_8));
    }

    private static byte[] hmacSha256Raw(byte[] key, String message) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(message.getBytes(StandardCharsets.UTF_8));
    }

    private static String hmacSha256Hex(byte[] key, String message) throws Exception {
        return toHex(hmacSha256Raw(key, message));
    }

    private static boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null || a.length() != b.length()) return false;
        int diff = 0;
        for (int i = 0; i < a.length(); i++) {
            diff |= a.charAt(i) ^ b.charAt(i);
        }
        return diff == 0;
    }

    private static String buildDefaultDeviceName() {
        String model = Build.MODEL != null ? Build.MODEL.trim() : "";
        String brand = Build.BRAND != null ? Build.BRAND.trim() : "";
        if (model.isEmpty()) return "Android 设备";
        if (!brand.isEmpty() && !model.toLowerCase(Locale.ROOT).startsWith(brand.toLowerCase(Locale.ROOT))) {
            return brand + " " + model;
        }
        return model;
    }

    private static class HttpResult {
        final int status;
        final byte[] body;

        HttpResult(int status, byte[] body) {
            this.status = status;
            this.body = body;
        }
    }

    private static HttpResult httpRequest(
        String method,
        String host,
        int port,
        String path,
        Map<String, String> headers,
        byte[] body,
        int timeoutMs
    ) throws IOException {
        try (Socket sock = new Socket()) {
            sock.connect(new InetSocketAddress(host, port), timeoutMs);
            sock.setSoTimeout(timeoutMs);
            sock.setTcpNoDelay(true);

            OutputStream os = new BufferedOutputStream(sock.getOutputStream());
            StringBuilder sb = new StringBuilder();
            sb.append(method).append(" ").append(path).append(" HTTP/1.1\\r\\n");
            sb.append("Host: ").append(host).append(":").append(port).append("\\r\\n");
            sb.append("Connection: close\\r\\n");
            if (headers != null) {
                for (Map.Entry<String, String> e : headers.entrySet()) {
                    sb.append(e.getKey()).append(": ").append(e.getValue()).append("\\r\\n");
                }
            }
            int bodyLen = body != null ? body.length : 0;
            if (body != null) {
                sb.append("Content-Length: ").append(bodyLen).append("\\r\\n");
            }
            sb.append("\\r\\n");
            os.write(sb.toString().getBytes(StandardCharsets.UTF_8));
            if (body != null && bodyLen > 0) {
                os.write(body);
            }
            os.flush();

            InputStream in = new BufferedInputStream(sock.getInputStream());
            String headerBlock = readHeaderBlock(in);
            if (headerBlock == null || headerBlock.isEmpty()) {
                throw new IOException("Empty HTTP response");
            }
            String[] lines = headerBlock.split("\\r\\n");
            if (lines.length == 0) {
                throw new IOException("Malformed HTTP status line");
            }
            String[] statusParts = lines[0].split(" ");
            int status = statusParts.length >= 2 ? Integer.parseInt(statusParts[1]) : 500;

            int contentLength = -1;
            for (int i = 1; i < lines.length; i++) {
                int colon = lines[i].indexOf(':');
                if (colon > 0) {
                    String k = lines[i].substring(0, colon).trim().toLowerCase(Locale.ROOT);
                    String v = lines[i].substring(colon + 1).trim();
                    if ("content-length".equals(k)) {
                        try { contentLength = Integer.parseInt(v); } catch (NumberFormatException ignored) {}
                    }
                }
            }

            byte[] respBytes;
            if (contentLength >= 0) {
                respBytes = contentLength > 0 ? readExactBytes(in, contentLength) : new byte[0];
            } else {
                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) != -1) {
                    baos.write(buf, 0, n);
                }
                respBytes = baos.toByteArray();
            }
            return new HttpResult(status, respBytes);
        }
    }

    private static String readHeaderBlock(InputStream in) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        int state = 0;
        int b;
        while ((b = in.read()) != -1) {
            baos.write(b);
            if (baos.size() > 65536) return null;
            if (state == 0 && b == '\\r') state = 1;
            else if (state == 1 && b == '\\n') state = 2;
            else if (state == 2 && b == '\\r') state = 3;
            else if (state == 3 && b == '\\n') break;
            else state = (b == '\\r') ? 1 : 0;
        }
        return baos.toString(StandardCharsets.UTF_8.name());
    }

    private static byte[] readExactBytes(InputStream in, int length) throws IOException {
        byte[] data = new byte[length];
        int offset = 0;
        while (offset < length) {
            int n = in.read(data, offset, length - offset);
            if (n < 0) break;
            offset += n;
        }
        return data;
    }

    private static void writeBytesResponse(OutputStream out, int code, String reason, String contentType, byte[] body)
        throws IOException {
        String headers =
            "HTTP/1.1 " + code + " " + reason + "\\r\\n" +
            "Content-Type: " + contentType + "\\r\\n" +
            "Content-Length: " + body.length + "\\r\\n" +
            "Cache-Control: no-store\\r\\n" +
            "Connection: close\\r\\n\\r\\n";
        out.write(headers.getBytes(StandardCharsets.UTF_8));
        if (body.length > 0) {
            out.write(body);
        }
        out.flush();
    }

    private static String resolveLanIpv4() {
        String fallback = null;
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            if (ifaces == null) return null;
            for (NetworkInterface nif : Collections.list(ifaces)) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                String name = nif.getName().toLowerCase(Locale.ROOT);
                for (InetAddress addr : Collections.list(nif.getInetAddresses())) {
                    if (addr.isLoopbackAddress() || !(addr instanceof Inet4Address)) continue;
                    String ip = addr.getHostAddress();
                    if (ip == null) continue;
                    if (name.startsWith("wlan") || name.startsWith("eth") || name.startsWith("ap")) {
                        return ip;
                    }
                    if (fallback == null) {
                        fallback = ip;
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return fallback;
    }

    private static List<InetAddress> resolveSubnetBroadcasts() {
        java.util.List<InetAddress> result = new java.util.ArrayList<>();
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            if (ifaces == null) return result;
            for (NetworkInterface nif : Collections.list(ifaces)) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (InterfaceAddress ia : nif.getInterfaceAddresses()) {
                    InetAddress bcast = ia.getBroadcast();
                    if (bcast != null && !bcast.isLoopbackAddress()) {
                        result.add(bcast);
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return result;
    }
}
`;

  const lanWebDavKeepAliveServiceJava = `package com.feiartical.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

public class LanWebDavKeepAliveService extends Service {
    private static final String CHANNEL_ID = "feiartical_lan_webdav_channel";
    private static final int NOTIFICATION_ID = 8898;
    public static final String EXTRA_URL = "webdav_url";

    private WifiManager.WifiLock wifiLock;
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                int lockMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                    : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifiLock = wm.createWifiLock(lockMode, "FeiArtical:LanWebDavWifiLock");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        } catch (Exception ignored) {
        }
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FeiArtical:LanWebDavWakeLock");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire(4L * 60L * 60L * 1000L);
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String url = intent != null ? intent.getStringExtra(EXTRA_URL) : null;
        try {
            ensureNotificationChannel();
            Notification notification = buildNotification(url);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception ignored) {
        }
        return START_NOT_STICKY;
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID,
                    "局域网网络磁盘",
                    NotificationManager.IMPORTANCE_LOW
                );
                ch.setDescription("保持局域网 WebDAV 网络磁盘服务稳定在线");
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
        }
    }

    private Notification buildNotification(String url) {
        Intent launch = new Intent(this, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            piFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pi = PendingIntent.getActivity(this, 0, launch, piFlags);

        String contentText = (url != null && !url.isEmpty())
            ? ("网络磁盘运行中：" + url)
            : "局域网网络磁盘运行中";

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);

        builder
            .setContentTitle("飞文局域网网络磁盘")
            .setContentText(contentText)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentIntent(pi)
            .setOngoing(true);

        return builder.build();
    }

    @Override
    public void onDestroy() {
        try {
            if (wifiLock != null && wifiLock.isHeld()) {
                wifiLock.release();
            }
        } catch (Exception ignored) {
        }
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception ignored) {
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
`;

  const lanWebDavPluginJava = `package com.feiartical.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@CapacitorPlugin(name = "LanWebDavNative")
public class LanWebDavPlugin extends Plugin {
    private static final int DEFAULT_PORT = 8898;
    private static final int MAX_PORT_TRIES = 10;
    private static final long MAX_PUT_BYTES = 25L * 1024L * 1024L;
    private static final int SOCKET_TIMEOUT_MS = 30000;
    private static final int MAX_KEEP_ALIVE_REQS = 50;
    private static final long LOCK_TIMEOUT_MS = 10L * 60L * 1000L;
    private static final long WRITE_DEBOUNCE_MS = 1200L;
    private static final long UNLOCK_FLUSH_DELAY_MS = 350L;

    private static final Pattern PROP_TAG_PATTERN = Pattern.compile(
        "<(?:[a-zA-Z0-9_-]+:)?([A-Za-z0-9_-]+)(?:\\\\s[^>]*)?/?>"
    );
    private static final Pattern WIN32_MODIFIED_PATTERN = Pattern.compile(
        "<[^>]*Win32LastModifiedTime[^>]*>([^<]+)</[^>]*Win32LastModifiedTime>",
        Pattern.CASE_INSENSITIVE
    );

    private volatile boolean running = false;
    private volatile ServerSocket serverSocket;
    private volatile int activePort = DEFAULT_PORT;
    private volatile String activeIp = "";
    private volatile String activeBasePath = "dav";
    private volatile String activeUrl = "";

    private final Set<String> hiddenRelPaths = Collections.newSetFromMap(new ConcurrentHashMap<>());
    private final Map<String, LockEntry> activeLocks = new ConcurrentHashMap<>();
    private final AtomicInteger inFlightWrites = new AtomicInteger(0);
    private final AtomicLong lastWriteAt = new AtomicLong(0L);

    private final Object changeBufferLock = new Object();
    private final List<RenamePair> pendingRenames = new ArrayList<>();
    private final Set<String> pendingTouchedPaths = new LinkedHashSet<>();
    private boolean hasPendingMutation = false;

    private ExecutorService acceptExecutor;
    private ExecutorService workerExecutor;
    private ScheduledExecutorService debounceScheduler;
    private ScheduledFuture<?> pendingNotifyFuture;

    private static class LockEntry {
        final String token;
        final String relPath;
        final String owner;
        volatile long expiresAt;

        LockEntry(String token, String relPath, String owner, long expiresAt) {
            this.token = token;
            this.relPath = relPath;
            this.owner = owner;
            this.expiresAt = expiresAt;
        }
    }

    private static class RenamePair {
        final String from;
        final String to;

        RenamePair(String from, String to) {
            this.from = from;
            this.to = to;
        }
    }

    private static class StorageContext {
        final String mode;
        final File pathRoot;
        final String pathRootCanonical;
        final DocumentFile safRoot;

        StorageContext(String mode, File pathRoot, String pathRootCanonical, DocumentFile safRoot) {
            this.mode = mode;
            this.pathRoot = pathRoot;
            this.pathRootCanonical = pathRootCanonical;
            this.safRoot = safRoot;
        }

        boolean isPath() {
            return "path".equals(mode) && pathRoot != null && pathRootCanonical != null;
        }

        boolean isSaf() {
            return "saf".equals(mode) && safRoot != null;
        }
    }

    private static class NodeMeta {
        final String relPath;
        final String name;
        final boolean isDir;
        final long size;
        final long lastModified;

        NodeMeta(String relPath, String name, boolean isDir, long size, long lastModified) {
            this.relPath = relPath;
            this.name = name;
            this.isDir = isDir;
            this.size = size;
            this.lastModified = lastModified;
        }
    }

    @PluginMethod
    public synchronized void start(PluginCall call) {
        int requestedPort = call.getInt("port", DEFAULT_PORT);
        String rawBasePath = call.getString("basePath", "");
        String cleanBase = sanitizeBasePath(rawBasePath);
        if (cleanBase.isEmpty()) {
            JSObject err = new JSObject();
            err.put("ok", false);
            err.put("running", false);
            err.put("error", "自定义路径不能为空");
            call.resolve(err);
            return;
        }

        applyHiddenPathsArray(call.getArray("hiddenPaths"));

        StorageContext ctx = resolveStorageContext();
        if (ctx == null) {
            JSObject err = new JSObject();
            err.put("ok", false);
            err.put("running", false);
            err.put("error", "请先在设置中绑定并授权手机本地文档目录");
            call.resolve(err);
            return;
        }

        String ip = resolveLanIpv4();
        if (ip == null || ip.isEmpty()) {
            JSObject err = new JSObject();
            err.put("ok", false);
            err.put("running", false);
            err.put("error", "未检测到局域网 Wi-Fi 地址，请确认手机已连接 Wi-Fi");
            call.resolve(err);
            return;
        }

        if (running && serverSocket != null && !serverSocket.isClosed() && cleanBase.equals(activeBasePath)) {
            activeIp = ip;
            activeUrl = "http://" + activeIp + ":" + activePort + "/" + activeBasePath + "/";
            JSObject ok = new JSObject();
            ok.put("ok", true);
            ok.put("running", true);
            ok.put("url", activeUrl);
            ok.put("ip", activeIp);
            ok.put("port", activePort);
            ok.put("basePath", activeBasePath);
            call.resolve(ok);
            return;
        }

        stopInternal();

        ServerSocket bound = null;
        int chosenPort = requestedPort;
        for (int i = 0; i < MAX_PORT_TRIES; i++) {
            int candidate = requestedPort + i;
            try {
                ServerSocket ss = new ServerSocket(candidate);
                ss.setReuseAddress(true);
                bound = ss;
                chosenPort = candidate;
                break;
            } catch (IOException ignored) {
            }
        }

        if (bound == null) {
            JSObject err = new JSObject();
            err.put("ok", false);
            err.put("running", false);
            err.put("error", "局域网 WebDAV 端口均被占用，请稍后重试");
            call.resolve(err);
            return;
        }

        this.serverSocket = bound;
        this.activePort = chosenPort;
        this.activeIp = ip;
        this.activeBasePath = cleanBase;
        this.activeUrl = "http://" + activeIp + ":" + activePort + "/" + activeBasePath + "/";
        this.running = true;

        this.acceptExecutor = Executors.newSingleThreadExecutor();
        this.workerExecutor = Executors.newCachedThreadPool();
        this.debounceScheduler = Executors.newSingleThreadScheduledExecutor();

        final ServerSocket ssRef = bound;
        this.acceptExecutor.execute(() -> acceptLoop(ssRef));
        startKeepAliveService(this.activeUrl);

        JSObject ok = new JSObject();
        ok.put("ok", true);
        ok.put("running", true);
        ok.put("url", activeUrl);
        ok.put("ip", activeIp);
        ok.put("port", activePort);
        ok.put("basePath", activeBasePath);
        call.resolve(ok);
    }

    @PluginMethod
    public synchronized void stop(PluginCall call) {
        stopInternal();
        JSObject ok = new JSObject();
        ok.put("ok", true);
        call.resolve(ok);
    }

    @PluginMethod
    public void updateHiddenPaths(PluginCall call) {
        applyHiddenPathsArray(call.getArray("hiddenPaths"));
        JSObject ok = new JSObject();
        ok.put("ok", true);
        call.resolve(ok);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        pruneExpiredLocks();
        JSObject res = new JSObject();
        res.put("running", running);
        res.put("url", running ? activeUrl : "");
        res.put("ip", running ? activeIp : "");
        res.put("port", running ? activePort : 0);
        res.put("basePath", running ? activeBasePath : "");
        res.put("writeBusy", inFlightWrites.get() > 0 || (System.currentTimeMillis() - lastWriteAt.get() < 1600L));
        res.put("lastWriteAt", lastWriteAt.get());
        res.put("activeLocks", activeLocks.size());
        call.resolve(res);
    }

    @Override
    protected void handleOnDestroy() {
        stopInternal();
        super.handleOnDestroy();
    }

    private void applyHiddenPathsArray(JSArray arr) {
        hiddenRelPaths.clear();
        if (arr == null) return;
        for (int i = 0; i < arr.length(); i++) {
            String raw = arr.optString(i, "");
            String norm = normalizeRelPathStrict(raw);
            if (norm != null && !norm.isEmpty()) {
                hiddenRelPaths.add(norm.toLowerCase(Locale.ROOT));
            }
        }
    }

    private synchronized void stopInternal() {
        running = false;
        activeUrl = "";
        activeLocks.clear();
        synchronized (changeBufferLock) {
            if (pendingNotifyFuture != null) {
                pendingNotifyFuture.cancel(false);
                pendingNotifyFuture = null;
            }
            pendingRenames.clear();
            pendingTouchedPaths.clear();
            hasPendingMutation = false;
        }
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
            }
            serverSocket = null;
        }
        if (acceptExecutor != null) {
            acceptExecutor.shutdownNow();
            acceptExecutor = null;
        }
        if (workerExecutor != null) {
            workerExecutor.shutdownNow();
            workerExecutor = null;
        }
        if (debounceScheduler != null) {
            debounceScheduler.shutdownNow();
            debounceScheduler = null;
        }
        stopKeepAliveService();
    }

    private void startKeepAliveService(String url) {
        try {
            Context ctx = getContext();
            if (ctx == null) return;
            Intent intent = new Intent(ctx, LanWebDavKeepAliveService.class);
            intent.putExtra(LanWebDavKeepAliveService.EXTRA_URL, url);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent);
            } else {
                ctx.startService(intent);
            }
        } catch (Exception ignored) {
        }
    }

    private void stopKeepAliveService() {
        try {
            Context ctx = getContext();
            if (ctx == null) return;
            Intent intent = new Intent(ctx, LanWebDavKeepAliveService.class);
            ctx.stopService(intent);
        } catch (Exception ignored) {
        }
    }

    private void acceptLoop(ServerSocket ss) {
        while (running && !ss.isClosed()) {
            try {
                final Socket client = ss.accept();
                if (!running) {
                    closeQuietly(client);
                    break;
                }
                ExecutorService pool = workerExecutor;
                if (pool != null && !pool.isShutdown()) {
                    pool.execute(() -> handleClientConnection(client));
                } else {
                    closeQuietly(client);
                }
            } catch (IOException e) {
                if (!running) break;
            }
        }
    }

    private void handleClientConnection(Socket socket) {
        try {
            socket.setSoTimeout(SOCKET_TIMEOUT_MS);
            socket.setTcpNoDelay(true);

            InetAddress remoteAddr = socket.getInetAddress();
            if (!isAllowedLanAddress(remoteAddr)) {
                OutputStream out = socket.getOutputStream();
                writeSimpleResponse(out, 403, "Forbidden", "LAN only", false, null);
                return;
            }

            BufferedInputStream in = new BufferedInputStream(socket.getInputStream(), 16384);
            OutputStream out = socket.getOutputStream();

            int reqCount = 0;
            while (running && reqCount < MAX_KEEP_ALIVE_REQS) {
                String headerBlock = readHeaderBlock(in);
                if (headerBlock == null || headerBlock.trim().isEmpty()) {
                    break;
                }
                reqCount++;

                String[] lines = headerBlock.split("\\r\\n");
                if (lines.length == 0) break;
                String[] reqParts = lines[0].split(" ");
                if (reqParts.length < 2) {
                    writeSimpleResponse(out, 400, "Bad Request", "Malformed request", false, null);
                    break;
                }

                String method = reqParts[0].trim().toUpperCase(Locale.ROOT);
                String rawTarget = reqParts[1].trim();
                String httpVersion = reqParts.length >= 3 ? reqParts[2].trim().toUpperCase(Locale.ROOT) : "HTTP/1.1";

                Map<String, String> headers = new HashMap<>();
                for (int i = 1; i < lines.length; i++) {
                    int colon = lines[i].indexOf(':');
                    if (colon > 0) {
                        String k = lines[i].substring(0, colon).trim().toLowerCase(Locale.ROOT);
                        String v = lines[i].substring(colon + 1).trim();
                        headers.put(k, v);
                    }
                }

                String connHeader = headers.get("connection");
                boolean keepAlive = "HTTP/1.1".equals(httpVersion)
                    ? (connHeader == null || !connHeader.toLowerCase(Locale.ROOT).contains("close"))
                    : (connHeader != null && connHeader.toLowerCase(Locale.ROOT).contains("keep-alive"));

                String expect = headers.get("expect");
                if (expect != null && expect.toLowerCase(Locale.ROOT).contains("100-continue")) {
                    out.write("HTTP/1.1 100 Continue\\r\\n\\r\\n".getBytes(StandardCharsets.US_ASCII));
                    out.flush();
                }

                boolean canKeepAlive = dispatchRequest(method, rawTarget, headers, in, out, keepAlive);
                if (!canKeepAlive || !keepAlive) {
                    break;
                }
            }
        } catch (SocketTimeoutException ignored) {
        } catch (Exception ignored) {
        } finally {
            closeQuietly(socket);
        }
    }

    private boolean dispatchRequest(
        String method,
        String rawTarget,
        Map<String, String> headers,
        InputStream in,
        OutputStream out,
        boolean keepAlive
    ) throws IOException {
        // Strip scheme/host if absolute-URI was sent
        String pathOnly = rawTarget;
        if (pathOnly.startsWith("http://") || pathOnly.startsWith("https://")) {
            int slashIdx = pathOnly.indexOf('/', pathOnly.indexOf("://") + 3);
            pathOnly = slashIdx >= 0 ? pathOnly.substring(slashIdx) : "/";
        }
        int qIdx = pathOnly.indexOf('?');
        if (qIdx >= 0) {
            pathOnly = pathOnly.substring(0, qIdx);
        }

        // Allow Windows Mini-Redirector root OPTIONS probe without exposing path or listing
        if ("OPTIONS".equals(method) && ("/".equals(pathOnly) || "*".equals(pathOnly))) {
            drainSmallRequestBody(headers, in);
            Map<String, String> extra = new HashMap<>();
            extra.put("DAV", "1, 2");
            extra.put("MS-Author-Via", "DAV");
            extra.put("Allow", "OPTIONS");
            writeBytesResponse(out, 200, "OK", "text/plain; charset=utf-8", new byte[0], keepAlive, extra);
            return true;
        }

        String relPath = extractRelPathFromUrlPath(pathOnly);
        if (relPath == null) {
            boolean drained = drainRequestBodySafely(headers, in);
            writeSimpleResponse(out, 404, "Not Found", "Not Found", keepAlive && drained, null);
            return drained;
        }

        if ("OPTIONS".equals(method)) {
            drainSmallRequestBody(headers, in);
            Map<String, String> extra = new HashMap<>();
            extra.put("DAV", "1, 2");
            extra.put("MS-Author-Via", "DAV");
            extra.put(
                "Allow",
                "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK"
            );
            writeBytesResponse(out, 200, "OK", "text/plain; charset=utf-8", new byte[0], keepAlive, extra);
            return true;
        }

        if (isForbiddenInternalPath(relPath)) {
            boolean drained = drainRequestBodySafely(headers, in);
            writeSimpleResponse(out, 403, "Forbidden", "Forbidden", keepAlive && drained, null);
            return drained;
        }

        if (isExplorerJunkPath(relPath)) {
            boolean drained = drainRequestBodySafely(headers, in);
            int code = ("PUT".equals(method) || "MKCOL".equals(method)) ? 403 : 404;
            String reason = code == 403 ? "Forbidden" : "Not Found";
            writeSimpleResponse(out, code, reason, reason, keepAlive && drained, null);
            return drained;
        }

        StorageContext ctx = resolveStorageContext();
        if (ctx == null) {
            boolean drained = drainRequestBodySafely(headers, in);
            writeSimpleResponse(out, 503, "Service Unavailable", "Local storage not ready", keepAlive && drained, null);
            return drained;
        }

        switch (method) {
            case "PROPFIND":
                return handlePropfind(ctx, relPath, headers, in, out, keepAlive);
            case "GET":
                return handleGetOrHead(ctx, relPath, headers, in, out, keepAlive, false);
            case "HEAD":
                return handleGetOrHead(ctx, relPath, headers, in, out, keepAlive, true);
            case "PUT":
                return handlePut(ctx, relPath, headers, in, out, keepAlive);
            case "MKCOL":
                return handleMkcol(ctx, relPath, headers, in, out, keepAlive);
            case "DELETE":
                return handleDelete(ctx, relPath, headers, in, out, keepAlive);
            case "MOVE":
                return handleMoveOrCopy(ctx, relPath, headers, in, out, keepAlive, true);
            case "COPY":
                return handleMoveOrCopy(ctx, relPath, headers, in, out, keepAlive, false);
            case "LOCK":
                return handleLock(ctx, relPath, headers, in, out, keepAlive);
            case "UNLOCK":
                return handleUnlock(relPath, headers, in, out, keepAlive);
            case "PROPPATCH":
                return handleProppatch(ctx, relPath, headers, in, out, keepAlive);
            default: {
                boolean drained = drainRequestBodySafely(headers, in);
                writeSimpleResponse(out, 405, "Method Not Allowed", "Method Not Allowed", keepAlive && drained, null);
                return drained;
            }
        }
    }

    private boolean handlePropfind(
        StorageContext ctx,
        String relPath,
        Map<String, String> headers,
        InputStream in,
        OutputStream out,
        boolean keepAlive
    ) throws IOException {
        drainSmallRequestBody(headers, in);
        String depthHeader = headers.get("depth");
        int depth = 1;
        if ("0".equals(depthHeader)) {
            depth = 0;
        } else if ("1".equals(depthHeader)) {
            depth = 1;
        } else if ("infinity".equalsIgnoreCase(depthHeader)) {
            depth = 1;
        }

        List<NodeMeta> items = new ArrayList<>();
        LocalStoragePlugin.WORKSPACE_IO_LOCK.readLock().lock();
        try {
            NodeMeta target = statNode(ctx, relPath);
            if (target == null) {
                writeSimpleResponse(out, 404, "Not Found", "Not Found", keepAlive, null);
                return true;
            }
            items.add(target);
            if (target.isDir && depth >= 1) {
                List<NodeMeta> children = listVisibleChildren(ctx, relPath);
                items.addAll(children);
            }
        } finally {
            LocalStoragePlugin.WORKSPACE_IO_LOCK.readLock().unlock();
        }

        pruneExpiredLocks();
        StringBuilder xml = new StringBuilder(1024);
        xml.append("<?xml version=\\"1.0\\" encoding=\\"utf-8\\"?>\\n");
        xml.append("<D:multistatus xmlns:D=\\"DAV:\\">\\n");
        for (NodeMeta node : items) {
            appendPropfindResponse(xml, node);
        }
        xml.append("</D:multistatus>");
        byte[] body = xml.toString().getBytes(StandardCharsets.UTF_8);
        writeBytesResponse(out, 207, "Multi-Status", "application/xml; charset=utf-8", body, keepAlive, null);
        return true;
    }

    private void appendPropfindResponse(StringBuilder xml, NodeMeta node) {
        String href = buildDavHref(node.relPath, node.isDir);
        String displayName = node.relPath.isEmpty() ? activeBasePath : node.name;
        String lastModHttp = formatHttpDate(node.lastModified);
        String creationIso = formatIsoDate(node.lastModified);
        String etag = computeEtag(node);

        xml.append("  <D:response>\\n");
        xml.append("    <D:href>").append(xmlEscape(href)).append("</D:href>\\n");
        xml.append("    <D:propstat>\\n");
        xml.append("      <D:prop>\\n");
        xml.append("        <D:displayname>").append(xmlEscape(displayName)).append("</D:displayname>\\n");
        xml.append("        <D:creationdate>").append(creationIso).append("</D:creationdate>\\n");
        xml.append("        <D:getlastmodified>").append(lastModHttp).append("</D:getlastmodified>\\n");
        xml.append("        <D:getetag>").append(xmlEscape(etag)).append("</D:getetag>\\n");
        if (node.isDir) {
            xml.append("        <D:resourcetype><D:collection/></D:resourcetype>\\n");
        } else {
            xml.append("        <D:resourcetype/>\\n");
            xml.append("        <D:getcontentlength>").append(Math.max(0L, node.size)).append("</D:getcontentlength>\\n");
            xml.append("        <D:getcontenttype>").append(xmlEscape(guessContentType(node.name))).append("</D:getcontenttype>\\n");
        }
        xml.append("        <D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>\\n");

        LockEntry lock = findLockForPath(node.relPath);
        if (lock != null) {
            xml.append("        <D:lockdiscovery>").append(buildActiveLockXml(lock)).append("</D:lockdiscovery>\\n");
        } else {
            xml.append("        <D:lockdiscovery/>\\n");
        }

        xml.append("      </D:prop>\\n");
        xml.append("      <D:status>HTTP/1.1 200 OK</D:status>\\n");
        xml.append("    </D:propstat>\\n");
        xml.append("  </D:response>\\n");
    }

    private boolean handleGetOrHead(
        StorageContext ctx,
        String relPath,
        Map<String, String> headers,
        InputStream in,
        OutputStream out,
        boolean keepAlive,
        boolean headOnly
    ) throws IOException {
        drainSmallRequestBody(headers, in);
        byte[] fileBytes = null;
        NodeMeta meta = null;

        LocalStoragePlugin.WORKSPACE_IO_LOCK.readLock().lock();
        try {
            meta = statNode(ctx, relPath);
            if (meta == null) {
                writeSimpleResponse(out, 404, "Not Found", "Not Found", keepAlive, null);
                return true;
            }
            if (meta.isDir) {
                byte[] html = ("<html><body><h3>FeiArtical LAN WebDAV</h3></body></html>").getBytes(StandardCharsets.UTF_8);
                Map<String, String> extra = new HashMap<>();
                extra.put("Last-Modified", formatHttpDate(meta.lastModified));
                extra.put("ETag", computeEtag(meta));
                writeBytesResponse(
                    out,
                    200,
                    "OK",
                    "text/html; charset=utf-8",
                    headOnly ? new byte[0] : html,
                    keepAlive,
                    extra,
                    html.length
                );
                return true;
            }
            if (!headOnly) {
                fileBytes = readNodeBytes(ctx, relPath);
                if (fileBytes == null) {
                    writeSimpleResponse(out, 404, "Not Found", "Not Found", keepAlive, null);
                    return true;
                }
            }
        } finally {
            LocalStoragePlugin.WORKSPACE_IO_LOCK.readLock().unlock();
        }

        long totalLen = headOnly ? Math.max(0L, meta.size) : fileBytes.length;
        String contentType = guessContentType(meta.name);
        Map<String, String> extra = new HashMap<>();
        extra.put("Accept-Ranges", "bytes");
        extra.put("Last-Modified", formatHttpDate(meta.lastModified));
        extra.put("ETag", computeEtag(meta));

        String rangeHeader = headers.get("range");
        if (!headOnly && rangeHeader != null && rangeHeader.toLowerCase(Locale.ROOT).startsWith("bytes=") && totalLen > 0) {
            long[] range = parseByteRange(rangeHeader.substring(6).trim(), totalLen);
            if (range == null) {
                extra.put("Content-Range", "bytes */" + totalLen);
                writeBytesResponse(out, 416, "Range Not Satisfiable", "text/plain", new byte[0], keepAlive, extra);
                return true;
            }
            int start = (int) range[0];
            int end = (int) range[1];
            int sliceLen = end - start + 1;
            byte[] slice = new byte[sliceLen];
            System.arraycopy(fileBytes, start, slice, 0, sliceLen);
            extra.put("Content-Range", "bytes " + start + "-" + end + "/" + totalLen);
            writeBytesResponse(out, 206, "Partial Content", contentType, slice, keepAlive, extra);
            return true;
        }

        writeBytesResponse(
            out,
            200,
            "OK",
            contentType,
            headOnly ? new byte[0] : fileBytes,
            keepAlive,
            extra,
            totalLen
        );
        return true;
    }

    private boolean handlePut(
        StorageContext ctx,
        String relPath,
        Map<String, String> headers,
        InputStream in,
        OutputStream out,
        boolean keepAlive
    ) throws IOException {
        if (relPath.isEmpty() || getPathDepth(relPath) > 2) {
            boolean drained = drainRequestBodySafely(headers, in);
            writeSimpleResponse(out, 403, "Forbidden", "Only root and single-level folders are supported", keepAlive && drained, null);
            return drained;
        }

        // Stream request body to a temp cache file BEFORE acquiring WORKSPACE_IO_LOCK
        File tempFile = File.createTempFile("fei_dav_put_", ".tmp", getContext().getCacheDir());
        boolean streamOk = false;
        try {
            long written = readRequestBodyToFile(headers, in, tempFile, MAX_PUT_BYTES);
            if (written < 0) {
                writeSimpleResponse(out, 413, "Payload Too Large", "File exceeds 25MB limit", false, null);
                return false;
            }
            streamOk = true;

            onWriteStart();
            boolean existedBefore;
            NodeMeta updatedMeta;
            LocalStoragePlugin.WORKSPACE_IO_LOCK.writeLock().lock();
            try {
                NodeMeta existing = statNode(ctx, relPath);
                if (existing != null && existing.isDir) {
                    writeSimpleResponse(out, 405, "Method Not Allowed", "Cannot overwrite directory", keepAlive, null);
                    return true;
                }
                existedBefore = existing != null;
                boolean ok = writeNodeFromTempFile(ctx, relPath, tempFile);
                if (!ok) {
                    writeSimpleResponse(out, 409, "Conflict", "Parent directory missing or write failed", keepAlive, null);
                    return true;
                }
                updatedMeta = statNode(ctx, relPath);
            } finally {
                LocalStoragePlugin.WORKSPACE_IO_LOCK.writeLock().unlock();
                onWriteFinish(relPath, null);
            }

            Map<String, String> extra = new HashMap<>();
            if (updatedMeta != null) {
                extra.put("ETag", computeEtag(updatedMeta));
                extra.put("Last-Modified", formatHttpDate(updatedMeta.lastModified));
            }
            if (existedBefore) {
                writeBytesResponse(out, 204, "No Content", "text/plain", new byte[0], keepAlive, extra);
            } else {
                writeBytesResponse(out, 201, "Created", "text/plain", new byte[0], keepAlive, extra);
            }
            return true;
        } catch (IOException e) {
            if (!streamOk) return false;
            writeSimpleResponse(out, 500, "Internal Server Error", "Write failed", false, null);
            return false;
        } finally {
            tempFile.delete();
        }
    }

    private boolean handleMkcol(
        StorageContext ctx,
        String relPath,
        Map<String, String> headers,
        InputStream in,
        OutputStream out,
        boolean keepAlive
    ) throws IOException {
        boolean drained = drainRequestBodySafely(headers, in);
        if (relPath.isEmpty() || getPathDepth(relPath) != 1 || LocalStoragePlugin.isReservedMediaDir(relPath)) {
            writeSimpleResponse(out, 403, "Forbidden", "Only single-level folders are supported", keepAlive && drained, null);
            return drained;
        }

        onWriteStart();
        int statusCode = 500;
        LocalStoragePlugin.WORKSPACE_IO_LOCK.writeLock().lock();
        try {
            NodeMeta existing = statNode(ctx, relPath);
            if (existing != null) {
                statusCode = 405;
            } else {
                boolean created = createTopLevelDirectory(ctx, relPath);
                statusCode = created ? 201 : 409;
            }
        } finally {
            LocalStoragePlugin.WORKSPACE_IO_LOCK.writeLock().unlock();
            onWriteFinish(statusCode == 201 ? relPath : null, null);
        }

        if (statusCode == 201) {
            writeBytesResponse(out, 201, "Created", "text/plain", new byte[0], keepAlive && drained, null);
        } else if (statusCode == 405) {
            writeSimpleResponse(out, 405, "Method Not Allowed", "Already exists", keepAlive && drained, null);
        } else {
            writeSimpleResponse(out, 409, "Conflict", "Could not create folder", keepAlive && drained, null);
        }
        return drained;
    }

    private boolean handleDelete(
        StorageContext ctx,
        String relPath,
        Map<String, String> headers,
        InputStream in,
        OutputStream out,
        boolean keepAlive
    ) throws IOException {
        drainSmallRequestBody(headers, in);
        if (relPath.isEmpty()) {
            writeSimpleResponse(out, 403, "Forbidden", "Cannot delete root", keepAlive, null);
            return true;
        }

        onWriteStart();
        int statusCode = 500;
        LocalStoragePlugin.WORKSPACE_IO_LOCK.writeLock().lock();
        try {
            NodeMeta existing = statNode(ctx, relPath);
            if (existing == null) {
                statusCode = 404;
            } else {
                boolean deleted = deleteNodeRecursive(ctx, relPath);
                statusCode = deleted ? 204 : 500;
            }
        } finally {
            LocalStoragePlugin.WORKSPACE_IO_LOCK.writeLock().unlock();
            onWriteFinish(statusCode == 204 ? relPath : null, null);
        }

        if (statusCode == 204) {
            removeLocksForPathPrefix(relPath);
            writeBytesResponse(out, 204, "No Content", "text/plain", new byte[0], keepAlive, null);
        } else if (statusCode == 404) {
            writeSimpleResponse(out, 404, "Not Found", "Not Found", keepAlive, null);
        } else {
            writeSimpleResponse(out, 500, "Internal Server Error", "Delete failed", keepAlive, null);
        }
        return true;
    }

    private boolean handleMoveOrCopy(
        StorageContext ctx,
        String relPath,
        Map<String, String> headers,
        InputStream in,
        OutputStream out,
        boolean keepAlive,
        boolean isMove
    ) throws IOException {
        drainSmallRequestBody(headers, in);
        String destHeader = headers.get("destination");
        if (destHeader == null || destHeader.trim().isEmpty()) {
            writeSimpleResponse(out, 400, "Bad Request", "Missing Destination", keepAlive, null);
            return true;
        }
        String destPathPart = destHeader.trim();
        if (destPathPart.startsWith("http://") || destPathPart.startsWith("https://")) {
            int slashIdx = destPathPart.indexOf('/', destPathPart.indexOf("://") + 3);
            destPathPart = slashIdx >= 0 ? destPathPart.substring(slashIdx) : "/";
        }
        int qIdx = destPathPart.indexOf('?');
        if (qIdx >= 0) {
            destPathPart = destPathPart.substring(0, qIdx);
        }

        String destRel = extractRelPathFromUrlPath(destPathPart);
        if (destRel == null || destRel.isEmpty()) {
            writeSimpleResponse(out, 403, "Forbidden", "Invalid destination", keepAlive, null);
            return true;
        }
        if (isForbiddenInternalPath(destRel) || isExplorerJunkPath(destRel)) {
            writeSimpleResponse(out, 403, "Forbidden", "Destination forbidden", keepAlive, null);
            return true;
        }
        if (relPath.equals(destRel)) {
            writeSimpleResponse(out, 403, "Forbidden", "Source and destination identical", keepAlive, null);
            return true;
        }

        String overwriteHeader = headers.get("overwrite");
        boolean overwrite = overwriteHeader == null || !"F".equalsIgnoreCase(overwriteHeader.trim());

        onWriteStart();
        int statusCode = 500;
        RenamePair renameRecord = null;
        LocalStoragePlugin.WORKSPACE_IO_LOCK.writeLock().lock();
        try {
            NodeMeta srcMeta = statNode(ctx, relPath);
            if (srcMeta == null) {
                statusCode = 404;
            } else if (srcMeta.isDir && getPathDepth(destRel) != 1) {
                statusCode = 403;
            } else if (!srcMeta.isDir && getPathDepth(destRel) > 2) {
                statusCode = 403;
            } else {
                NodeMeta dstMeta = statNode(ctx, destRel);
                if (dstMeta != null && !overwrite) {
                    statusCode = 412;
                } else {
                    boolean existedDst = dstMeta != null;
                    boolean ok = isMove
                        ? moveNode(ctx, relPath, destRel, srcMeta.isDir, existedDst)
                        : copyNode(ctx, relPath, destRel, srcMeta.isDir, existedDst);
                    if (!ok) {
                        statusCode = 409;
                    } else {
                        statusCode = existedDst ? 204 : 201;
                        if (isMove && !isTempFilePath(relPath) && !isTempFilePath(destRel)) {
                            renameRecord = new RenamePair(relPath, destRel);
                        }
                    }
                }
            }
        } finally {
            LocalStoragePlugin.WORKSPACE_IO_LOCK.writeLock().unlock();
            onWriteFinish((statusCode == 201 || statusCode == 204) ? destRel : null, renameRecord);
        }

        if (statusCode == 201) {
            writeBytesResponse(out, 201, "Created", "text/plain", new byte[0], keepAlive, null);
        } else if (statusCode == 204) {
            writeBytesResponse(out, 204, "No Content", "text/plain", new byte[0], keepAlive, null);
        } else if (statusCode == 404) {
            writeSimpleResponse(out, 404, "Not Found", "Not Found", keepAlive, null);
        } else if (statusCode == 412) {
            writeSimpleResponse(out, 412, "Precondition Failed", "Destination exists", keepAlive, null);
        } else if (statusCode == 403) {
            writeSimpleResponse(out, 403, "Forbidden", "Only single-level folders are supported", keepAlive, null);
        } else {
            writeSimpleResponse(out, 409, "Conflict", "Move/Copy failed", keepAlive, null);
        }
        return true;
    }

    private boolean handleLock(
        StorageContext ctx,
        String relPath,
        Map<String, String> headers,
        InputStream in,
        OutputStream out,
        boolean keepAlive
    ) throws IOException {
        String bodyStr = readSmallBodyUtf8(headers, in);
        pruneExpiredLocks();

        String ifHeader = headers.get("if");
        LockEntry entry = null;

        // Lock refresh via If header
        if ((bodyStr == null || bodyStr.trim().isEmpty()) && ifHeader != null) {
            for (LockEntry existing : activeLocks.values()) {
                if (ifHeader.contains(existing.token)) {
                    existing.expiresAt = System.currentTimeMillis() + LOCK_TIMEOUT_MS;
                    entry = existing;
                    break;
                }
            }
        }

        if (entry == null) {
            // RFC 4918: LOCK on unmapped resource creates an empty file
            if (!relPath.isEmpty() && getPathDepth(relPath) <= 2) {
                LocalStoragePlugin.WORKSPACE_IO_LOCK.writeLock().lock();
                try {
                    if (statNode(ctx, relPath) == null) {
                        File emptyTmp = File.createTempFile("fei_dav_lock_", ".tmp", getContext().getCacheDir());
                        try {
                            writeNodeFromTempFile(ctx, relPath, emptyTmp);
                        } finally {
                            emptyTmp.delete();
                        }
                    }
                } finally {
                    LocalStoragePlugin.WORKSPACE_IO_LOCK.writeLock().unlock();
                }
            }

            String token = "opaquelocktoken:" + UUID.randomUUID().toString();
            String owner = extractLockOwner(bodyStr);
            entry = new LockEntry(token, relPath, owner, System.currentTimeMillis() + LOCK_TIMEOUT_MS);
            activeLocks.put(token, entry);
        }

        String xml =
            "<?xml version=\\"1.0\\" encoding=\\"utf-8\\"?>\\n" +
            "<D:prop xmlns:D=\\"DAV:\\">\\n" +
            "  <D:lockdiscovery>" + buildActiveLockXml(entry) + "</D:lockdiscovery>\\n" +
            "</D:prop>";
        Map<String, String> extra = new HashMap<>();
        extra.put("Lock-Token", "<" + entry.token + ">");
        writeBytesResponse(
            out,
            200,
            "OK",
            "application/xml; charset=utf-8",
            xml.getBytes(StandardCharsets.UTF_8),
            keepAlive,
            extra
        );
        return true;
    }

    private boolean handleUnlock(
        String relPath,
        Map<String, String> headers,
        InputStream in,
        OutputStream out,
        boolean keepAlive
    ) throws IOException {
        drainSmallRequestBody(headers, in);
        String lockToken = headers.get("lock-token");
        if (lockToken != null) {
            String cleaned = lockToken.trim();
            if (cleaned.startsWith("<") && cleaned.endsWith(">")) {
                cleaned = cleaned.substring(1, cleaned.length() - 1).trim();
            }
            activeLocks.remove(cleaned);
        }
        scheduleQuickChangeFlushIfDirty();
        writeBytesResponse(out, 204, "No Content", "text/plain", new byte[0], keepAlive, null);
        return true;
    }

    private boolean handleProppatch(
        StorageContext ctx,
        String relPath,
        Map<String, String> headers,
        InputStream in,
        OutputStream out,
        boolean keepAlive
    ) throws IOException {
        String bodyStr = readSmallBodyUtf8(headers, in);

        // Best-effort preserve Windows Win32LastModifiedTime in path mode
        if (ctx.isPath() && bodyStr != null && !bodyStr.isEmpty()) {
            Matcher m = WIN32_MODIFIED_PATTERN.matcher(bodyStr);
            if (m.find()) {
                long ts = parseHttpDateSafe(m.group(1).trim());
                if (ts > 0) {
                    LocalStoragePlugin.WORKSPACE_IO_LOCK.writeLock().lock();
                    try {
                        File f = resolveSafePathFile(ctx, relPath);
                        if (f != null && f.exists()) {
                            f.setLastModified(ts);
                        }
                    } finally {
                        LocalStoragePlugin.WORKSPACE_IO_LOCK.writeLock().unlock();
                    }
                }
            }
        }

        // Echo accepted property names in 207 Multi-Status so Windows Explorer succeeds cleanly
        Set<String> propNames = new LinkedHashSet<>();
        if (bodyStr != null) {
            Matcher tm = PROP_TAG_PATTERN.matcher(bodyStr);
            while (tm.find()) {
                String tag = tm.group(1);
                if (tag == null) continue;
                String lower = tag.toLowerCase(Locale.ROOT);
                if (
                    "propertyupdate".equals(lower) ||
                    "set".equals(lower) ||
                    "remove".equals(lower) ||
                    "prop".equals(lower) ||
                    "xml".equals(lower)
                ) {
                    continue;
                }
                propNames.add(tag);
            }
        }
        if (propNames.isEmpty()) {
            propNames.add("Win32LastModifiedTime");
        }

        String href = buildDavHref(relPath, false);
        StringBuilder xml = new StringBuilder(512);
        xml.append("<?xml version=\\"1.0\\" encoding=\\"utf-8\\"?>\\n");
        xml.append("<D:multistatus xmlns:D=\\"DAV:\\" xmlns:Z=\\"urn:schemas-microsoft-com:\\">\\n");
        xml.append("  <D:response>\\n");
        xml.append("    <D:href>").append(xmlEscape(href)).append("</D:href>\\n");
        xml.append("    <D:propstat>\\n");
        xml.append("      <D:prop>\\n");
        for (String name : propNames) {
            if (name.startsWith("Win32")) {
                xml.append("        <Z:").append(name).append("/>\\n");
            } else {
                xml.append("        <D:").append(name).append("/>\\n");
            }
        }
        xml.append("      </D:prop>\\n");
        xml.append("      <D:status>HTTP/1.1 200 OK</D:status>\\n");
        xml.append("    </D:propstat>\\n");
        xml.append("  </D:response>\\n");
        xml.append("</D:multistatus>");

        writeBytesResponse(
            out,
            207,
            "Multi-Status",
            "application/xml; charset=utf-8",
            xml.toString().getBytes(StandardCharsets.UTF_8),
            keepAlive,
            null
        );
        return true;
    }

    // ==================== Write Activity & Change Debounce ====================

    private void onWriteStart() {
        inFlightWrites.incrementAndGet();
        lastWriteAt.set(System.currentTimeMillis());
        emitActivityEvent(true);
    }

    private void onWriteFinish(String touchedPath, RenamePair rename) {
        int remaining = Math.max(0, inFlightWrites.decrementAndGet());
        lastWriteAt.set(System.currentTimeMillis());

        boolean realMutation = false;
        if (rename != null) {
            realMutation = true;
        } else if (touchedPath != null && !touchedPath.isEmpty() && !isTempFilePath(touchedPath)) {
            realMutation = true;
        }

        if (realMutation) {
            synchronized (changeBufferLock) {
                hasPendingMutation = true;
                if (rename != null) {
                    pendingRenames.add(rename);
                }
                if (touchedPath != null && !touchedPath.isEmpty()) {
                    pendingTouchedPaths.add(touchedPath);
                }
                scheduleDebouncedEmitLocked(WRITE_DEBOUNCE_MS);
            }
        }
        if (remaining == 0) {
            emitActivityEvent(false);
        }
    }

    private void scheduleQuickChangeFlushIfDirty() {
        synchronized (changeBufferLock) {
            if (hasPendingMutation) {
                scheduleDebouncedEmitLocked(UNLOCK_FLUSH_DELAY_MS);
            }
        }
    }

    private void scheduleDebouncedEmitLocked(long delayMs) {
        if (pendingNotifyFuture != null) {
            pendingNotifyFuture.cancel(false);
            pendingNotifyFuture = null;
        }
        ScheduledExecutorService sched = debounceScheduler;
        if (sched == null || sched.isShutdown()) return;
        pendingNotifyFuture = sched.schedule(this::flushPendingChangesEvent, delayMs, TimeUnit.MILLISECONDS);
    }

    private void flushPendingChangesEvent() {
        if (!running) return;
        if (inFlightWrites.get() > 0) {
            synchronized (changeBufferLock) {
                scheduleDebouncedEmitLocked(WRITE_DEBOUNCE_MS);
            }
            return;
        }
        List<RenamePair> renamesCopy;
        List<String> touchedCopy;
        synchronized (changeBufferLock) {
            if (!hasPendingMutation) return;
            renamesCopy = new ArrayList<>(pendingRenames);
            touchedCopy = new ArrayList<>(pendingTouchedPaths);
            pendingRenames.clear();
            pendingTouchedPaths.clear();
            hasPendingMutation = false;
            pendingNotifyFuture = null;
        }

        JSObject payload = new JSObject();
        payload.put("changedAt", System.currentTimeMillis());
        JSArray renamesArr = new JSArray();
        for (RenamePair r : renamesCopy) {
            JSObject obj = new JSObject();
            obj.put("from", r.from);
            obj.put("to", r.to);
            renamesArr.put(obj);
        }
        payload.put("renames", renamesArr);
        JSArray touchedArr = new JSArray();
        for (String p : touchedCopy) {
            touchedArr.put(p);
        }
        payload.put("touchedPaths", touchedArr);
        notifyListeners("webdavChanged", payload);
    }

    private void emitActivityEvent(boolean busy) {
        JSObject payload = new JSObject();
        payload.put("writeBusy", busy);
        payload.put("activeLocks", activeLocks.size());
        payload.put("lastWriteAt", lastWriteAt.get());
        notifyListeners("webdavActivity", payload);
    }

    // ==================== Storage Abstraction (Path + SAF) ====================

    private StorageContext resolveStorageContext() {
        Context ctx = getContext();
        if (ctx == null) return null;
        SharedPreferences prefs = ctx.getSharedPreferences(LocalStoragePlugin.PREFS_NAME, Context.MODE_PRIVATE);
        String mode = prefs.getString(LocalStoragePlugin.KEY_MODE, "");
        String folderPath = prefs.getString(LocalStoragePlugin.KEY_FOLDER_PATH, "");
        String treeUriStr = prefs.getString(LocalStoragePlugin.KEY_TREE_URI, "");

        if ("saf".equals(mode) && treeUriStr != null && !treeUriStr.isEmpty()) {
            try {
                Uri uri = Uri.parse(treeUriStr);
                DocumentFile root = DocumentFile.fromTreeUri(ctx, uri);
                if (root != null && root.exists() && root.canWrite()) {
                    return new StorageContext("saf", null, null, root);
                }
            } catch (Exception ignored) {
            }
            return null;
        }
        if ("path".equals(mode) && folderPath != null && !folderPath.isEmpty()) {
            try {
                File root = resolvePathRoot(folderPath);
                if (!root.exists()) {
                    root.mkdirs();
                }
                if (root.exists() && root.isDirectory()) {
                    return new StorageContext("path", root, root.getCanonicalPath(), null);
                }
            } catch (Exception ignored) {
            }
            return null;
        }
        return null;
    }

    private File resolvePathRoot(String relPath) {
        String clean = normalizeRelPathStrict(relPath);
        if (clean == null || clean.isEmpty()) {
            clean = "Documents/FeiArtical";
        }
        File extRoot = Environment.getExternalStorageDirectory();
        return new File(extRoot, clean);
    }

    private File resolveSafePathFile(StorageContext ctx, String relPath) {
        if (!ctx.isPath()) return null;
        try {
            File target = relPath.isEmpty() ? ctx.pathRoot : new File(ctx.pathRoot, relPath);
            String canonical = target.getCanonicalPath();
            if (
                canonical.equals(ctx.pathRootCanonical) ||
                canonical.startsWith(ctx.pathRootCanonical + File.separator)
            ) {
                return target;
            }
        } catch (IOException ignored) {
        }
        return null;
    }

    private DocumentFile findSafNode(DocumentFile root, String relPath) {
        if (relPath == null || relPath.isEmpty()) return root;
        String[] parts = relPath.split("/");
        DocumentFile current = root;
        for (String seg : parts) {
            if (seg.isEmpty()) continue;
            DocumentFile next = current.findFile(seg);
            if (next == null) return null;
            current = next;
        }
        return current;
    }

    private NodeMeta statNode(StorageContext ctx, String relPath) {
        if (ctx.isPath()) {
            File f = resolveSafePathFile(ctx, relPath);
            if (f == null || !f.exists()) return null;
            long lm = f.lastModified();
            if (lm <= 0) lm = System.currentTimeMillis();
            return new NodeMeta(relPath, relPath.isEmpty() ? activeBasePath : f.getName(), f.isDirectory(), f.isFile() ? f.length() : 0L, lm);
        }
        if (ctx.isSaf()) {
            DocumentFile df = findSafNode(ctx.safRoot, relPath);
            if (df == null || !df.exists()) return null;
            long lm = df.lastModified();
            if (lm <= 0) lm = System.currentTimeMillis();
            String name = relPath.isEmpty() ? activeBasePath : (df.getName() != null ? df.getName() : extractFileName(relPath));
            return new NodeMeta(relPath, name, df.isDirectory(), df.isFile() ? df.length() : 0L, lm);
        }
        return null;
    }

    private List<NodeMeta> listVisibleChildren(StorageContext ctx, String dirRelPath) {
        List<NodeMeta> result = new ArrayList<>();
        if (ctx.isPath()) {
            File dir = resolveSafePathFile(ctx, dirRelPath);
            if (dir == null || !dir.isDirectory()) return result;
            File[] children = dir.listFiles();
            if (children == null) return result;
            for (File child : children) {
                String name = child.getName();
                if (name == null || name.isEmpty()) continue;
                String childRel = dirRelPath.isEmpty() ? name : (dirRelPath + "/" + name);
                if (shouldHideInListing(childRel, name, child.isDirectory())) continue;
                // Do not expose nested folders beyond depth 1
                if (child.isDirectory() && !dirRelPath.isEmpty()) continue;
                long lm = child.lastModified();
                if (lm <= 0) lm = System.currentTimeMillis();
                result.add(new NodeMeta(childRel, name, child.isDirectory(), child.isFile() ? child.length() : 0L, lm));
            }
        } else if (ctx.isSaf()) {
            DocumentFile dir = findSafNode(ctx.safRoot, dirRelPath);
            if (dir == null || !dir.isDirectory()) return result;
            DocumentFile[] children = dir.listFiles();
            if (children == null) return result;
            for (DocumentFile child : children) {
                String name = child.getName();
                if (name == null || name.isEmpty()) continue;
                String childRel = dirRelPath.isEmpty() ? name : (dirRelPath + "/" + name);
                if (shouldHideInListing(childRel, name, child.isDirectory())) continue;
                if (child.isDirectory() && !dirRelPath.isEmpty()) continue;
                long lm = child.lastModified();
                if (lm <= 0) lm = System.currentTimeMillis();
                result.add(new NodeMeta(childRel, name, child.isDirectory(), child.isFile() ? child.length() : 0L, lm));
            }
        }
        return result;
    }

    private byte[] readNodeBytes(StorageContext ctx, String relPath) {
        if (ctx.isPath()) {
            File f = resolveSafePathFile(ctx, relPath);
            if (f == null || !f.isFile()) return null;
            try (InputStream is = new FileInputStream(f)) {
                return readAllBytes(is);
            } catch (IOException e) {
                return null;
            }
        }
        if (ctx.isSaf()) {
            DocumentFile df = findSafNode(ctx.safRoot, relPath);
            if (df == null || !df.isFile()) return null;
            try (InputStream is = getContext().getContentResolver().openInputStream(df.getUri())) {
                if (is == null) return null;
                return readAllBytes(is);
            } catch (Exception e) {
                return null;
            }
        }
        return null;
    }

    private boolean writeNodeFromTempFile(StorageContext ctx, String relPath, File tempFile) {
        if (ctx.isPath()) {
            File target = resolveSafePathFile(ctx, relPath);
            if (target == null) return false;
            File parent = target.getParentFile();
            if (parent == null || !parent.exists() || !parent.isDirectory()) {
                return false;
            }
            try (
                InputStream is = new FileInputStream(tempFile);
                OutputStream os = new FileOutputStream(target, false)
            ) {
                copyStream(is, os);
                os.flush();
                return true;
            } catch (IOException e) {
                return false;
            }
        }
        if (ctx.isSaf()) {
            int slash = relPath.lastIndexOf('/');
            String dirPart = slash >= 0 ? relPath.substring(0, slash) : "";
            String fileName = slash >= 0 ? relPath.substring(slash + 1) : relPath;
            DocumentFile parent = findSafNode(ctx.safRoot, dirPart);
            if (parent == null || !parent.isDirectory()) return false;

            DocumentFile target = parent.findFile(fileName);
            if (target == null) {
                // application/octet-stream preserves exact .md / .txt filename without SAF appending .txt
                target = parent.createFile("application/octet-stream", fileName);
                if (target == null) {
                    target = parent.createFile("text/plain", fileName);
                }
            }
            if (target == null) return false;

            OutputStream os = null;
            try (InputStream is = new FileInputStream(tempFile)) {
                try {
                    os = getContext().getContentResolver().openOutputStream(target.getUri(), "wt");
                } catch (IllegalArgumentException e) {
                    try {
                        os = getContext().getContentResolver().openOutputStream(target.getUri(), "rwt");
                    } catch (IllegalArgumentException e2) {
                        os = getContext().getContentResolver().openOutputStream(target.getUri(), "w");
                    }
                }
                if (os == null) return false;
                copyStream(is, os);
                os.flush();
                return true;
            } catch (Exception e) {
                return false;
            } finally {
                closeQuietly(os);
            }
        }
        return false;
    }

    private boolean createTopLevelDirectory(StorageContext ctx, String dirName) {
        if (ctx.isPath()) {
            File dir = resolveSafePathFile(ctx, dirName);
            if (dir == null) return false;
            return dir.mkdir();
        }
        if (ctx.isSaf()) {
            DocumentFile created = ctx.safRoot.createDirectory(dirName);
            return created != null && created.isDirectory();
        }
        return false;
    }

    private boolean deleteNodeRecursive(StorageContext ctx, String relPath) {
        if (ctx.isPath()) {
            File target = resolveSafePathFile(ctx, relPath);
            if (target == null || !target.exists()) return false;
            return deleteFileRecursive(target);
        }
        if (ctx.isSaf()) {
            DocumentFile target = findSafNode(ctx.safRoot, relPath);
            if (target == null || !target.exists()) return false;
            return target.delete();
        }
        return false;
    }

    private boolean deleteFileRecursive(File f) {
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) {
                for (File c : children) {
                    if (!deleteFileRecursive(c)) return false;
                }
            }
        }
        return f.delete();
    }

    private boolean moveNode(StorageContext ctx, String srcRel, String dstRel, boolean isDir, boolean existedDst) {
        if (ctx.isPath()) {
            File src = resolveSafePathFile(ctx, srcRel);
            File dst = resolveSafePathFile(ctx, dstRel);
            if (src == null || dst == null || !src.exists()) return false;
            File dstParent = dst.getParentFile();
            if (dstParent == null || !dstParent.exists() || !dstParent.isDirectory()) return false;
            if (existedDst && dst.exists()) {
                deleteFileRecursive(dst);
            }
            if (src.renameTo(dst)) return true;
            if (copyFileRecursive(src, dst)) {
                deleteFileRecursive(src);
                return true;
            }
            return false;
        }
        if (ctx.isSaf()) {
            DocumentFile src = findSafNode(ctx.safRoot, srcRel);
            if (src == null || !src.exists()) return false;

            String srcParentRel = extractParentRel(srcRel);
            String dstParentRel = extractParentRel(dstRel);
            String dstName = extractFileName(dstRel);

            if (existedDst) {
                DocumentFile oldDst = findSafNode(ctx.safRoot, dstRel);
                if (oldDst != null) {
                    oldDst.delete();
                }
            }

            // Same-directory rename (works for both files and top-level folders!)
            if (srcParentRel.equals(dstParentRel)) {
                return src.renameTo(dstName);
            }

            // Cross-folder file move: copy bytes then delete source
            if (!isDir) {
                if (!copySafFile(ctx, src, dstRel)) return false;
                src.delete();
                return true;
            }
            return false;
        }
        return false;
    }

    private boolean copyNode(StorageContext ctx, String srcRel, String dstRel, boolean isDir, boolean existedDst) {
        if (ctx.isPath()) {
            File src = resolveSafePathFile(ctx, srcRel);
            File dst = resolveSafePathFile(ctx, dstRel);
            if (src == null || dst == null || !src.exists()) return false;
            File dstParent = dst.getParentFile();
            if (dstParent == null || !dstParent.exists() || !dstParent.isDirectory()) return false;
            if (existedDst && dst.exists()) {
                deleteFileRecursive(dst);
            }
            return copyFileRecursive(src, dst);
        }
        if (ctx.isSaf()) {
            DocumentFile src = findSafNode(ctx.safRoot, srcRel);
            if (src == null || !src.exists()) return false;
            if (existedDst) {
                DocumentFile oldDst = findSafNode(ctx.safRoot, dstRel);
                if (oldDst != null) oldDst.delete();
            }
            if (!isDir) {
                return copySafFile(ctx, src, dstRel);
            }
            DocumentFile newDir = ctx.safRoot.createDirectory(dstRel);
            if (newDir == null) return false;
            DocumentFile[] children = src.listFiles();
            if (children != null) {
                for (DocumentFile c : children) {
                    if (c.isFile() && c.getName() != null) {
                        copySafFile(ctx, c, dstRel + "/" + c.getName());
                    }
                }
            }
            return true;
        }
        return false;
    }

    private boolean copyFileRecursive(File src, File dst) {
        if (src.isDirectory()) {
            if (!dst.exists() && !dst.mkdirs()) return false;
            File[] children = src.listFiles();
            if (children != null) {
                for (File c : children) {
                    if (!copyFileRecursive(c, new File(dst, c.getName()))) return false;
                }
            }
            return true;
        }
        try (
            InputStream is = new FileInputStream(src);
            OutputStream os = new FileOutputStream(dst, false)
        ) {
            copyStream(is, os);
            os.flush();
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    private boolean copySafFile(StorageContext ctx, DocumentFile src, String dstRel) {
        File tmp = null;
        try {
            tmp = File.createTempFile("fei_dav_cp_", ".tmp", getContext().getCacheDir());
            try (
                InputStream is = getContext().getContentResolver().openInputStream(src.getUri());
                OutputStream os = new FileOutputStream(tmp, false)
            ) {
                if (is == null) return false;
                copyStream(is, os);
                os.flush();
            }
            return writeNodeFromTempFile(ctx, dstRel, tmp);
        } catch (Exception e) {
            return false;
        } finally {
            if (tmp != null) tmp.delete();
        }
    }

    // ==================== Path, Filter & Security Helpers ====================

    private String extractRelPathFromUrlPath(String urlPath) {
        if (urlPath == null || !urlPath.startsWith("/")) return null;
        String basePrefix = "/" + activeBasePath;
        String remainder;
        if (urlPath.equals(basePrefix) || urlPath.equals(basePrefix + "/")) {
            remainder = "";
        } else if (urlPath.startsWith(basePrefix + "/")) {
            remainder = urlPath.substring(basePrefix.length() + 1);
        } else {
            return null;
        }
        if (remainder.isEmpty()) return "";
        String[] rawSegments = remainder.split("/");
        StringBuilder sb = new StringBuilder();
        for (String rawSeg : rawSegments) {
            if (rawSeg.isEmpty()) continue;
            String decoded = percentDecodeUtf8(rawSeg);
            if (decoded == null) return null;
            if (
                decoded.isEmpty() ||
                ".".equals(decoded) ||
                "..".equals(decoded) ||
                decoded.indexOf('/') >= 0 ||
                decoded.indexOf('\\\\') >= 0 ||
                decoded.indexOf('\\0') >= 0
            ) {
                return null;
            }
            if (sb.length() > 0) sb.append('/');
            sb.append(decoded);
        }
        return sb.toString();
    }

    private boolean isForbiddenInternalPath(String relPath) {
        if (relPath == null || relPath.isEmpty()) return false;
        String lower = relPath.toLowerCase(Locale.ROOT);
        if (hiddenRelPaths.contains(lower)) return true;
        String firstSeg = relPath.contains("/") ? relPath.substring(0, relPath.indexOf('/')) : relPath;
        if (LocalStoragePlugin.INDEX_FILE_NAME.equalsIgnoreCase(firstSeg)) return true;
        if (LocalStoragePlugin.isReservedMediaDir(firstSeg)) return true;
        return false;
    }

    private boolean isExplorerJunkPath(String relPath) {
        if (relPath == null || relPath.isEmpty()) return false;
        String fileName = extractFileName(relPath).toLowerCase(Locale.ROOT);
        return (
            "desktop.ini".equals(fileName) ||
            "thumbs.db".equals(fileName) ||
            ".ds_store".equals(fileName) ||
            fileName.startsWith("._")
        );
    }

    private boolean isTempFilePath(String relPath) {
        if (relPath == null || relPath.isEmpty()) return false;
        return LocalStoragePlugin.isIgnoredTempFileName(extractFileName(relPath));
    }

    private boolean shouldHideInListing(String childRel, String name, boolean isDir) {
        if (name.startsWith(".")) return true;
        if (isForbiddenInternalPath(childRel)) return true;
        if (isExplorerJunkPath(childRel)) return true;
        if (!isDir && LocalStoragePlugin.isIgnoredTempFileName(name)) return true;
        return false;
    }

    private static int getPathDepth(String relPath) {
        if (relPath == null || relPath.isEmpty()) return 0;
        int depth = 1;
        for (int i = 0; i < relPath.length(); i++) {
            if (relPath.charAt(i) == '/') depth++;
        }
        return depth;
    }

    private static String extractParentRel(String relPath) {
        int slash = relPath.lastIndexOf('/');
        return slash >= 0 ? relPath.substring(0, slash) : "";
    }

    private static String extractFileName(String relPath) {
        int slash = relPath.lastIndexOf('/');
        return slash >= 0 ? relPath.substring(slash + 1) : relPath;
    }

    private static String normalizeRelPathStrict(String raw) {
        if (raw == null) return "";
        String cleaned = raw.replace('\\\\', '/').trim();
        String[] parts = cleaned.split("/");
        StringBuilder sb = new StringBuilder();
        for (String p : parts) {
            String seg = p.trim();
            if (seg.isEmpty() || ".".equals(seg)) continue;
            if ("..".equals(seg)) return null;
            if (sb.length() > 0) sb.append('/');
            sb.append(seg);
        }
        return sb.toString();
    }

    private static String sanitizeBasePath(String raw) {
        if (raw == null) return "";
        String cleaned = raw.trim().replaceAll("^/+|/+$", "");
        cleaned = cleaned.replaceAll("[^a-zA-Z0-9_-]+", "-");
        cleaned = cleaned.replaceAll("-+", "-").replaceAll("^-+|-+$", "");
        if (cleaned.length() > 32) {
            cleaned = cleaned.substring(0, 32);
        }
        return cleaned;
    }

    private static boolean isAllowedLanAddress(InetAddress addr) {
        if (addr == null) return false;
        if (addr.isLoopbackAddress() || addr.isSiteLocalAddress() || addr.isLinkLocalAddress()) {
            return true;
        }
        byte[] raw = addr.getAddress();
        if (raw != null && raw.length == 16) {
            int first = raw[0] & 0xFF;
            if ((first & 0xFE) == 0xFC) return true; // IPv6 ULA fc00::/7
        }
        return false;
    }

    // ==================== Lock & XML Formatting Helpers ====================

    private void pruneExpiredLocks() {
        long now = System.currentTimeMillis();
        for (Map.Entry<String, LockEntry> e : activeLocks.entrySet()) {
            if (e.getValue().expiresAt < now) {
                activeLocks.remove(e.getKey());
            }
        }
    }

    private LockEntry findLockForPath(String relPath) {
        for (LockEntry e : activeLocks.values()) {
            if (relPath.equals(e.relPath)) return e;
        }
        return null;
    }

    private void removeLocksForPathPrefix(String relPath) {
        for (Map.Entry<String, LockEntry> e : activeLocks.entrySet()) {
            String p = e.getValue().relPath;
            if (p.equals(relPath) || p.startsWith(relPath + "/")) {
                activeLocks.remove(e.getKey());
            }
        }
    }

    private String buildActiveLockXml(LockEntry entry) {
        return
            "<D:activelock>" +
            "<D:locktype><D:write/></D:locktype>" +
            "<D:lockscope><D:exclusive/></D:lockscope>" +
            "<D:depth>0</D:depth>" +
            "<D:owner>" + xmlEscape(entry.owner) + "</D:owner>" +
            "<D:timeout>Second-600</D:timeout>" +
            "<D:locktoken><D:href>" + xmlEscape(entry.token) + "</D:href></D:locktoken>" +
            "</D:activelock>";
    }

    private static String extractLockOwner(String body) {
        if (body == null || body.isEmpty()) return "FeiArticalClient";
        int s = body.indexOf("<D:owner>");
        int e = body.indexOf("</D:owner>");
        if (s >= 0 && e > s) {
            String inner = body.substring(s + 9, e).replaceAll("<[^>]+>", "").trim();
            if (!inner.isEmpty()) return inner;
        }
        return "FeiArticalClient";
    }

    private String buildDavHref(String relPath, boolean isDir) {
        StringBuilder sb = new StringBuilder();
        sb.append('/').append(percentEncodeSegment(activeBasePath));
        if (relPath != null && !relPath.isEmpty()) {
            String[] parts = relPath.split("/");
            for (String seg : parts) {
                if (seg.isEmpty()) continue;
                sb.append('/').append(percentEncodeSegment(seg));
            }
        }
        if (isDir) {
            sb.append('/');
        }
        return sb.toString();
    }

    private static String percentEncodeSegment(String seg) {
        byte[] bytes = seg.getBytes(StandardCharsets.UTF_8);
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        final char[] hex = "0123456789ABCDEF".toCharArray();
        for (byte b : bytes) {
            int c = b & 0xFF;
            if (
                (c >= 'a' && c <= 'z') ||
                (c >= 'A' && c <= 'Z') ||
                (c >= '0' && c <= '9') ||
                c == '-' || c == '_' || c == '.' || c == '~'
            ) {
                sb.append((char) c);
            } else {
                sb.append('%');
                sb.append(hex[(c >> 4) & 0x0F]);
                sb.append(hex[c & 0x0F]);
            }
        }
        return sb.toString();
    }

    private static String percentDecodeUtf8(String encoded) {
        ByteArrayOutputStream baos = new ByteArrayOutputStream(encoded.length());
        for (int i = 0; i < encoded.length(); i++) {
            char c = encoded.charAt(i);
            if (c == '%') {
                if (i + 2 >= encoded.length()) return null;
                int hi = Character.digit(encoded.charAt(i + 1), 16);
                int lo = Character.digit(encoded.charAt(i + 2), 16);
                if (hi < 0 || lo < 0) return null;
                baos.write((hi << 4) | lo);
                i += 2;
            } else {
                byte[] utf8 = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
                baos.write(utf8, 0, utf8.length);
            }
        }
        return new String(baos.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String xmlEscape(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '&': sb.append("&amp;"); break;
                case '<': sb.append("&lt;"); break;
                case '>': sb.append("&gt;"); break;
                case '"': sb.append("&quot;"); break;
                case '\\'': sb.append("&apos;"); break;
                default: sb.append(c);
            }
        }
        return sb.toString();
    }

    private static String computeEtag(NodeMeta node) {
        return "\\"" + Long.toHexString(node.size) + "-" + Long.toHexString(node.lastModified) + "\\"";
    }

    private static String formatHttpDate(long millis) {
        SimpleDateFormat sdf = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US);
        sdf.setTimeZone(TimeZone.getTimeZone("GMT"));
        return sdf.format(new Date(millis));
    }

    private static long parseHttpDateSafe(String s) {
        if (s == null || s.isEmpty()) return -1L;
        String[] patterns = new String[] {
            "EEE, dd MMM yyyy HH:mm:ss zzz",
            "EEE, dd MMM yyyy HH:mm:ss 'GMT'",
            "yyyy-MM-dd'T'HH:mm:ss'Z'"
        };
        for (String p : patterns) {
            try {
                SimpleDateFormat sdf = new SimpleDateFormat(p, Locale.US);
                sdf.setTimeZone(TimeZone.getTimeZone("GMT"));
                Date d = sdf.parse(s);
                if (d != null) return d.getTime();
            } catch (Exception ignored) {
            }
        }
        return -1L;
    }

    private static String formatIsoDate(long millis) {
        SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        sdf.setTimeZone(TimeZone.getTimeZone("UTC"));
        return sdf.format(new Date(millis));
    }

    private static String guessContentType(String fileName) {
        String lower = fileName != null ? fileName.toLowerCase(Locale.ROOT) : "";
        if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown; charset=utf-8";
        if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
        if (lower.endsWith(".json")) return "application/json; charset=utf-8";
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html; charset=utf-8";
        if (lower.endsWith(".xml")) return "application/xml; charset=utf-8";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".webp")) return "image/webp";
        return "application/octet-stream";
    }

    private static long[] parseByteRange(String spec, long totalLen) {
        if (spec.contains(",")) return null;
        int dash = spec.indexOf('-');
        if (dash < 0) return null;
        String startStr = spec.substring(0, dash).trim();
        String endStr = spec.substring(dash + 1).trim();
        try {
            long start;
            long end;
            if (startStr.isEmpty()) {
                long suffixLen = Long.parseLong(endStr);
                if (suffixLen <= 0) return null;
                start = Math.max(0L, totalLen - suffixLen);
                end = totalLen - 1;
            } else {
                start = Long.parseLong(startStr);
                end = endStr.isEmpty() ? (totalLen - 1) : Math.min(Long.parseLong(endStr), totalLen - 1);
            }
            if (start < 0 || start > end || start >= totalLen) return null;
            return new long[] { start, end };
        } catch (NumberFormatException e) {
            return null;
        }
    }

    // ==================== HTTP I/O Helpers ====================

    private static String readHeaderBlock(InputStream in) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        int state = 0;
        int b;
        while ((b = in.read()) != -1) {
            baos.write(b);
            if (baos.size() > 65536) return null;
            if (state == 0 && b == '\\r') state = 1;
            else if (state == 1 && b == '\\n') state = 2;
            else if (state == 2 && b == '\\r') state = 3;
            else if (state == 3 && b == '\\n') break;
            else state = (b == '\\r') ? 1 : 0;
        }
        if (baos.size() == 0) return null;
        return baos.toString(StandardCharsets.UTF_8.name());
    }

    private static String readLineAscii(InputStream in) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        int prev = -1;
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\\n') {
                break;
            }
            if (prev == '\\r') {
                baos.write('\\r');
            }
            if (b != '\\r') {
                baos.write(b);
            }
            prev = b;
            if (baos.size() > 8192) throw new IOException("Chunk line too long");
        }
        return baos.toString(StandardCharsets.US_ASCII.name());
    }

    private static long readRequestBodyToFile(
        Map<String, String> headers,
        InputStream in,
        File target,
        long maxBytes
    ) throws IOException {
        String te = headers.get("transfer-encoding");
        boolean isChunked = te != null && te.toLowerCase(Locale.ROOT).contains("chunked");
        long total = 0L;

        try (OutputStream fos = new FileOutputStream(target, false)) {
            if (isChunked) {
                byte[] buf = new byte[16384];
                while (true) {
                    String sizeLine = readLineAscii(in).trim();
                    int semi = sizeLine.indexOf(';');
                    if (semi >= 0) sizeLine = sizeLine.substring(0, semi).trim();
                    if (sizeLine.isEmpty()) continue;
                    int chunkSize;
                    try {
                        chunkSize = Integer.parseInt(sizeLine, 16);
                    } catch (NumberFormatException e) {
                        throw new IOException("Invalid chunk size");
                    }
                    if (chunkSize == 0) {
                        // Consume trailing headers until empty line
                        while (true) {
                            String trailer = readLineAscii(in);
                            if (trailer == null || trailer.isEmpty()) break;
                        }
                        break;
                    }
                    int remaining = chunkSize;
                    while (remaining > 0) {
                        int n = in.read(buf, 0, Math.min(buf.length, remaining));
                        if (n < 0) throw new IOException("Unexpected EOF in chunk");
                        total += n;
                        if (total > maxBytes) return -1L;
                        fos.write(buf, 0, n);
                        remaining -= n;
                    }
                    // Consume CRLF after chunk
                    readLineAscii(in);
                }
            } else {
                long contentLength = parseContentLength(headers);
                if (contentLength > maxBytes) return -1L;
                if (contentLength > 0) {
                    byte[] buf = new byte[16384];
                    long remaining = contentLength;
                    while (remaining > 0) {
                        int n = in.read(buf, 0, (int) Math.min(buf.length, remaining));
                        if (n < 0) throw new IOException("Unexpected EOF");
                        fos.write(buf, 0, n);
                        remaining -= n;
                        total += n;
                    }
                }
            }
            fos.flush();
        }
        return total;
    }

    private static String readSmallBodyUtf8(Map<String, String> headers, InputStream in) throws IOException {
        String te = headers.get("transfer-encoding");
        boolean isChunked = te != null && te.toLowerCase(Locale.ROOT).contains("chunked");
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        if (isChunked) {
            byte[] buf = new byte[4096];
            long total = 0L;
            while (true) {
                String sizeLine = readLineAscii(in).trim();
                int semi = sizeLine.indexOf(';');
                if (semi >= 0) sizeLine = sizeLine.substring(0, semi).trim();
                if (sizeLine.isEmpty()) continue;
                int chunkSize = Integer.parseInt(sizeLine, 16);
                if (chunkSize == 0) {
                    while (true) {
                        String t = readLineAscii(in);
                        if (t == null || t.isEmpty()) break;
                    }
                    break;
                }
                int rem = chunkSize;
                while (rem > 0) {
                    int n = in.read(buf, 0, Math.min(buf.length, rem));
                    if (n < 0) break;
                    if (total < 131072L) {
                        baos.write(buf, 0, n);
                    }
                    total += n;
                    rem -= n;
                }
                readLineAscii(in);
            }
            return baos.toString(StandardCharsets.UTF_8.name());
        }
        long len = parseContentLength(headers);
        if (len <= 0) return "";
        long cap = Math.min(len, 131072L);
        byte[] buf = new byte[4096];
        long rem = len;
        while (rem > 0) {
            int n = in.read(buf, 0, (int) Math.min(buf.length, rem));
            if (n < 0) break;
            if (baos.size() < cap) {
                baos.write(buf, 0, (int) Math.min(n, cap - baos.size()));
            }
            rem -= n;
        }
        return baos.toString(StandardCharsets.UTF_8.name());
    }

    private static void drainSmallRequestBody(Map<String, String> headers, InputStream in) throws IOException {
        readSmallBodyUtf8(headers, in);
    }

    private static boolean drainRequestBodySafely(Map<String, String> headers, InputStream in) {
        try {
            String te = headers.get("transfer-encoding");
            if (te != null && te.toLowerCase(Locale.ROOT).contains("chunked")) {
                return false;
            }
            long len = parseContentLength(headers);
            if (len <= 0) return true;
            if (len > 65536L) return false;
            byte[] buf = new byte[4096];
            long rem = len;
            while (rem > 0) {
                int n = in.read(buf, 0, (int) Math.min(buf.length, rem));
                if (n < 0) return false;
                rem -= n;
            }
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    private static long parseContentLength(Map<String, String> headers) {
        String cl = headers.get("content-length");
        if (cl == null) return 0L;
        try {
            return Long.parseLong(cl.trim());
        } catch (NumberFormatException e) {
            return 0L;
        }
    }

    private static void writeSimpleResponse(
        OutputStream out,
        int code,
        String reason,
        String msg,
        boolean keepAlive,
        Map<String, String> extraHeaders
    ) throws IOException {
        byte[] body = msg != null ? msg.getBytes(StandardCharsets.UTF_8) : new byte[0];
        writeBytesResponse(out, code, reason, "text/plain; charset=utf-8", body, keepAlive, extraHeaders);
    }

    private static void writeBytesResponse(
        OutputStream out,
        int code,
        String reason,
        String contentType,
        byte[] body,
        boolean keepAlive,
        Map<String, String> extraHeaders
    ) throws IOException {
        writeBytesResponse(out, code, reason, contentType, body, keepAlive, extraHeaders, body.length);
    }

    private static void writeBytesResponse(
        OutputStream out,
        int code,
        String reason,
        String contentType,
        byte[] body,
        boolean keepAlive,
        Map<String, String> extraHeaders,
        long contentLengthOverride
    ) throws IOException {
        StringBuilder sb = new StringBuilder(256);
        sb.append("HTTP/1.1 ").append(code).append(' ').append(reason).append("\\r\\n");
        sb.append("Date: ").append(formatHttpDate(System.currentTimeMillis())).append("\\r\\n");
        sb.append("Server: FeiArtical-WebDAV/1.0\\r\\n");
        if (code != 204 && contentType != null) {
            sb.append("Content-Type: ").append(contentType).append("\\r\\n");
        }
        if (code != 204) {
            sb.append("Content-Length: ").append(Math.max(0L, contentLengthOverride)).append("\\r\\n");
        }
        if (extraHeaders != null) {
            for (Map.Entry<String, String> e : extraHeaders.entrySet()) {
                sb.append(e.getKey()).append(": ").append(e.getValue()).append("\\r\\n");
            }
        }
        sb.append("Connection: ").append(keepAlive ? "keep-alive" : "close").append("\\r\\n\\r\\n");
        out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
        if (body != null && body.length > 0 && code != 204) {
            out.write(body);
        }
        out.flush();
    }

    private static void copyStream(InputStream is, OutputStream os) throws IOException {
        byte[] buf = new byte[16384];
        int n;
        while ((n = is.read(buf)) != -1) {
            os.write(buf, 0, n);
        }
    }

    private static byte[] readAllBytes(InputStream is) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = is.read(buf)) != -1) {
            baos.write(buf, 0, n);
        }
        return baos.toByteArray();
    }

    private static void closeQuietly(Socket s) {
        if (s != null) {
            try { s.close(); } catch (IOException ignored) {}
        }
    }

    private static void closeQuietly(OutputStream os) {
        if (os != null) {
            try { os.close(); } catch (IOException ignored) {}
        }
    }

    private static String resolveLanIpv4() {
        String fallback = null;
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            if (ifaces == null) return null;
            for (NetworkInterface nif : Collections.list(ifaces)) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                String name = nif.getName().toLowerCase(Locale.ROOT);
                for (InetAddress addr : Collections.list(nif.getInetAddresses())) {
                    if (addr.isLoopbackAddress() || !(addr instanceof Inet4Address)) continue;
                    String ip = addr.getHostAddress();
                    if (ip == null) continue;
                    if (name.startsWith("wlan") || name.startsWith("eth") || name.startsWith("ap")) {
                        return ip;
                    }
                    if (fallback == null) {
                        fallback = ip;
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return fallback;
    }
}
`;

  fs.writeFileSync(path.join(javaPkgDir, 'WebDavPlugin.java'), webDavPluginJava, 'utf8');
  fs.writeFileSync(path.join(javaPkgDir, 'LanServerPlugin.java'), lanServerPluginJava, 'utf8');
  fs.writeFileSync(path.join(javaPkgDir, 'LanWebDavKeepAliveService.java'), lanWebDavKeepAliveServiceJava, 'utf8');
  fs.writeFileSync(path.join(javaPkgDir, 'LanWebDavPlugin.java'), lanWebDavPluginJava, 'utf8');
  fs.writeFileSync(path.join(javaPkgDir, 'WifiSyncPlugin.java'), wifiSyncPluginJava, 'utf8');
  fs.writeFileSync(path.join(javaPkgDir, 'ReaderNativePlugin.java'), readerNativePluginJava, 'utf8');
  fs.writeFileSync(path.join(javaPkgDir, 'LocalStoragePlugin.java'), localStoragePluginJava, 'utf8');
  fs.writeFileSync(path.join(javaPkgDir, 'MainActivity.java'), mainActivityJava, 'utf8');
  console.log(`Installed native WebDavPlugin, LanServerPlugin, LanWebDavPlugin, WifiSyncPlugin, ReaderNativePlugin, LocalStoragePlugin & MainActivity into ${javaPkgDir}`);
}

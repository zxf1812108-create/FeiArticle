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

// Ensure required network permissions in AndroidManifest.xml (for WebDAV + LAN IP discovery)
const manifestPath = path.join(appDir, 'src', 'main', 'AndroidManifest.xml');
if (fs.existsSync(manifestPath)) {
  let manifest = fs.readFileSync(manifestPath, 'utf8');
  const perms = [
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.ACCESS_WIFI_STATE',
  ];
  for (const perm of perms) {
    if (!manifest.includes(perm)) {
      manifest = manifest.replace(
        /<application\b/,
        `<uses-permission android:name="${perm}" />\n    <application`
      );
    }
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
                    String responseBody = (status == 304 || "HEAD".equals(upperMethod) || response.body() == null)
                        ? ""
                        : response.body().string();
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
import java.util.Collections;
import java.util.Enumeration;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "LanServerNative")
public class LanServerPlugin extends Plugin {

    private final ExecutorService executor = Executors.newCachedThreadPool();
    private volatile ServerSocket serverSocket;
    private volatile boolean running = false;
    private volatile int activePort = 8899;
    private volatile String activeIp = "";
    private volatile String pageHtml = "";
    private volatile String stateJson = "{\\"folders\\":[],\\"docs\\":[]}";

    @PluginMethod
    public void start(PluginCall call) {
        int preferredPort = call.getInt("port", 8899);
        String html = call.getString("html", "");
        String state = call.getString("stateJson", "{\\"folders\\":[],\\"docs\\":[]}");

        this.pageHtml = html != null ? html : "";
        this.stateJson = state != null ? state : "{\\"folders\\":[],\\"docs\\":[]}";

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
        ServerSocket s = serverSocket;
        serverSocket = null;
        if (s != null) {
            try {
                s.close();
            } catch (IOException ignored) {
            }
        }
    }

    private void handleClient(Socket client) {
        try (Socket sock = client) {
            sock.setSoTimeout(15000);
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
                    }
                }
            }

            String requestBody = "";
            if (contentLength > 0 && contentLength <= 20 * 1024 * 1024) {
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

            if ("GET".equals(method) && "/api/state".equals(path)) {
                writeResponse(out, 200, "OK", "application/json; charset=utf-8", stateJson);
                return;
            }

            if ("POST".equals(method) && "/api/action".equals(path)) {
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
            "Access-Control-Allow-Headers: Content-Type\\r\\n" +
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

  const mainActivityJava = `package com.feiartical.app;

import android.content.res.Configuration;
import android.os.Bundle;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WebDavPlugin.class);
        registerPlugin(LanServerPlugin.class);
        super.onCreate(savedInstanceState);
        applySystemBarAndCutoutInsets();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applySystemBarAppearance(newConfig);
    }

    private void applySystemBarAndCutoutInsets() {
        View content = findViewById(android.R.id.content);
        if (content == null) return;
        applySystemBarAppearance(getResources().getConfiguration());
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
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

  fs.writeFileSync(path.join(javaPkgDir, 'WebDavPlugin.java'), webDavPluginJava, 'utf8');
  fs.writeFileSync(path.join(javaPkgDir, 'LanServerPlugin.java'), lanServerPluginJava, 'utf8');
  fs.writeFileSync(path.join(javaPkgDir, 'MainActivity.java'), mainActivityJava, 'utf8');
  console.log(`Installed native WebDavPlugin, LanServerPlugin & cutout-safe MainActivity into ${javaPkgDir}`);
}

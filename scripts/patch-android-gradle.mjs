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
    '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
    '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />',
    '<uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />',
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

  const readerNativePluginJava = `package com.feiartical.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ReaderNative")
public class ReaderNativePlugin extends Plugin {
    private static volatile ReaderNativePlugin activeInstance;
    public static volatile boolean volumeKeyInterceptEnabled = false;

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
        super.handleOnDestroy();
    }

    @PluginMethod
    public void setVolumeKeyIntercept(PluginCall call) {
        volumeKeyInterceptEnabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        call.resolve();
    }

    public static void dispatchVolumeKey(String direction) {
        ReaderNativePlugin instance = activeInstance;
        if (instance == null) return;
        JSObject payload = new JSObject();
        payload.put("direction", direction);
        instance.notifyListeners("volumeKey", payload);
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
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
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
    private static final String PREFS_NAME = "feiartical_local_fs_prefs";
    private static final String KEY_MODE = "mode";
    private static final String KEY_TREE_URI = "tree_uri";
    private static final String KEY_FOLDER_PATH = "folder_path";
    private static final String INDEX_FILE_NAME = ".feiartical-index.json";
    private static final long MAX_SCAN_FILE_BYTES = 15L * 1024L * 1024L;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();

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
            }
        });
    }

    private static String detectDocFormat(String fileName) {
        if (fileName == null || fileName.startsWith(".")) return null;
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
        return "application/octet-stream";
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
        String text = new String(baos.toByteArray(), StandardCharsets.UTF_8);
        if (!text.isEmpty() && text.charAt(0) == '\\uFEFF') {
            return text.substring(1);
        }
        return text;
    }
}
`;

  const mainActivityJava = `package com.feiartical.app;

import android.content.res.Configuration;
import android.os.Bundle;
import android.view.ActionMode;
import android.view.KeyEvent;
import android.view.Menu;
import android.view.MenuInflater;
import android.view.View;
import android.widget.PopupMenu;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
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
        registerPlugin(ReaderNativePlugin.class);
        registerPlugin(LocalStoragePlugin.class);
        super.onCreate(savedInstanceState);
        applySystemBarAndCutoutInsets();
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
        }
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
  fs.writeFileSync(path.join(javaPkgDir, 'ReaderNativePlugin.java'), readerNativePluginJava, 'utf8');
  fs.writeFileSync(path.join(javaPkgDir, 'LocalStoragePlugin.java'), localStoragePluginJava, 'utf8');
  fs.writeFileSync(path.join(javaPkgDir, 'MainActivity.java'), mainActivityJava, 'utf8');
  console.log(`Installed native WebDavPlugin, LanServerPlugin, ReaderNativePlugin, LocalStoragePlugin & MainActivity into ${javaPkgDir}`);
}

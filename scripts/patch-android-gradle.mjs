import fs from 'node:fs';
import path from 'node:path';

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

// Inject native OkHttp WebDavPlugin & register it in MainActivity when patching a real Capacitor android/ project
const appDir = path.dirname(gradlePath);
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

  const mainActivityJava = `package com.feiartical.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WebDavPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`;

  fs.writeFileSync(path.join(javaPkgDir, 'WebDavPlugin.java'), webDavPluginJava, 'utf8');
  fs.writeFileSync(path.join(javaPkgDir, 'MainActivity.java'), mainActivityJava, 'utf8');
  console.log(`Installed native OkHttp WebDavPlugin into ${javaPkgDir}`);
}

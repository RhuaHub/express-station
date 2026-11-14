package com.rhua.expressstation;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 快递驿站 App 外壳。
 *
 * 不直接用 file:// 加载页面（那样会得到不透明来源，摄像头、localStorage、
 * IndexedDB 都会被限制），而是用 shouldInterceptRequest 把
 * https://appassets.androidplatform.net/ 映射到 assets，得到真正的安全上下文。
 *
 * 2.0.2 起：任何启动期异常都不再闪退，而是显示原生诊断屏；崩溃堆栈同时落到
 * 公共「下载/快递驿站」目录（Android 11+ 用户无法直接访问 Android/data）。
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/index.html";
    private static final String TAG = "StationFatal";
    private static final int REQ_FILE = 2001;
    private static final int REQ_CAMERA_PERM = 2002;

    /** attachBaseContext 比 onCreate 更早，供静态崩溃处理器写日志用 */
    private static volatile Context APP_CONTEXT = null;
    private static volatile String LAST_FATAL = null;

    static {
        /* 尽可能早地安装：类加载发生在 Activity 实例化时，早于主题解析与 onCreate */
        final Thread.UncaughtExceptionHandler old = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override public void uncaughtException(Thread t, Throwable e) {
                try {
                    String s = "FATAL thread=" + t.getName() + "\n" + stackOf(e);
                    LAST_FATAL = s;
                    Log.e(TAG, s);
                    staticAppendCrash(s);
                } catch (Throwable ignored) { }
                if (old != null) old.uncaughtException(t, e);
            }
        });
    }

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;
    private long lastBackAt = 0L;
    private boolean fatalShown = false;

    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(base);
        APP_CONTEXT = base;
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        try {
            boot();
        } catch (Throwable t) {
            String s = stackOf(t);
            Log.e(TAG, "onCreate: " + s);
            appendCrash("FATAL onCreate\n" + s);
            showFatal(s, "启动阶段发生异常");
        }
    }

    private void boot() {
        /* 上次崩溃若发生在 10 分钟内，本次启动先显示诊断屏，避免反复闪退看不到原因 */
        String recent = recentFatal();
        if (recent != null && recent.length() > 0) {
            showFatal(recent, "检测到上次崩溃记录");
            return;
        }
        startWebView();
    }

    /* ---------- 崩溃日志：私有 + 公共下载目录双写 ---------- */

    private static String stamp() {
        try {
            return new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA)
                    .format(new java.util.Date());
        } catch (Throwable e) { return "unknown-time"; }
    }

    private static String stackOf(Throwable t) {
        try {
            StringWriter sw = new StringWriter();
            t.printStackTrace(new PrintWriter(sw));
            return sw.toString();
        } catch (Throwable e) { return String.valueOf(t); }
    }

    private static void staticAppendCrash(String line) {
        Context c = APP_CONTEXT;
        if (c == null) return;
        try {
            File d = new File(c.getExternalFilesDir(null), "crash");
            if (!d.exists()) d.mkdirs();
            FileOutputStream os = new FileOutputStream(new File(d, "station-errors.txt"), true);
            os.write((stamp() + " " + line + "\n").getBytes("UTF-8"));
            os.close();
        } catch (Throwable ignored) { }
    }

    private File crashDir() {
        File d = new File(getExternalFilesDir(null), "crash");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private File crashFile() {
        return new File(crashDir(), "station-errors.txt");
    }

    private void appendCrash(String line) {
        try {
            synchronized (MainActivity.class) {
                FileOutputStream os = new FileOutputStream(crashFile(), true);
                os.write((stamp() + " " + line + "\n").getBytes("UTF-8"));
                os.close();
            }
        } catch (Throwable ignored) { }
    }

    /** 崩溃时额外写一份到「下载/快递驿站」，用户用任意文件管理器都能拿到 */
    private void writePublicCrash(String detail) {
        final String name = "驿站助手-崩溃日志-" + stamp().replace(' ', '-').replace(':', '-') + ".txt";
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                cv.put(MediaStore.MediaColumns.MIME_TYPE, "text/plain");
                cv.put(MediaStore.MediaColumns.RELATIVE_PATH,
                        Environment.DIRECTORY_DOWNLOADS + "/快递驿站");
                Uri uri = getContentResolver()
                        .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) return;
                OutputStream os = getContentResolver().openOutputStream(uri);
                if (os == null) return;
                os.write(detail.getBytes("UTF-8"));
                os.close();
            } else {
                File dir = new File(
                        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                        "快递驿站");
                if (!dir.exists() && !dir.mkdirs()) return;
                FileOutputStream os = new FileOutputStream(new File(dir, name));
                os.write(detail.getBytes("UTF-8"));
                os.close();
            }
        } catch (Throwable ignored) { }
    }

    /** 只认最近 10 分钟内的 FATAL；用户点过「仍要进入」会清空日志，不再反复弹 */
    private String recentFatal() {
        try {
            File f = crashFile();
            if (!f.exists() || f.length() < 1) return "";
            byte[] b = new byte[(int) Math.min(65536, f.length())];
            FileInputStream in = new FileInputStream(f);
            int n = in.read(b);
            in.close();
            if (n <= 0) return "";
            String s = new String(b, 0, n, "UTF-8");
            int at = s.lastIndexOf("FATAL");
            if (at < 0) return "";
            int lineStart = s.lastIndexOf('\n', Math.max(0, at - 1)) + 1;
            String head = s.substring(lineStart, Math.min(s.length(), lineStart + 19));
            long when;
            try {
                when = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA)
                        .parse(head).getTime();
            } catch (Throwable e) { return ""; }
            if (System.currentTimeMillis() - when > 10 * 60 * 1000L) return "";
            String tail = s.substring(lineStart);
            return tail.length() > 6000 ? tail.substring(tail.length() - 6000) : tail;
        } catch (Throwable e) { return ""; }
    }

    private void clearCrashLog() {
        try {
            FileOutputStream os = new FileOutputStream(crashFile(), false);
            os.write("".getBytes("UTF-8"));
            os.close();
        } catch (Throwable ignored) { }
    }

    private String readCrashLog() {
        try {
            File f = crashFile();
            if (!f.exists()) return "";
            byte[] b = new byte[(int) Math.min(8000, f.length())];
            FileInputStream in = new FileInputStream(f);
            int n = in.read(b);
            in.close();
            if (n <= 0) return "";
            String s = new String(b, 0, n, "UTF-8");
            return s.length() > 4000 ? s.substring(s.length() - 4000) : s;
        } catch (Throwable e) { return ""; }
    }

    /* ---------- 原生诊断屏：不依赖 WebView，任何崩溃都看得见 ---------- */

    private void showFatal(final String detail, String title) {
        if (fatalShown) return;
        fatalShown = true;
        final String info = "版本 2.0.2 · " + Build.MANUFACTURER + " " + Build.MODEL
                + " · Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")";
        writePublicCrash(info + "\n" + title + "\n\n" + detail);
        try {
            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setBackgroundColor(0xFFFFFDF7);
            box.setPadding(28, 40, 28, 28);

            TextView h = new TextView(this);
            h.setText("驿站助手 · 启动诊断\n" + title);
            h.setTextSize(20);
            h.setTextColor(0xFFB8860B);
            h.setPadding(0, 0, 0, 16);
            box.addView(h);

            TextView tip = new TextView(this);
            tip.setText("没有闪退，程序已停在诊断界面。请截图发给开发者，或点「复制诊断」粘贴发送。\n"
                    + "日志副本在「下载/快递驿站」目录。\n\n" + info);
            tip.setTextSize(14);
            tip.setTextColor(0xFF555555);
            tip.setPadding(0, 0, 0, 16);
            box.addView(tip);

            TextView body = new TextView(this);
            body.setText(detail == null ? "(无堆栈)" : detail);
            body.setTextSize(11);
            body.setTextColor(0xFF222222);
            body.setTextIsSelectable(true);
            body.setBackgroundColor(0xFFF3EFE3);
            body.setPadding(14, 14, 14, 14);
            box.addView(body);

            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setPadding(0, 20, 0, 0);

            Button copy = new Button(this);
            copy.setText("复制诊断");
            copy.setLayoutParams(new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            copy.setOnClickListener(new android.view.View.OnClickListener() {
                @Override public void onClick(android.view.View v) {
                    try {
                        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                        if (cm != null) cm.setPrimaryClip(
                                ClipData.newPlainText("station-crash", info + "\n" + detail));
                        toast("诊断信息已复制，可粘贴发送");
                    } catch (Throwable e) { toast("复制失败，请直接截图"); }
                }
            });
            row.addView(copy);

            Button enter = new Button(this);
            enter.setText("仍要进入");
            enter.setLayoutParams(new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            enter.setOnClickListener(new android.view.View.OnClickListener() {
                @Override public void onClick(android.view.View v) {
                    clearCrashLog();
                    fatalShown = false;
                    try { startWebView(); }
                    catch (Throwable e) {
                        appendCrash("FATAL startWebView\n" + stackOf(e));
                        fatalShown = false;
                        showFatal(stackOf(e), "进入主界面时再次出错");
                    }
                }
            });
            row.addView(enter);
            box.addView(row);

            ScrollView sv = new ScrollView(this);
            sv.addView(box, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            setContentView(sv);
        } catch (Throwable t) {
            Log.e(TAG, "showFatal failed: " + stackOf(t));
            try { toast("启动异常，日志已写入 下载/快递驿站"); } catch (Throwable ignored) { }
        }
    }

    /* ---------- WebView ---------- */

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void startWebView() {
        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.setBackgroundColor(0xFFFFFDF7);
        setContentView(root);

        /* 部分国产 ROM 在 WebView 正在更新 / 被禁用时，构造 WebView 会直接抛异常 */
        WebView created;
        try {
            created = new WebView(this);
        } catch (Throwable t) {
            String s = stackOf(t);
            appendCrash("FATAL WebView 创建失败\n" + s);
            fatalShown = false;
            showFatal(s, "系统 WebView 不可用（可尝试更新 Android System WebView）");
            return;
        }
        web = created;
        web.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(web);

        try {
            WebSettings s = web.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setDatabaseEnabled(true);
            s.setAllowFileAccess(true);
            s.setLoadsImagesAutomatically(true);
            s.setMediaPlaybackRequiresUserGesture(false);
            s.setSupportMultipleWindows(false);
            s.setJavaScriptCanOpenWindowsAutomatically(true);
            s.setUseWideViewPort(true);
            s.setLoadWithOverviewMode(false);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
            }
            s.setUserAgentString(s.getUserAgentString() + " ExpressStationApp/1.0");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                WebView.setWebContentsDebuggingEnabled(true);
            }
        } catch (Throwable t) {
            appendCrash("WebSettings 配置失败 " + t);
        }

        web.addJavascriptInterface(new Bridge(), "StationNative");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener(new android.webkit.DownloadListener() {
            @Override
            public void onDownloadStart(String url, String ua, String disposition, String mime, long len) {
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); }
                catch (Throwable t) { toast("无法用外部应用打开该链接"); }
            }
        });

        /* 始终重新加载：restoreState 在 Activity 重建时会恢复出空白页，且原生桥可能失效 */
        web.loadUrl(START_URL);
    }

    /* ---------- 资源映射：https 域 -> assets ---------- */

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("htm", "text/html");
        MIME.put("css", "text/css");
        MIME.put("js", "application/javascript");
        MIME.put("json", "application/json");
        MIME.put("webmanifest", "application/manifest+json");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("webp", "image/webp");
        MIME.put("svg", "image/svg+xml");
        MIME.put("ico", "image/x-icon");
        MIME.put("woff2", "font/woff2");
        MIME.put("txt", "text/plain");
    }

    private static String mimeOf(String path) {
        int i = path.lastIndexOf('.');
        String ext = i >= 0 ? path.substring(i + 1).toLowerCase(Locale.US) : "";
        String m = MIME.get(ext);
        return m == null ? "application/octet-stream" : m;
    }

    private WebResourceResponse serve(Uri u) {
        String path = "";
        try {
            if (u == null || !HOST.equals(u.getHost())) return null;
            path = u.getPath();
            if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
            if (path.startsWith("/")) path = path.substring(1);
            if (path.contains("..")) return deny(403);
            InputStream in = getAssets().open(path);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-cache");
            return new WebResourceResponse(mimeOf(path), "UTF-8", 200, "OK", headers, in);
        } catch (Throwable t) {
            appendCrash("资源拦截失败 " + path + " : " + t);
            return deny(404);
        }
    }

    private WebResourceResponse deny(int code) {
        return new WebResourceResponse("text/plain", "UTF-8", code,
                code == 403 ? "Forbidden" : "Not Found", null,
                new ByteArrayInputStream(new byte[0]));
    }

    private class Client extends WebViewClient {
        /* API 21+ 走这个重载 */
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            try { return serve(req == null ? null : req.getUrl()); }
            catch (Throwable t) { appendCrash("新资源拦截 " + t); return deny(404); }
        }

        /* Android 5.x 自带 WebView 只回调这个旧重载；不补会所有资源 404、页面全白 */
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
            try { return serve(Uri.parse(url)); }
            catch (Throwable t) { appendCrash("旧资源拦截 " + url + " : " + t); return deny(404); }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (u != null && HOST.equals(u.getHost())) return false;
            try { startActivity(new Intent(Intent.ACTION_VIEW, u)); }
            catch (Throwable ignored) { }
            return true;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            try {
                Uri u = Uri.parse(url);
                if (u != null && HOST.equals(u.getHost())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (Throwable ignored) { }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, int code, String desc, String failingUrl) {
            appendCrash("页面资源错误 " + code + " " + desc + " @ " + failingUrl);
        }
    }

    /* ---------- 权限、文件选择、调试日志 ---------- */

    private class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    boolean wantsVideo = false;
                    for (String res : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)) wantsVideo = true;
                    }
                    if (!wantsVideo) { request.deny(); return; }
                    boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                            || checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
                    if (granted) {
                        try { request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE}); }
                        catch (Throwable t) { appendCrash("grant camera " + t); }
                    } else {
                        pendingPermission = request;
                        try { requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA_PERM); }
                        catch (Throwable t) { pendingPermission = null; appendCrash("request camera " + t); }
                    }
                }
            });
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb,
                                         FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = cb;
            try {
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                List<String> types = new ArrayList<>();
                String[] accept = params != null ? params.getAcceptTypes() : null;
                if (accept != null) {
                    for (String a : accept) {
                        if (a == null) continue;
                        String t = a.trim();
                        if (t.isEmpty() || t.startsWith(".")) continue;
                        if (!types.contains(t)) types.add(t);
                    }
                }
                if (types.isEmpty()) {
                    pick.setType("*/*");
                } else if (types.size() == 1) {
                    pick.setType(types.get(0));
                } else {
                    pick.setType("*/*");
                    pick.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
                }
                if (params != null && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                startActivityForResult(Intent.createChooser(pick, "选择文件"), REQ_FILE);
                return true;
            } catch (Throwable t) {
                fileCallback = null;
                toast("没有可用的文件选择器");
                return false;
            }
        }

        @Override
        public boolean onJsAlert(WebView view, String url, String message, final android.webkit.JsResult result) {
            try {
                new android.app.AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("好", new android.content.DialogInterface.OnClickListener() {
                            @Override public void onClick(android.content.DialogInterface d, int w) { result.confirm(); }
                        })
                        .setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
                            @Override public void onCancel(android.content.DialogInterface d) { result.cancel(); }
                        })
                        .show();
            } catch (Throwable t) {
                appendCrash("onJsAlert " + t);
                try { result.confirm(); } catch (Throwable ignored) { }
            }
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, final android.webkit.JsResult result) {
            try {
                new android.app.AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("确定", new android.content.DialogInterface.OnClickListener() {
                            @Override public void onClick(android.content.DialogInterface d, int w) { result.confirm(); }
                        })
                        .setNegativeButton("取消", new android.content.DialogInterface.OnClickListener() {
                            @Override public void onClick(android.content.DialogInterface d, int w) { result.cancel(); }
                        })
                        .setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
                            @Override public void onCancel(android.content.DialogInterface d) { result.cancel(); }
                        })
                        .show();
            } catch (Throwable t) {
                appendCrash("onJsConfirm " + t);
                try { result.cancel(); } catch (Throwable ignored) { }
            }
            return true;
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            if (m != null && m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                String line = "JS console " + m.message() + " @ " + m.sourceId() + ":" + m.lineNumber();
                Log.e("StationJS", line);
                appendCrash(line);
            }
            return true;
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code == REQ_CAMERA_PERM) {
            boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            if (pendingPermission != null) {
                try {
                    if (ok) pendingPermission.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                    else {
                        pendingPermission.deny();
                        toast("没有相机权限，可用「从相册选择」替代");
                    }
                } catch (Throwable t) { appendCrash("camera result " + t); }
                pendingPermission = null;
            }
        }
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (req != REQ_FILE) return;
        if (fileCallback == null) return;
        List<Uri> out = new ArrayList<>();
        if (result == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                    out.add(data.getClipData().getItemAt(i).getUri());
                }
            } else if (data.getData() != null) {
                out.add(data.getData());
            }
        }
        fileCallback.onReceiveValue(out.isEmpty() ? null : out.toArray(new Uri[0]));
        fileCallback = null;
    }

    /* ---------- 给网页用的原生桥 ---------- */

    private class Bridge {
        @JavascriptInterface
        public String platform() {
            return "android";
        }

        @JavascriptInterface
        public String version() {
            return "2.0.2";
        }

        /** 导出 CSV / JSON：写入系统「下载/快递驿站」 */
        @JavascriptInterface
        public void saveText(final String name, final String content, final String mime) {
            final String safeName = (name == null || name.trim().isEmpty()) ? "export.txt" : name.trim();
            final String type = (mime == null || mime.isEmpty()) ? "text/plain" : mime.split(";")[0];
            new Thread(new Runnable() {
                @Override public void run() {
                    String where;
                    try {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                            ContentValues cv = new ContentValues();
                            cv.put(MediaStore.MediaColumns.DISPLAY_NAME, safeName);
                            cv.put(MediaStore.MediaColumns.MIME_TYPE, type);
                            cv.put(MediaStore.MediaColumns.RELATIVE_PATH,
                                    Environment.DIRECTORY_DOWNLOADS + "/快递驿站");
                            Uri uri = getContentResolver()
                                    .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                            if (uri == null) throw new IllegalStateException("无法创建下载文件");
                            OutputStream os = getContentResolver().openOutputStream(uri);
                            if (os == null) throw new IllegalStateException("无法写入下载文件");
                            os.write(content.getBytes("UTF-8"));
                            os.close();
                            where = "下载/快递驿站/" + safeName;
                        } else {
                            File dir = new File(Environment.getExternalStorageDirectory(),
                                    "Download/快递驿站");
                            if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("目录不可写");
                            File f = new File(dir, safeName);
                            FileOutputStream fos = new FileOutputStream(f);
                            fos.write(content.getBytes("UTF-8"));
                            fos.close();
                            where = f.getAbsolutePath();
                        }
                        final String msg = "已保存到 " + where;
                        runOnUiThread(new Runnable() {
                            @Override public void run() { toast(msg); }
                        });
                    } catch (Throwable t) {
                        final String msg = "保存失败：" + t.getMessage();
                        appendCrash("saveText " + stackOf(t));
                        runOnUiThread(new Runnable() {
                            @Override public void run() { toast(msg); }
                        });
                    }
                }
            }).start();
        }

        @JavascriptInterface
        public void toastMsg(final String msg) {
            toast(msg);
        }

        /** 自检面板里直接显示原生侧记录到的 JS 错误 / 崩溃堆栈 */
        @JavascriptInterface
        public String crashLog() {
            return readCrashLog();
        }

        /** 页面把启动异常同步写到原生日志 */
        @JavascriptInterface
        public void logError(final String msg) {
            appendCrash("JS " + String.valueOf(msg));
        }

        /** 页面自检可确认原生侧最后一次进程内致命异常 */
        @JavascriptInterface
        public String lastFatal() {
            return LAST_FATAL == null ? "" : LAST_FATAL;
        }
    }

    private void toast(String msg) {
        final String text = String.valueOf(msg);
        try {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try { Toast.makeText(MainActivity.this, text, Toast.LENGTH_SHORT).show(); }
                    catch (Throwable t) { appendCrash("toast " + t); }
                }
            });
        } catch (Throwable t) { appendCrash("toast post " + t); }
    }

    /* ---------- 生命周期 ---------- */

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackAt < 2000) {
            super.onBackPressed();
        } else {
            lastBackAt = now;
            toast("再按一次退出");
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            try {
                web.loadUrl("about:blank");
                web.destroy();
            } catch (Throwable t) { appendCrash("destroy webview " + t); }
            web = null;
        }
        super.onDestroy();
    }
}

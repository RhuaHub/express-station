package com.rhua.expressstation;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
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
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 快递驿站 App 外壳。
 *
 * 关键点：不直接用 file:// 加载页面（那样会得到不透明来源，摄像头、localStorage、
 * IndexedDB 都会被限制），而是用 shouldInterceptRequest 把
 * https://appassets.androidplatform.net/ 映射到 assets，得到一个真正的安全上下文。
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/index.html";
    private static final int REQ_FILE = 2001;
    private static final int REQ_CAMERA_PERM = 2002;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;
    private long lastBackAt = 0L;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.setBackgroundColor(0xFFFFFDF7);

        web = new WebView(this);
        web.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(web);
        setContentView(root);

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

        web.addJavascriptInterface(new Bridge(), "StationNative");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener(new android.webkit.DownloadListener() {
            @Override
            public void onDownloadStart(String url, String ua, String disposition, String mime, long len) {
                // 只处理外部链接下载；CSV/JSON 导出走 StationNative.saveText
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception e) {
                    toast("无法用外部应用打开该链接");
                }
            }
        });

        if (saved != null) {
            web.restoreState(saved);
        } else {
            web.loadUrl(START_URL);
        }
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
        String ext = i >= 0 ? path.substring(i + 1).toLowerCase() : "";
        String m = MIME.get(ext);
        return m == null ? "application/octet-stream" : m;
    }

    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (u == null || !HOST.equals(u.getHost())) return null;
            String path = u.getPath();
            if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
            if (path.startsWith("/")) path = path.substring(1);
            if (path.contains("..")) return deny(403);

            try {
                InputStream in = getAssets().open(path);
                Map<String, String> headers = new HashMap<>();
                headers.put("Cache-Control", "no-cache");
                WebResourceResponse r = new WebResourceResponse(mimeOf(path), "UTF-8", 200, "OK", headers, in);
                return r;
            } catch (Exception e) {
                return deny(404);
            }
        }

        private WebResourceResponse deny(int code) {
            return new WebResourceResponse("text/plain", "UTF-8", code,
                    code == 403 ? "Forbidden" : "Not Found", null,
                    new ByteArrayInputStream(new byte[0]));
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (u != null && HOST.equals(u.getHost())) return false;
            // 站外链接交给系统浏览器，避免在 App 内被当成本地页面
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (Exception ignored) { }
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
        }
    }

    /* ---------- 权限、文件选择、调试日志 ---------- */

    private class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    boolean wantsVideo = false;
                    for (String res : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)) wantsVideo = true;
                    }
                    if (!wantsVideo) { request.deny(); return; }
                    /* API 21/22 没有运行时权限，也没有 checkSelfPermission 方法 */
                    boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                            || checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
                    if (granted) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                    } else {
                        pendingPermission = request;
                        requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA_PERM);
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
                /* 按页面声明的 accept 决定类型：照片是 image/*，导入备份是 application/json */
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
            } catch (Exception e) {
                fileCallback = null;
                toast("没有可用的文件选择器");
                return false;
            }
        }

        /* WebView 默认不弹 JS 对话框：不实现的话 window.confirm 会静默返回 false，
           删除包裹、移除照片等二次确认将永远无法通过 */
        @Override
        public boolean onJsAlert(WebView view, String url, String message, final android.webkit.JsResult result) {
            new android.app.AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton("好", new android.content.DialogInterface.OnClickListener() {
                        @Override public void onClick(android.content.DialogInterface d, int w) { result.confirm(); }
                    })
                    .setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
                        @Override public void onCancel(android.content.DialogInterface d) { result.cancel(); }
                    })
                    .show();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, final android.webkit.JsResult result) {
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
            return true;
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            return true;
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code == REQ_CAMERA_PERM) {
            boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            if (pendingPermission != null) {
                if (ok) pendingPermission.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                else {
                    pendingPermission.deny();
                    toast("没有相机权限，可用「从相册选择」替代");
                }
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
            return "1.0.0";
        }

        /** 导出 CSV / JSON：写入系统「下载/快递驿站」，避免 WebView 无法保存 blob 的问题 */
        @JavascriptInterface
        public void saveText(final String name, final String content, final String mime) {
            final String safeName = (name == null || name.trim().isEmpty()) ? "export.txt" : name.trim();
            final String type = (mime == null || mime.isEmpty()) ? "text/plain" : mime.split(";")[0];
            new Thread(new Runnable() {
                @Override
                public void run() {
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
                    } catch (Exception e) {
                        final String msg = "保存失败：" + e.getMessage();
                        runOnUiThread(new Runnable() {
                            @Override public void run() { toast(msg); }
                        });
                    }
                }
            }).start();
        }

        @JavascriptInterface
        public void toastMsg(final String msg) {
            runOnUiThread(new Runnable() {
                @Override public void run() { toast(msg); }
            });
        }
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
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
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}

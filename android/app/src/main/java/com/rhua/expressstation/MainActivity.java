package com.rhua.expressstation;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CallLog;
import android.speech.tts.TextToSpeech;
import android.telephony.SmsManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Log;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
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
import java.util.TimeZone;

import org.json.JSONArray;
import org.json.JSONObject;

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
    /* 主文档也带版本号：老 WebView 会缓存 shouldInterceptRequest 的响应，
       不带版本号时用户覆盖安装后仍可能拿到上一版 index.html（旧 JS 引用），
       表现正是「改了好几版，点出库还是死」。 */
    private static final String START_URL = "https://" + HOST + "/index.html?v=2.3.0";
    private static final String TAG = "StationFatal";
    private static final int REQ_FILE = 2001;
    private static final int REQ_CAMERA_PERM = 2002;
    private static final int REQ_NOTIFY_PERM = 2003;
    private static final String ACTION_SMS_SENT = "com.rhua.expressstation.SMS_SENT";
    private static final String ACTION_SMS_DELIVERED = "com.rhua.expressstation.SMS_DELIVERED";
    private static final String EXTRA_RID = "rid";

    /** attachBaseContext 比 onCreate 更早，供静态崩溃处理器写日志用 */
    private static volatile Context APP_CONTEXT = null;
    private static volatile String LAST_FATAL = null;
    /** 页面每一步都同步过来；崩溃时诊断屏直接显示「最后停在哪个动作」 */
    private static volatile String LAST_STEP = "";

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
    private int renderGoneCount = 0;
    private long renderGoneAt = 0L;
    /** 渲染进程被回收后重建时，尽量回到用户刚才所在的视图，避免看起来像「退回首页」 */
    private String lastHash = "";
    /** 短信发送 / 送达回执接收器；只在 Activity 存活期间动态注册 */
    private BroadcastReceiver smsReceiver = null;
    private TextToSpeech tts = null;
    private long lastPermReqAt = 0L;

    private boolean activityGone() {
        try {
            if (isFinishing()) return true;
            return Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && isDestroyed();
        } catch (Throwable t) { return false; }
    }

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
        registerSmsReceiver();
        startWebView();
    }

    /* ---------- 通知能力：短信回执 / 系统通话记录 ---------- */

    private void registerSmsReceiver() {
        try {
            IntentFilter f = new IntentFilter();
            f.addAction(ACTION_SMS_SENT);
            f.addAction(ACTION_SMS_DELIVERED);
            smsReceiver = new BroadcastReceiver() {
                @Override public void onReceive(Context ctx, Intent it) {
                    try {
                        String rid = it.getStringExtra(EXTRA_RID);
                        if (rid == null || rid.isEmpty()) return;
                        boolean delivered = ACTION_SMS_DELIVERED.equals(it.getAction());
                        int rc = getResultCode();
                        String status = rc == Activity.RESULT_OK
                                ? (delivered ? "delivered" : "sent") : "failed";
                        String detail = rc == Activity.RESULT_OK ? "" : ("短信错误码 " + rc);
                        receipt(rid, status, detail);
                    } catch (Throwable t) { appendCrash("sms receiver " + stackOf(t)); }
                }
            };
            /* Android 13+ 要求显式声明 receiver 是否导出；这里只接收本应用自己发的回执 */
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(smsReceiver, f, Context.RECEIVER_NOT_EXPORTED);
            else registerReceiver(smsReceiver, f);
        } catch (Throwable t) { appendCrash("registerSmsReceiver " + stackOf(t)); }
    }

    /** 原生侧把发送 / 送达结果回写到页面流水，状态不会停留在「已发送」 */
    private void receipt(final String id, final String status, final String detail) {
        evalJs("window.StationNotify&&window.StationNotify.onReceipt(" +
                JSONObject.quote(id) + "," + JSONObject.quote(status) + "," +
                JSONObject.quote(detail) + ")");
    }

    private void evalJs(final String expr) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (web == null) return;
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                        web.evaluateJavascript(expr, null);
                    } else web.loadUrl("javascript:" + expr);
                } catch (Throwable t) { appendCrash("evalJs " + stackOf(t)); }
            }
        });
    }

    private boolean hasPerm(String p) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        try { return checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED; }
        catch (Throwable t) { return false; }
    }

    private void requestNotifyPerms() {
        /* 页面会连续调用 requestSms / requestCall / requestLog，合并成一次弹窗 */
        long t = System.currentTimeMillis();
        if (t - lastPermReqAt < 800L) return;
        lastPermReqAt = t;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) { toast("此系统版本安装时已授予权限"); return; }
        try {
            ArrayList<String> need = new ArrayList<>();
            if (!hasPerm(Manifest.permission.SEND_SMS)) need.add(Manifest.permission.SEND_SMS);
            if (!hasPerm(Manifest.permission.CALL_PHONE)) need.add(Manifest.permission.CALL_PHONE);
            if (!hasPerm(Manifest.permission.READ_CALL_LOG)) need.add(Manifest.permission.READ_CALL_LOG);
            if (need.isEmpty()) { toast("短信 / 电话 / 通话记录权限已全部授予"); return; }
            requestPermissions(need.toArray(new String[0]), REQ_NOTIFY_PERM);
        } catch (Throwable te) { appendCrash("requestNotifyPerms " + stackOf(te)); toast("权限申请失败"); }
    }

    @SuppressWarnings("deprecation")
    private boolean sendSmsNow(String phone, String text, String rid) {
        if (!hasPerm(Manifest.permission.SEND_SMS)) { toast("未授权 SEND_SMS，请在通知中心申请权限"); return false; }
        final String dest = String.valueOf(phone == null ? "" : phone).replaceAll("[^0-9;+,]", "");
        if (dest.isEmpty()) return false;
        final String body = String.valueOf(text == null ? "" : text);
        final String id = String.valueOf(rid == null ? "" : rid);
        try {
            SmsManager sm = SmsManager.getDefault();
            ArrayList<String> parts = sm.divideMessage(body);
            if (parts == null || parts.isEmpty()) return false;
            ArrayList<PendingIntent> sent = new ArrayList<>();
            ArrayList<PendingIntent> delivered = new ArrayList<>();
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
            int seq = 0;
            for (int i = 0; i < parts.size(); i++) {
                seq++;
                Intent si = new Intent(ACTION_SMS_SENT).setPackage(getPackageName()).putExtra(EXTRA_RID, id);
                Intent di = new Intent(ACTION_SMS_DELIVERED).setPackage(getPackageName()).putExtra(EXTRA_RID, id);
                sent.add(PendingIntent.getBroadcast(this, id.hashCode() + seq, si, flags));
                delivered.add(PendingIntent.getBroadcast(this, id.hashCode() + 10000 + seq, di, flags));
            }
            sm.sendMultipartTextMessage(dest, null, parts, sent, delivered);
            appendCrash("SMS submit " + dest + " parts=" + parts.size() + " rid=" + id);
            return true;
        } catch (Throwable t) {
            appendCrash("sendSmsNow " + stackOf(t));
            receipt(id, "failed", String.valueOf(t.getMessage()));
            return false;
        }
    }

    private static String isoOf(long ms) {
        try {
            java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
            f.setTimeZone(TimeZone.getTimeZone("UTC"));
            return f.format(new java.util.Date(ms));
        } catch (Throwable t) { return ""; }
    }

    /** 读取系统通话记录；只在用户主动点「同步」且已授权时调用 */
    private String readSystemCallLog(int limit, boolean missedOnly) {
        JSONArray arr = new JSONArray();
        if (!hasPerm(Manifest.permission.READ_CALL_LOG)) return arr.toString();
        Cursor c = null;
        try {
            String sel = missedOnly ? CallLog.Calls.TYPE + "=" + CallLog.Calls.MISSED_TYPE : null;
            c = getContentResolver().query(CallLog.Calls.CONTENT_URI,
                    new String[]{CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME,
                            CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION},
                    sel, null, CallLog.Calls.DATE + " DESC");
            if (c == null) return arr.toString();
            int iN = c.getColumnIndex(CallLog.Calls.NUMBER);
            int iName = c.getColumnIndex(CallLog.Calls.CACHED_NAME);
            int iT = c.getColumnIndex(CallLog.Calls.TYPE);
            int iD = c.getColumnIndex(CallLog.Calls.DATE);
            int iDur = c.getColumnIndex(CallLog.Calls.DURATION);
            int max = limit <= 0 ? 100 : Math.min(limit, 500);
            while (c.moveToNext() && arr.length() < max) {
                JSONObject o = new JSONObject();
                int type = iT >= 0 ? c.getInt(iT) : 0;
                o.put("phone", iN >= 0 ? String.valueOf(c.getString(iN)) : "");
                o.put("name", iName >= 0 ? String.valueOf(c.getString(iName)) : "");
                o.put("type", type == CallLog.Calls.MISSED_TYPE ? "missed"
                        : (type == CallLog.Calls.INCOMING_TYPE ? "in" : "out"));
                o.put("at", isoOf(iD >= 0 ? c.getLong(iD) : System.currentTimeMillis()));
                o.put("duration", iDur >= 0 ? c.getLong(iDur) : 0L);
                arr.put(o);
            }
        } catch (Throwable t) { appendCrash("readSystemCallLog " + stackOf(t)); }
        finally { if (c != null) { try { c.close(); } catch (Throwable ignored) { } } }
        return arr.toString();
    }

    @SuppressWarnings("deprecation")
    private void speakNow(final String text) {
        if (text == null || text.isEmpty()) return;
        runOnUiThread(new Runnable() {
            @Override public void run() {
                try {
                    if (tts == null) {
                        tts = new TextToSpeech(MainActivity.this, new TextToSpeech.OnInitListener() {
                            @Override public void onInit(int status) {
                                if (status != TextToSpeech.SUCCESS || tts == null) { toast("设备未安装中文语音引擎"); return; }
                                try { tts.setLanguage(Locale.CHINA); } catch (Throwable ignored) { }
                                try { tts.speak(text, TextToSpeech.QUEUE_FLUSH, new HashMap<String, String>()); }
                                catch (Throwable t) { appendCrash("tts speak " + t); }
                            }
                        });
                    } else {
                        tts.speak(text, TextToSpeech.QUEUE_FLUSH, new HashMap<String, String>());
                    }
                } catch (Throwable t) { appendCrash("speakNow " + stackOf(t)); toast("语音播报不可用"); }
            }
        });
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
        /* 关键步骤 / 致命异常立刻镜像一份到公共「下载/快递驿站」：
           Android 11+ 用户进不去 Android/data，私有日志等于拿不到。 */
        if (line != null && (line.startsWith("STEP ") || line.startsWith("FATAL")
                || line.startsWith("JS "))) {
            mirrorPublicLog();
        }
    }

    /** 固定文件名覆盖式写入，避免每次生成一堆 (1)(2) 副本 */
    private void mirrorPublicLog() {
        final String content = readCrashLog();
        if (content == null || content.isEmpty()) return;
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    final String name = "驿站助手-运行日志.txt";
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        try {
                            getContentResolver().delete(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                                    MediaStore.MediaColumns.DISPLAY_NAME + "=?",
                                    new String[]{name});
                        } catch (Throwable ignored) { }
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
                        os.write(content.getBytes("UTF-8"));
                        os.close();
                    } else {
                        File dir = new File(
                                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                                "快递驿站");
                        if (!dir.exists() && !dir.mkdirs()) return;
                        FileOutputStream os = new FileOutputStream(new File(dir, name));
                        os.write(content.getBytes("UTF-8"));
                        os.close();
                    }
                } catch (Throwable ignored) { }
            }
        }).start();
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
        final String info = "版本 2.3.0 · 最后一步：" + (LAST_STEP == null ? "无" : LAST_STEP)
                + "\n" + Build.MANUFACTURER + " " + Build.MODEL
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
        /* 清掉上一次安装留下的资源缓存；clearCache 不动 localStorage / IndexedDB */
        try { web.clearCache(true); } catch (Throwable t) { appendCrash("clearCache " + t); }
        web.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(web);

        try {
            WebSettings s = web.getSettings();
            s.setJavaScriptEnabled(true);
            /* 所有资源只从 assets 拦截现取，绝不复用磁盘缓存 */
            s.setCacheMode(WebSettings.LOAD_NO_CACHE);
            /* 反射调用：compileSdk 34 已移除该 API，但老 WebView 仍需要关掉 AppCache */
            try {
                s.getClass().getMethod("setAppCacheEnabled", boolean.class).invoke(s, false);
            } catch (Throwable ignored) { }
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
        web.addJavascriptInterface(new NotifyBridge(), "StationNotifyNative");
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
        web.loadUrl(START_URL + (lastHash == null ? "" : lastHash));
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
            headers.put("Cache-Control", "no-store, no-cache, must-revalidate");
            headers.put("Pragma", "no-cache");
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
            return openExternal(req == null ? null : req.getUrl());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            try { return openExternal(Uri.parse(url)); }
            catch (Throwable t) { appendCrash("URL 解析失败 " + t); return true; }
        }

        /* 只放行明确的 http/https 外链；hash、相对地址、未知 scheme 一律留在页内，
           避免误起一个外部 Activity 让用户觉得「App 退出」 */
        private boolean openExternal(Uri u) {
            if (u == null || HOST.equals(u.getHost())) return false;
            String scheme = u.getScheme();
            if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); }
                catch (Throwable t) { appendCrash("外链打开失败 " + t); }
            } else if ("tel".equalsIgnoreCase(scheme) || "sms".equalsIgnoreCase(scheme)
                    || "smsto".equalsIgnoreCase(scheme)) {
                /* 通知通道：把 tel: / sms: 交给系统拨号 / 短信应用，由人最后确认 */
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); }
                catch (Throwable t) {
                    appendCrash("系统通知应用打开失败 " + t);
                    toast("没有可用的拨号 / 短信应用");
                }
            } else {
                appendCrash("页内拦截非网页跳转 " + u);
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, int code, String desc, String failingUrl) {
            appendCrash("页面资源错误 " + code + " " + desc + " @ " + failingUrl);
        }

        /* API 26+：渲染进程被系统回收时，默认返回 false 会让系统直接杀掉整个 App，
           表现正是「点登录那一刻退出」。返回 true 由 App 接管：重建 WebView；
           短时间内连续崩溃则停在诊断屏，避免无限重启。 */
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            boolean crashed = detail != null && detail.didCrash();
            appendCrash("FATAL 渲染进程退出 didCrash=" + crashed);
            writePublicCrash("渲染进程退出 didCrash=" + crashed
                    + " · 版本 2.3.0 · Android " + Build.VERSION.SDK_INT);
            /* 2.0.5 起页面不再修改 URL（老 WebView 会把它当导航），
               视图由 StationNative.setView 同步到 lastHash，重建后直接沿用。 */
            appendCrash("STEP 渲染进程退出前所在视图 " + (lastHash == null ? "" : lastHash));
            long now = System.currentTimeMillis();
            if (now - renderGoneAt > 15000) renderGoneCount = 0;
            renderGoneAt = now;
            renderGoneCount++;
            if (web == view) web = null;
            try { if (view != null) { view.removeAllViews(); view.destroy(); } }
            catch (Throwable ignored) { }
            if (renderGoneCount >= 2) {
                fatalShown = false;
                showFatal("WebView 渲染进程在 15 秒内连续退出 " + renderGoneCount + " 次。\n"
                        + "常见原因：页面单帧生成过多 DOM、设备内存紧张。\n"
                        + "2.0.5 已把点出库改成零数据渲染、不再改 URL、并强制绕开 WebView 缓存。请把本屏内容与「下载/快递驿站/驿站助手-运行日志.txt」一并发回。",
                        "渲染进程连续崩溃");
            } else {
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        try { startWebView(); }
                        catch (Throwable t) {
                            appendCrash("FATAL 重建 WebView 失败\n" + stackOf(t));
                            fatalShown = false;
                            showFatal(stackOf(t), "重建 WebView 失败");
                        }
                    }
                });
            }
            return true;
        }
    }

    /* ---------- 权限、文件选择、调试日志 ---------- */

    private class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        if (request == null) return;
                        if (activityGone()) {
                            request.deny();
                            return;
                        }
                        boolean wantsVideo = false;
                        String[] res = request.getResources();
                        if (res != null) {
                            for (String r : res) {
                                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) wantsVideo = true;
                            }
                        }
                        if (!wantsVideo) { request.deny(); return; }
                        boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                                || checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
                        if (granted) {
                            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                        } else {
                            pendingPermission = request;
                            final PermissionRequest waiting = request;
                            /* 部分 ROM 的权限对话框不会回调，WebView 会一直等 grant/deny，
                               进而 ANR 或被系统回收；8 秒后自动拒绝，让用户改用「从相册选」。 */
                            try {
                                new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                                    @Override public void run() {
                                        if (pendingPermission == waiting) {
                                            pendingPermission = null;
                                            try { waiting.deny(); } catch (Throwable ignored) { }
                                            appendCrash("相机权限请求超时，已自动拒绝");
                                        }
                                    }
                                }, 8000L);
                            } catch (Throwable ignored) { }
                            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA_PERM);
                        }
                    } catch (Throwable t) {
                        appendCrash("onPermissionRequest " + stackOf(t));
                        pendingPermission = null;
                        try { if (request != null) request.deny(); } catch (Throwable ignored) { }
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
                            @Override public void onClick(android.content.DialogInterface d, int w) {
                                try { result.confirm(); } catch (Throwable ignored) { }
                            }
                        })
                        .setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
                            @Override public void onCancel(android.content.DialogInterface d) {
                            try { result.cancel(); } catch (Throwable ignored) { }
                        }
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
                            @Override public void onClick(android.content.DialogInterface d, int w) {
                                try { result.confirm(); } catch (Throwable ignored) { }
                            }
                        })
                        .setNegativeButton("取消", new android.content.DialogInterface.OnClickListener() {
                            @Override public void onClick(android.content.DialogInterface d, int w) {
                                try { result.cancel(); } catch (Throwable ignored) { }
                            }
                        })
                        .setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
                            @Override public void onCancel(android.content.DialogInterface d) {
                            try { result.cancel(); } catch (Throwable ignored) { }
                        }
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
            try {
                boolean ok = results != null && results.length > 0
                        && results[0] == PackageManager.PERMISSION_GRANTED;
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
            } catch (Throwable t) {
                appendCrash("onRequestPermissionsResult " + stackOf(t));
                pendingPermission = null;
            }
        } else if (code == REQ_NOTIFY_PERM) {
            String s = "通知权限：短信 " + (hasPerm(Manifest.permission.SEND_SMS) ? "已授权" : "未授权") +
                    " · 电话 " + (hasPerm(Manifest.permission.CALL_PHONE) ? "已授权" : "未授权") +
                    " · 通话记录 " + (hasPerm(Manifest.permission.READ_CALL_LOG) ? "已授权" : "未授权");
            toast(s);
            evalJs("window.StationNotify&&window.StationNotify.render(window.StationApp&&window.StationApp.state&&window.StationApp.state.view||'notify')");
        }
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (req != REQ_FILE) return;
        if (fileCallback == null) return;
        try {
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
            try { fileCallback.onReceiveValue(out.isEmpty() ? null : out.toArray(new Uri[0])); }
            catch (Throwable t) { appendCrash("fileCallback " + t); }
        } catch (Throwable t) {
            appendCrash("onActivityResult " + stackOf(t));
            try { fileCallback.onReceiveValue(null); } catch (Throwable ignored) { }
        } finally {
            fileCallback = null;
        }
    }

    /* ---------- 给网页用的原生桥 ---------- */

    private class Bridge {
        @JavascriptInterface
        public String platform() {
            return "android";
        }

        @JavascriptInterface
        public String version() {
            return "2.3.0";
        }

        /** 页面每做一个关键动作就同步一步，崩溃后能从日志看到最后停在哪 */
        @JavascriptInterface
        public void logStep(final String msg) {
            final String line = String.valueOf(msg);
            LAST_STEP = line;
            appendCrash("STEP " + line);
        }

        /** 页面不写 URL，改由原生记住当前视图，渲染进程重建后恢复 */
        @JavascriptInterface
        public void setView(final String name) {
            try { lastHash = (name == null || name.isEmpty()) ? "" : ("#" + name); }
            catch (Throwable ignored) { }
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

    /** 通知能力桥（JS 侧 window.StationNotifyNative）。
        默认通道是系统意图；只有页面显式切到「本机直发 / 直接拨出」且已授权时才走这里。 */
    private class NotifyBridge {

        @JavascriptInterface public String platform() { return "android"; }
        @JavascriptInterface public boolean smsGranted() { return hasPerm(Manifest.permission.SEND_SMS); }
        @JavascriptInterface public boolean callGranted() { return hasPerm(Manifest.permission.CALL_PHONE); }
        @JavascriptInterface public boolean logGranted() { return hasPerm(Manifest.permission.READ_CALL_LOG); }

        @JavascriptInterface public void requestSms() { requestNotifyPerms(); }
        @JavascriptInterface public void requestCall() { requestNotifyPerms(); }
        @JavascriptInterface public void requestLog() { requestNotifyPerms(); }
        @JavascriptInterface public void requestAll() { requestNotifyPerms(); }

        @JavascriptInterface
        public boolean sendSms(String phone, String text, String id) {
            return sendSmsNow(phone, text, id);
        }

        /** 系统短信应用：一次带入全部收件人，由人在系统里最后点发送 */
        @JavascriptInterface
        public void openSms(String phone, String text) {
            final String num = String.valueOf(phone == null ? "" : phone).replaceAll("[^0-9;+,]", "");
            final String body = String.valueOf(text == null ? "" : text);
            try {
                Intent i = new Intent(Intent.ACTION_SENDTO);
                i.setData(Uri.parse("smsto:" + num));
                i.putExtra("sms_body", body);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
            } catch (Throwable t) {
                appendCrash("openSms ACTION_SENDTO " + stackOf(t));
                try {
                    Intent i2 = new Intent(Intent.ACTION_VIEW, Uri.parse("sms:" + num));
                    i2.putExtra("sms_body", body);
                    i2.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i2);
                } catch (Throwable t2) {
                    appendCrash("openSms ACTION_VIEW " + stackOf(t2));
                    toast("没有可用的短信应用");
                }
            }
        }

        @JavascriptInterface public void dial(String phone) { dialIntent(phone, false); }
        @JavascriptInterface public void call(String phone) { dialIntent(phone, true); }

        @JavascriptInterface public String callLog(int limit) { return readSystemCallLog(limit, false); }
        @JavascriptInterface public String missedCalls(int limit) { return readSystemCallLog(limit, true); }
        @JavascriptInterface public void speak(String text) { speakNow(text); }

        @JavascriptInterface
        public void copyText(String text) {
            try {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("station", String.valueOf(text)));
            } catch (Throwable t) { appendCrash("copyText " + stackOf(t)); }
        }
    }

    private void dialIntent(String phone, boolean direct) {
        final String num = String.valueOf(phone == null ? "" : phone).replaceAll("[^0-9+*#]", "");
        if (num.isEmpty()) { toast("号码为空"); return; }
        boolean useCall = direct;
        if (useCall && !hasPerm(Manifest.permission.CALL_PHONE)) {
            useCall = false;
            toast("未授权 CALL_PHONE，已改用拨号盘");
        }
        try {
            Intent i = new Intent(useCall ? Intent.ACTION_CALL : Intent.ACTION_DIAL, Uri.parse("tel:" + num));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Throwable t) {
            appendCrash("dialIntent " + stackOf(t));
            toast("没有可用的拨号应用");
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
        if (smsReceiver != null) {
            try { unregisterReceiver(smsReceiver); } catch (Throwable ignored) { }
            smsReceiver = null;
        }
        if (tts != null) {
            try { tts.shutdown(); } catch (Throwable ignored) { }
            tts = null;
        }
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

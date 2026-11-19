package app.ultron.mobile;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Saves files into the phone's public Downloads folder, in chunks so large files never sit in memory.
 * It writes through MediaStore, which on Android 10+ needs no storage permission, so the app declares none (the release
 * build forbids broad storage permissions). Older Android falls back to the share sheet in the web layer. The app asks the
 * owner's consent once before the first save.
 */
@CapacitorPlugin(name = "UltronDownloads")
public final class UltronDownloadsPlugin extends Plugin {
    private static final class Session {
        OutputStream stream;
        Uri uri;
        String name;
        long bytes;
    }

    private final Map<String, Session> sessions = new HashMap<String, Session>();

    private static String safeName(String raw) {
        String name = raw == null ? "" : raw.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (name.isEmpty() || name.equals(".") || name.equals("..")) name = "ultron-file";
        return name.length() > 120 ? name.substring(name.length() - 120) : name;
    }

    @PluginMethod
    public void begin(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Saving to Downloads needs Android 10 or newer.", "UNSUPPORTED");
            return;
        }
        startSession(call);
    }

    private void startSession(PluginCall call) {
        String name = safeName(call.getString("name", "ultron-file"));
        String mime = call.getString("mimeType", "application/octet-stream");
        if (mime == null || mime.isEmpty()) mime = "application/octet-stream";
        try {
            Session session = new Session();
            session.name = name;
            ContentResolver resolver = getContext().getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) { call.reject("Could not create the file in Downloads."); return; }
            session.uri = uri;
            session.stream = resolver.openOutputStream(uri);
            if (session.stream == null) { call.reject("Could not open the file for writing."); return; }
            String id = UUID.randomUUID().toString();
            synchronized (sessions) { sessions.put(id, session); }
            JSObject result = new JSObject();
            result.put("id", id);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not start saving: " + error.getMessage());
        }
    }

    @PluginMethod
    public void append(PluginCall call) {
        Session session;
        synchronized (sessions) { session = sessions.get(call.getString("id", "")); }
        String data = call.getString("data", "");
        if (session == null) { call.reject("Unknown save session."); return; }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            session.stream.write(bytes);
            session.bytes += bytes.length;
            call.resolve();
        } catch (Exception error) {
            abortSession(call.getString("id", ""));
            call.reject("Writing failed: " + error.getMessage());
        }
    }

    @PluginMethod
    public void finish(PluginCall call) {
        String id = call.getString("id", "");
        Session session;
        synchronized (sessions) { session = sessions.remove(id); }
        if (session == null) { call.reject("Unknown save session."); return; }
        try {
            session.stream.flush();
            session.stream.close();
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            getContext().getContentResolver().update(session.uri, done, null, null);
            JSObject result = new JSObject();
            result.put("name", session.name);
            result.put("bytes", session.bytes);
            result.put("location", "Downloads/" + session.name);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not finish saving: " + error.getMessage());
        }
    }

    @PluginMethod
    public void abort(PluginCall call) {
        abortSession(call.getString("id", ""));
        call.resolve();
    }

    private void abortSession(String id) {
        Session session;
        synchronized (sessions) { session = sessions.remove(id); }
        if (session == null) return;
        try { session.stream.close(); } catch (Exception ignored) { /* already closed */ }
        try {
            if (session.uri != null) getContext().getContentResolver().delete(session.uri, null, null);
        } catch (Exception ignored) { /* nothing to clean up */ }
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("supported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q);
        result.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(result);
    }
}

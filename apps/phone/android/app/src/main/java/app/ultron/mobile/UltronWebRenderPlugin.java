package app.ultron.mobile;

import android.os.Handler;
import android.os.Looper;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayInputStream;
import java.net.InetAddress;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Renders a public web page in a hidden WebView and hands back the final DOM plus the JSON calls the page made.
 * This is the phone's equivalent of a headless browser fetch. It is a normal browser: it does not hide that it is
 * automated and does not try to defeat bot protection. Requests to loopback, link-local and private-network
 * addresses are blocked, only http and https load, and file/content access is switched off.
 */
@CapacitorPlugin(name = "UltronWebRender")
public final class UltronWebRenderPlugin extends Plugin {
    private static final int MAX_SEEN = 400;
    private static final String USER_AGENT =
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36 Ultron/3";

    /** Records the page's own fetch and XHR calls (JSON/text responses only, truncated). Guarded so it installs once. */
    private static final String CAPTURE_HOOK =
        "(function(){if(window.__ultronCap){return;}var cap=window.__ultronCap=[];"
        + "var of=window.fetch;if(of){window.fetch=function(i,o){var u=(typeof i==='string')?i:((i&&i.url)||'');"
        + "var m=(o&&o.method)||(i&&i.method)||'GET';var b=(o&&typeof o.body==='string')?o.body:'';"
        + "return of.apply(this,arguments).then(function(r){try{var c=r.clone();var ct=c.headers.get('content-type')||'';"
        + "if(/json|text/.test(ct)){c.text().then(function(t){cap.push({m:m,u:u,b:b,s:r.status,c:ct,r:t.slice(0,200000)});});}}catch(e){}return r;});};}"
        + "var X=XMLHttpRequest.prototype,oo=X.open,os=X.send;"
        + "X.open=function(m,u){this.__m=m;this.__u=u;return oo.apply(this,arguments);};"
        + "X.send=function(b){var x=this;x.addEventListener('loadend',function(){try{var ct=x.getResponseHeader('content-type')||'';"
        + "if(/json|text/.test(ct)){cap.push({m:x.__m,u:x.__u,b:(typeof b==='string'?b:''),s:x.status,c:ct,r:(x.responseText||'').slice(0,200000)});}}catch(e){}});"
        + "return os.apply(this,arguments);};})();";

    private static final String READ_DOM =
        "(function(){try{return JSON.stringify({html:document.documentElement.outerHTML.slice(0,3000000),cap:(window.__ultronCap||[]).slice(0,60)});}"
        + "catch(e){return JSON.stringify({html:'',cap:[]});}})()";

    private static int clamp(int value, int low, int high) { return Math.max(low, Math.min(high, value)); }

    @PluginMethod
    public void render(final PluginCall call) {
        final String url = call.getString("url", "");
        final int timeoutMs = clamp(call.getInt("timeoutMs", 25000), 3000, 60000);
        final int settleMs = clamp(call.getInt("settleMs", 1500), 0, 10000);
        final String lower = url == null ? "" : url.toLowerCase(Locale.ROOT);
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
            call.reject("Only http and https pages can be rendered.");
            return;
        }
        if (isBlockedHost(hostOf(url))) {
            call.reject("That address is not a public web page.");
            return;
        }
        final AtomicBoolean finished = new AtomicBoolean(false);
        final JSArray seen = new JSArray();
        final Handler handler = new Handler(Looper.getMainLooper());
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                final WebView webView = new WebView(getContext());
                final Runnable[] timeout = new Runnable[1];
                final Runnable[] settle = new Runnable[1];
                final Runnable finish = new Runnable() {
                    @Override
                    public void run() {
                        if (finished.get()) return;
                        webView.evaluateJavascript(READ_DOM, new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String value) {
                                if (!finished.compareAndSet(false, true)) return;
                                handler.removeCallbacks(timeout[0]);
                                JSObject result = new JSObject();
                                result.put("url", webView.getUrl() == null ? url : webView.getUrl());
                                result.put("payload", decodeJsString(value));
                                result.put("seen", seen);
                                destroy(webView);
                                call.resolve(result);
                            }
                        });
                    }
                };
                timeout[0] = new Runnable() {
                    @Override
                    public void run() {
                        if (finished.get()) return;
                        // Return whatever has rendered so far instead of failing the whole request.
                        finish.run();
                        handler.postDelayed(new Runnable() {
                            @Override
                            public void run() {
                                if (finished.compareAndSet(false, true)) {
                                    destroy(webView);
                                    call.reject("The page did not finish loading in time.");
                                }
                            }
                        }, 2000);
                    }
                };
                settle[0] = finish;
                WebSettings settings = webView.getSettings();
                settings.setJavaScriptEnabled(true);
                settings.setDomStorageEnabled(true);
                settings.setAllowFileAccess(false);
                settings.setAllowContentAccess(false);
                settings.setBlockNetworkImage(true);
                settings.setMediaPlaybackRequiresUserGesture(true);
                settings.setUserAgentString(USER_AGENT);
                webView.setWebViewClient(new WebViewClient() {
                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                        String target = request.getUrl().toString();
                        String scheme = request.getUrl().getScheme();
                        boolean web = "http".equals(scheme) || "https".equals(scheme);
                        if (!web || isBlockedHost(request.getUrl().getHost())) {
                            return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
                        }
                        synchronized (seen) { if (seen.length() < MAX_SEEN) seen.put(request.getMethod() + " " + target); }
                        return null;
                    }

                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        String scheme = request.getUrl().getScheme();
                        boolean web = "http".equals(scheme) || "https".equals(scheme);
                        return !web || isBlockedHost(request.getUrl().getHost());
                    }

                    @Override
                    public void onPageStarted(WebView view, String pageUrl, android.graphics.Bitmap favicon) {
                        view.evaluateJavascript(CAPTURE_HOOK, null);
                    }

                    @Override
                    public void onPageFinished(WebView view, String pageUrl) {
                        view.evaluateJavascript(CAPTURE_HOOK, null);
                        handler.removeCallbacks(settle[0]);
                        handler.postDelayed(settle[0], settleMs);
                    }
                });
                handler.postDelayed(timeout[0], timeoutMs);
                webView.loadUrl(url);
            }
        });
    }

    private static void destroy(final WebView webView) {
        try { webView.stopLoading(); webView.destroy(); } catch (Exception ignored) { /* already gone */ }
    }

    /** evaluateJavascript returns a JSON-encoded string literal (or "null"); turn it back into the raw string. */
    private static String decodeJsString(String value) {
        if (value == null || value.equals("null") || value.length() < 2) return "{}";
        try {
            return new org.json.JSONArray("[" + value + "]").getString(0);
        } catch (Exception error) {
            return "{}";
        }
    }

    private static String hostOf(String url) {
        try { return new java.net.URI(url).getHost(); } catch (Exception error) { return null; }
    }

    /** True for names and addresses that must never be reached from a page: loopback, link-local, private and unique-local ranges. */
    static boolean isBlockedHost(String host) {
        if (host == null || host.isEmpty()) return true;
        String h = host.toLowerCase(Locale.ROOT);
        if (h.equals("localhost") || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
        try {
            InetAddress address = InetAddress.getByName(h);
            if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress() || address.isSiteLocalAddress() || address.isMulticastAddress()) return true;
            byte[] b = address.getAddress();
            if (b.length == 4 && (b[0] & 0xff) == 100 && (b[1] & 0xc0) == 0x40) return true; // 100.64.0.0/10 carrier-grade NAT
            if (b.length == 16 && (b[0] & 0xfe) == 0xfc) return true; // fc00::/7 unique local
            return false;
        } catch (Exception error) {
            return true; // unresolvable: do not load it
        }
    }
}

import React, { useEffect, useState } from "react";

const AD_CLIENT = (import.meta as any).env.VITE_ADSENSE_CLIENT || "";
const API_URL = (import.meta as any).env.VITE_API_URL || "http://localhost:3001";
const ENABLE_LOCAL_AD_EVENT = (import.meta as any).env.VITE_ENABLE_AD_EVENT_FOR_LOCAL === 'true';

const postEvent = async (event: string, info?: any, client?: string) => {
  // Avoid noisy connection-refused errors during local development when
  // the backend isn't running. Only send events to localhost if explicitly enabled.
  if ((API_URL.includes('localhost') || API_URL.includes('127.0.0.1')) && !ENABLE_LOCAL_AD_EVENT) {
    return;
  }

  try {
    await fetch(`${API_URL}/ad-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, client: client ?? AD_CLIENT, info })
    });
  } catch (e) {
    // ignore network/logging failures
  }
};

const injectAds = () => {
  try {
    // Resolve the ad client to use: prefer compiled env, fall back to any
    // existing <ins class="adsbygoogle" data-ad-client="..."> in the DOM.
    let client = AD_CLIENT || "";
    if (!client) {
      try {
        const ins = document.querySelector('ins.adsbygoogle[data-ad-client]') as HTMLElement | null;
        const attr = ins?.getAttribute("data-ad-client") ?? "";
        if (attr) {
          client = attr;
          // eslint-disable-next-line no-console
          console.debug("Using runtime data-ad-client fallback for AdSense injection.", client);
        }
      } catch (e) {
        // ignore DOM access errors
      }
    }

    if (!client) {
      // Reduce noise in console; this is expected in many dev setups.
      // eslint-disable-next-line no-console
      console.debug("VITE_ADSENSE_CLIENT not set and no DOM fallback found; skipping AdSense injection.");
      postEvent("skip_inject_no_client", undefined, client);
      return;
    }

    if ((window as any).__ads_injected) return;
    // Add the AdSense loader script
    const s = document.createElement("script");
    s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js";
    s.async = true;
    s.setAttribute("data-ad-client", client);
    s.onload = () => {
      try {
        // Initialize any inline ad placeholders
        (window as any).adsbygoogle = (window as any).adsbygoogle || [];
        (window as any).adsbygoogle.push({});
        postEvent("injected", undefined, client);
      } catch (e) {
        postEvent("inject_init_error", { message: String(e) }, client);
      }
    };
    s.onerror = () => {
      postEvent("inject_error", undefined, client);
    };
    document.head.appendChild(s);
    (window as any).__ads_injected = true;
  } catch (e) {
    // ignore
    postEvent("inject_exception", { message: String(e) }, undefined);
  }
};

const initConsentModeDefaults = () => {
  try {
    (window as any).dataLayer = (window as any).dataLayer || [];
    if (!(window as any).gtag) {
      (window as any).gtag = function () { (window as any).dataLayer.push(arguments); };
    }
    // Start with denied storage until the user gives consent
    (window as any).gtag('consent', 'default', { ad_storage: 'denied', analytics_storage: 'denied' });
  } catch (e) {
    // ignore
  }
};

// Expose a very small, self-hosted CMP API so other scripts that probe for
// `__tcfapi` / `__cmp` won't fail. This is NOT a certified IAB TCF CMP.
// It provides minimal responses and allows the page to respond synchronously
// to simple queries. For full IAB compliance use a certified CMP.
const exposeSimpleCmpApi = () => {
  try {
    const win = window as any;
    if (!win.__tcfapi) {
      win.__tcfapi = function (cmd: string, version: number, callback: Function, args?: any) {
        if (typeof callback !== 'function') return;
        if (cmd === 'getTCData') {
          const tcData = { tcString: '', gdprApplies: false, eventStatus: 'tcloaded', purpose: { consents: {} } };
          callback(tcData, true);
        } else if (cmd === 'addEventListener') {
          // Immediately call listener with a simple event indicating loaded
          const listener = args && args.listener ? args.listener : callback;
          try { listener({ eventStatus: 'tcloaded' }, true); } catch (e) {}
          callback({}, true);
        } else {
          callback({}, true);
        }
      };
    }
    if (!win.__cmp) {
      win.__cmp = function (command: string, parameter: any, callback: Function) {
        if (typeof callback === 'function') callback({ gdprApplies: false }, true);
      };
    }
  } catch (e) {
    // ignore
  }
};

const CookieConsent: React.FC = () => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const val = localStorage.getItem("cookieConsent");
      // Initialize a minimal Consent Mode + CMP API on page load. This ensures
      // other scripts can query consent and that Google Consent Mode defaults
      // to denied until the user accepts.
      initConsentModeDefaults();
      exposeSimpleCmpApi();
      if (!val) setVisible(true);
      if (val === "accepted") {
        injectAds();
      }
    } catch (e) {
      setVisible(false);
    }
  }, []);

  const accept = () => {
    try { localStorage.setItem("cookieConsent", "accepted"); } catch {}
    setVisible(false);
    try {
      // Update Google Consent Mode to granted for ads + analytics
      (window as any).gtag && (window as any).gtag('consent', 'update', { ad_storage: 'granted', analytics_storage: 'granted' });
    } catch (e) {}
    injectAds();
  };

  const decline = () => {
    try { localStorage.setItem("cookieConsent", "declined"); } catch {}
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div style={{ position: "fixed", left: 0, right: 0, bottom: 12, display: "flex", justifyContent: "center", zIndex: 9999 }}>
      <div style={{ background: "rgba(0,0,0,0.85)", color: "#fff", padding: "12px 16px", borderRadius: 8, maxWidth: 920, width: "calc(100% - 32px)", display: "flex", alignItems: "center", gap: 12, boxShadow: "0 6px 18px rgba(0,0,0,0.2)" }}>
        <div style={{ flex: 1, fontSize: 14 }}>
          This site uses cookies for analytics and personalised ads. See our <a href="/privacy.html" style={{ color: "#9be" }}>Privacy Policy</a>.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={decline} style={{ background: "transparent", color: "#fff", border: "1px solid rgba(255,255,255,0.18)", padding: "8px 12px", borderRadius: 6 }}>Decline</button>
          <button onClick={accept} style={{ background: "#0b7cff", color: "#fff", border: "none", padding: "8px 12px", borderRadius: 6 }}>Accept</button>
        </div>
      </div>
    </div>
  );
};

export default CookieConsent;

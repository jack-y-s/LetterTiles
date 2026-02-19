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

// Helpers to integrate CookieYes: detect consent state (sync where possible)
// and listen for changes. When ad consent is granted we update Google
// Consent Mode and inject AdSense.
const getCookie = (name: string) => {
  try {
    const m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return m ? decodeURIComponent(m[2]) : null;
  } catch (e) {
    return null;
  }
};

const parseMaybeJson = (value: string | null) => {
  if (!value) return null;
  try { return JSON.parse(value); } catch (e) { return null; }
};

const evaluateAdConsentFromCookieYes = (consentObj: any): boolean | null => {
  if (!consentObj) return null;
  // CookieYes commonly exposes a JSON with marketing/advertising keys
  if (typeof consentObj === 'object') {
    if (typeof consentObj.marketing === 'boolean') return consentObj.marketing;
    if (typeof consentObj.advertising === 'boolean') return consentObj.advertising;
    // Some setups use categories/purposes map
    if (consentObj.purposes && typeof consentObj.purposes === 'object') {
      // purpose index for advertising varies; check common keys
      if (typeof consentObj.purposes.marketing === 'boolean') return consentObj.purposes.marketing;
    }
  }
  return null;
};

const tryResolveCookieYesConsentSync = (): boolean | null => {
  try {
    const win = window as any;
    // 1) check typical global objects
    if (win.cookieyes && typeof win.cookieyes.getConsent === 'function') {
      try {
        const c = win.cookieyes.getConsent();
        const v = evaluateAdConsentFromCookieYes(c);
        if (typeof v === 'boolean') return v;
      } catch (e) {}
    }
    if (win.cookieyes && win.cookieyes.consent) {
      const v = evaluateAdConsentFromCookieYes(win.cookieyes.consent);
      if (typeof v === 'boolean') return v;
    }

    // 2) parse standard CookieYes cookie names (try a few known names)
    const candidates = ['cookieyes_consent', 'cookieyes-consent', 'cookieyes_status', 'cookieyes'];
    for (const name of candidates) {
      const raw = getCookie(name);
      const parsed = parseMaybeJson(raw);
      const v = evaluateAdConsentFromCookieYes(parsed);
      if (typeof v === 'boolean') return v;
    }
  } catch (e) {
    // ignore
  }
  return null;
};

const registerCookieYesListeners = () => {
  try {
    const win = window as any;

    const handle = (adGranted: boolean | null) => {
      if (adGranted === null) return;
      try {
        const adStorage = adGranted ? 'granted' : 'denied';
        (window as any).gtag && (window as any).gtag('consent', 'update', { ad_storage: adStorage, analytics_storage: adGranted ? 'granted' : 'denied' });
        if (adGranted) injectAds();
      } catch (e) {}
    };

    // Try synchronous resolution first
    const initial = tryResolveCookieYesConsentSync();
    if (typeof initial === 'boolean') handle(initial);

    // Listen for a few possible custom events CookieYes might dispatch.
    // (CookieYes may dispatch different event names depending on integration.)
    const eventNames = ['cookieyes-consent-changed', 'cookieyes_consent_changed', 'cookieyes:consent', 'cookieyes:change', 'cookieyes.consent.updated'];
    for (const ev of eventNames) {
      window.addEventListener(ev, () => {
        const val = tryResolveCookieYesConsentSync();
        handle(val);
      });
    }

    // Also attempt to use the IAB __tcfapi when available (async callback)
    if (typeof win.__tcfapi === 'function') {
      try {
        win.__tcfapi('getTCData', 2, function (tcData: any, success: boolean) {
          if (success && tcData && tcData.purpose && tcData.purpose.consents) {
            // heuristic: if any purpose consent present, treat as granted
            const purposes = tcData.purpose.consents;
            const any = Object.keys(purposes).some(k => !!purposes[k]);
            handle(any);
          }
        });
      } catch (e) {}
    }

    // Fallback: poll the common CookieYes cookie for changes for up to 30s
    let last = getCookie('cookieyes_consent') || getCookie('cookieyes-consent') || getCookie('cookieyes');
    const start = Date.now();
    const poll = setInterval(() => {
      const nowRaw = getCookie('cookieyes_consent') || getCookie('cookieyes-consent') || getCookie('cookieyes');
      if (nowRaw !== last) {
        last = nowRaw;
        const val = tryResolveCookieYesConsentSync();
        handle(val);
      }
      if (Date.now() - start > 30000) clearInterval(poll);
    }, 1000);
  } catch (e) {
    // ignore
  }
};

const CookieConsent: React.FC = () => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const val = localStorage.getItem("cookieConsent");
      // Initialize a minimal Consent Mode on page load. This ensures other
      // scripts can query consent and that Google Consent Mode defaults to
      // denied until the user accepts.
      initConsentModeDefaults();
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

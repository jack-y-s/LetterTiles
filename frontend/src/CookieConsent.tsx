import React, { useEffect, useState } from "react";

const AD_CLIENT = (import.meta as any).env.VITE_ADSENSE_CLIENT || "";
const API_URL = (import.meta as any).env.VITE_API_URL || "http://localhost:3001";

const postEvent = async (event: string, info?: any) => {
  try {
    await fetch(`${API_URL}/ad-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, client: AD_CLIENT, info })
    });
  } catch (e) {
    // ignore network/logging failures
  }
};

const injectAds = () => {
  try {
    if (!AD_CLIENT) {
      // eslint-disable-next-line no-console
      console.warn("VITE_ADSENSE_CLIENT is not set; skipping AdSense injection.");
      postEvent("skip_inject_no_client");
      return;
    }
    if ((window as any).__ads_injected) return;
    // Add the AdSense loader script
    const s = document.createElement("script");
    s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js";
    s.async = true;
    s.setAttribute("data-ad-client", AD_CLIENT);
    s.onload = () => {
      try {
        // Initialize any inline ad placeholders
        (window as any).adsbygoogle = (window as any).adsbygoogle || [];
        (window as any).adsbygoogle.push({});
        postEvent("injected");
      } catch (e) {
        postEvent("inject_init_error", { message: String(e) });
      }
    };
    s.onerror = () => {
      postEvent("inject_error");
    };
    document.head.appendChild(s);
    (window as any).__ads_injected = true;
  } catch (e) {
    // ignore
    postEvent("inject_exception", { message: String(e) });
  }
};

const CookieConsent: React.FC = () => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const val = localStorage.getItem("cookieConsent");
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

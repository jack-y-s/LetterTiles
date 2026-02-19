import React, { useEffect, useState } from "react";

const CookieConsent: React.FC = () => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const val = localStorage.getItem("cookieConsent");
      if (!val) setVisible(true);
    } catch (e) {
      setVisible(false);
    }
  }, []);

  const accept = () => {
    try { localStorage.setItem("cookieConsent", "accepted"); } catch {}
    setVisible(false);
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

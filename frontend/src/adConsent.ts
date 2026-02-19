const AD_CLIENT = (import.meta as any).env.VITE_ADSENSE_CLIENT || "";

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
  if (typeof consentObj === 'object') {
    if (typeof consentObj.marketing === 'boolean') return consentObj.marketing;
    if (typeof consentObj.advertising === 'boolean') return consentObj.advertising;
    if (consentObj.purposes && typeof consentObj.purposes === 'object') {
      if (typeof consentObj.purposes.marketing === 'boolean') return consentObj.purposes.marketing;
    }
  }
  return null;
};

const tryResolveCookieYesConsentSync = (): boolean | null => {
  try {
    const win = window as any;
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

const resolveClient = (): string | null => {
  try {
    if (AD_CLIENT) return AD_CLIENT;
    const ins = document.querySelector('ins.adsbygoogle[data-ad-client]') as HTMLElement | null;
    const attr = ins?.getAttribute('data-ad-client') ?? '';
    return attr || null;
  } catch (e) {
    return null;
  }
};

const injectAds = () => {
  try {
    if ((window as any).__ads_injected) return;
    const client = resolveClient();
    if (!client) return;
    const s = document.createElement('script');
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(client)}`;
    s.onload = () => {
      try {
        (window as any).adsbygoogle = (window as any).adsbygoogle || [];
        (window as any).adsbygoogle.push({});
      } catch (e) {}
    };
    s.onerror = () => {
      // ignore
    };
    document.head.appendChild(s);
    (window as any).__ads_injected = true;
  } catch (e) {
    // ignore
  }
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

    const initial = tryResolveCookieYesConsentSync();
    if (typeof initial === 'boolean') handle(initial);

    const eventNames = ['cookieyes-consent-changed', 'cookieyes_consent_changed', 'cookieyes:consent', 'cookieyes:change', 'cookieyes.consent.updated'];
    for (const ev of eventNames) {
      window.addEventListener(ev, () => {
        const val = tryResolveCookieYesConsentSync();
        handle(val);
      });
    }

    if (typeof win.__tcfapi === 'function') {
      try {
        win.__tcfapi('getTCData', 2, function (tcData: any, success: boolean) {
          if (success && tcData && tcData.purpose && tcData.purpose.consents) {
            const purposes = tcData.purpose.consents;
            const any = Object.keys(purposes).some(k => !!purposes[k]);
            handle(any);
          }
        });
      } catch (e) {}
    }

    // Poll cookie changes briefly
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

export const initAdConsent = () => {
  registerCookieYesListeners();
};

export default initAdConsent;

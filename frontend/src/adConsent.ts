const AD_CLIENT = (import.meta as any).env.VITE_ADSENSE_CLIENT || "";

const getCookie = (name: string) => {
  try {
    const m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return m ? decodeURIComponent(m[2]) : null;
  } catch (e) {
    return null;
  }
};

// removed complex/flat-cookie parsing — prefer JSON parse or simple substring checks

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

    // If CookieYes didn't expose a JS API, try cookies. Prefer JSON-formatted cookie
    // but also handle simple legacy/compact strings by substring checks.
    const candidates = ['cookieyes_consent', 'cookieyes-consent', 'cookieyes_status', 'cookieyes'];
    for (const name of candidates) {
      const raw = getCookie(name);
      if (!raw) continue;
      // If value looks like JSON, try to parse and evaluate
      const trimmed = raw.trim();
      if (trimmed.startsWith('{')) {
        try {
          const obj = JSON.parse(trimmed);
          const v = evaluateAdConsentFromCookieYes(obj);
          if (typeof v === 'boolean') return v;
        } catch (e) {
          // fall back to substring checks below
        }
      }
      // Simple substring checks for common affirmative markers
      if (/consent:yes/i.test(raw) || /advertisement:yes/i.test(raw) || /advertisement=true/i.test(raw) || /consent=true/i.test(raw)) {
        return true;
      }
      if (/consent:no/i.test(raw) || /advertisement:no/i.test(raw) || /advertisement=false/i.test(raw) || /consent=false/i.test(raw)) {
        return false;
      }
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
    if (attr) return attr;
    // Fallback: meta tag may carry the publisher id
    const meta = document.querySelector('meta[name="google-adsense-account"]') as HTMLMetaElement | null;
    const metaVal = meta?.getAttribute('content') ?? '';
    if (metaVal) return metaVal;
    return null;
  } catch (e) {
    return null;
  }
};

const injectAds = () => {
  try {
    if ((window as any).__ads_injected) {
      console.log('[adConsent] injectAds: already injected');
      return;
    }
    const client = resolveClient();
    console.log('[adConsent] injectAds: resolved client=', client);
    if (!client) {
      console.log('[adConsent] injectAds: no client found, aborting');
      return;
    }
    // Ensure an <ins class="adsbygoogle" data-ad-client> exists so push() works
    let ins = document.querySelector('ins.adsbygoogle[data-ad-client]') as HTMLElement | null;
    if (!ins) {
      console.log('[adConsent] injectAds: no ins.adsbygoogle found — creating placeholder');
      ins = document.createElement('ins');
      ins.className = 'adsbygoogle';
      ins.setAttribute('data-ad-client', client);
      // Minimal styles so it doesn't collapse; page can replace/position this element as needed
      ins.style.display = 'block';
      ins.style.minHeight = '1px';
      document.body.appendChild(ins);
    }
    const s = document.createElement('script');
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(client)}`;
    s.onload = () => {
      try {
        console.log('[adConsent] injectAds: ads script loaded — pushing');
        (window as any).adsbygoogle = (window as any).adsbygoogle || [];
        (window as any).adsbygoogle.push({});
      } catch (e) {
        console.warn('[adConsent] injectAds: push failed', e);
      }
    };
    s.onerror = () => {
      console.warn('[adConsent] injectAds: script load error');
    };
    document.head.appendChild(s);
    (window as any).__ads_injected = true;
  } catch (e) {
    console.warn('[adConsent] injectAds: unexpected error', e);
  }
};

const registerCookieYesListeners = () => {
  try {
    const win = window as any;
    const handle = (adGranted: boolean | null) => {
      if (adGranted === null) return;
      try {
        console.log('[adConsent] handle: adGranted=', adGranted);
        const adStorage = adGranted ? 'granted' : 'denied';
        (window as any).gtag && (window as any).gtag('consent', 'update', { ad_storage: adStorage, analytics_storage: adGranted ? 'granted' : 'denied' });
        if (adGranted) {
          console.log('[adConsent] handle: calling injectAds()');
          injectAds();
        }
      } catch (e) {}
    };

    const initial = tryResolveCookieYesConsentSync();
    console.log('[adConsent] initial resolved:', initial);
    if (typeof initial === 'boolean') handle(initial);

    const eventNames = ['cookieyes-consent-changed', 'cookieyes_consent_changed', 'cookieyes:consent', 'cookieyes:change', 'cookieyes.consent.updated'];
    for (const ev of eventNames) {
      window.addEventListener(ev, () => {
        console.log('[adConsent] event fired:', ev);
        const val = tryResolveCookieYesConsentSync();
        console.log('[adConsent] event value:', val);
        handle(val);
      });
    }

    if (typeof win.__tcfapi === 'function') {
      try {
        win.__tcfapi('getTCData', 2, function (tcData: any, success: boolean) {
          console.log('[adConsent] __tcfapi returned', success, tcData);
          if (success && tcData && tcData.purpose && tcData.purpose.consents) {
            const purposes = tcData.purpose.consents;
            const any = Object.keys(purposes).some(k => !!purposes[k]);
            handle(any);
          }
        });
      } catch (e) { console.warn('[adConsent] __tcfapi error', e); }
    }

    // Poll cookie changes briefly
    let last = getCookie('cookieyes_consent') || getCookie('cookieyes-consent') || getCookie('cookieyes');
    const start = Date.now();
    const poll = setInterval(() => {
      const nowRaw = getCookie('cookieyes_consent') || getCookie('cookieyes-consent') || getCookie('cookieyes');
      if (nowRaw !== last) {
        console.log('[adConsent] cookie change detected');
        last = nowRaw;
        const val = tryResolveCookieYesConsentSync();
        console.log('[adConsent] polled value:', val);
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

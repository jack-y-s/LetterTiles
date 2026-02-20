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

// Backend availability state: if the backend becomes unreachable, degrade to console logging
let backendReachable = true;
let backendProbeScheduled = false;

const scheduleBackendProbe = () => {
  if (backendProbeScheduled) return;
  backendProbeScheduled = true;
  const tryProbe = async () => {
    try {
      const res = await fetch('/ad-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ probe: true }),
        keepalive: true,
      });
      if (res && res.ok) {
        backendReachable = true;
        backendProbeScheduled = false;
        console.log('[adConsent] backend reachable again');
      } else {
        setTimeout(tryProbe, 60000);
      }
    } catch (e) {
      setTimeout(tryProbe, 60000);
    }
  };
  // start probe after a short delay
  setTimeout(tryProbe, 60000);
};

const sendAdEvent = async (payload: any) => {
  try {
    if (!backendReachable) {
      console.log('[adConsent][offline] event:', payload);
      scheduleBackendProbe();
      return;
    }
    const res = await fetch('/ad-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    });
    if (!res.ok) throw new Error('non-OK status ' + res.status);
  } catch (e) {
    console.warn('[adConsent] /ad-event failed, switching to offline mode', e);
    backendReachable = false;
    console.log('[adConsent][offline] event (saved to console):', payload);
    scheduleBackendProbe();
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
      try {
        sendAdEvent({ client: null, event: 'inject_aborted', info: { reason: 'no_client' } });
      } catch (e) {}
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
        // Wait briefly for a creative iframe to appear. If none shows up,
        // treat this as a likely "not approved / no creative" situation
        // and remove/hide the placeholder so users don't see an empty slot.
        const waitForCreative = (el: Element | null, timeout = 6000) =>
          new Promise<boolean>((resolve) => {
            if (!el) return resolve(false);
            let resolved = false;
            const check = () => {
              try {
                const iframe = el.querySelector('iframe') as HTMLIFrameElement | null;
                if (iframe && (iframe.clientHeight > 0 || iframe.clientWidth > 0)) {
                  resolved = true;
                  resolve(true);
                }
              } catch (e) {
                // ignore
              }
            };
            // Observe DOM changes under the `ins` element
            const obs = new MutationObserver(() => {
              check();
              if (resolved) obs.disconnect();
            });
            obs.observe(el, { childList: true, subtree: true });
            // Initial immediate check
            check();
            // Fallback timeout
            setTimeout(() => {
              obs.disconnect();
              if (!resolved) {
                // Final check before resolving false
                check();
                resolve(resolved);
              }
            }, timeout);
          });

        waitForCreative(ins, 6000).then((hasCreative) => {
          try {
            if (hasCreative) {
              sendAdEvent({ client, event: 'inject_success', info: { insPresent: !!ins, href: location.href } });
            } else {
              console.warn('[adConsent] injectAds: no creative detected — removing placeholder');
              try {
                sendAdEvent({ client, event: 'inject_no_creative', info: { insPresent: !!ins, href: location.href } });
              } catch (e) {}
              if (ins && ins.parentNode) {
                ins.parentNode.removeChild(ins);
              }
            }
          } catch (e) {
            // ignore
          }
        }).catch(() => {});
        } catch (e) {
        console.warn('[adConsent] injectAds: push failed', e);
        try {
          sendAdEvent({ client, event: 'inject_push_failed', info: { error: String(e) } });
        } catch (e2) {}
      }
    };
    s.onerror = () => {
      console.warn('[adConsent] injectAds: script load error');
      try {
        sendAdEvent({ client, event: 'inject_script_error', info: null });
      } catch (e) {}
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
              console.log('[adConsent] handle: calling injectAutoAds()');
              injectAutoAds();
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

// Public helper: inject Google's Auto Ads script after consent. Keeps a flag to avoid duplicate injection.
const injectAutoAds = () => {
  try {
    if ((window as any).__auto_ads_injected) {
      console.log('[adConsent] injectAutoAds: already injected');
      return;
    }
    // Reuse existing injectAds() logic which appends the official Google loader script
    injectAds();
    (window as any).__auto_ads_injected = true;
  } catch (e) {
    console.warn('[adConsent] injectAutoAds: unexpected error', e);
  }
};

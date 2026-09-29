/**
 * Admin-configured site settings (favicon, analytics, custom CSS), applied
 * to whichever page imports this (each page carries its own description, for
 * search and link previews). Resolves to the settings,
 * or {} when unavailable.
 */
export async function applySiteSettings() {
    let s;
    try {
        const res = await fetch('/api/settings');
        if (!res.ok) return {};
        s = await res.json();
    } catch {
        return {};
    }

    if (s.favicon) {
        document.querySelectorAll('link[rel="icon"]').forEach(el => el.remove());
        document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon', href: s.favicon }));
    }
    // Scripts parsed from markup never execute: recreate each one
    if (s.analyticsScript) {
        const tpl = document.createElement('template');
        tpl.innerHTML = s.analyticsScript;
        for (const old of tpl.content.querySelectorAll('script')) {
            const script = document.createElement('script');
            for (const attr of old.attributes) script.setAttribute(attr.name, attr.value);
            script.textContent = old.textContent;
            document.head.appendChild(script);
        }
    }
    if (s.customCss) {
        document.head.appendChild(Object.assign(document.createElement('style'), { textContent: s.customCss }));
    }
    return s;
}

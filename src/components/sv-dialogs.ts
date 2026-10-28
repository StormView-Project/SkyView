import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { format } from 'date-fns';
import { errorText } from '../lib/api';
import { locateMe, setLocation } from '../lib/data';
import { semantic, SEVERITY_HUE } from '../lib/format';
import { $, store, StoreController } from '../lib/store';
import type { Alert } from '../lib/types';
import { openExternal, SvElement } from '../lib/ui';

export const WHATS_NEW_VERSION = 'web-1.0.0';

const WHATS_NEW = [
  { icon: 'partly_cloudy_day', title: 'SkyView on the web', desc: 'Live radar, forecasts and alerts in your browser — no install needed. Add it to your home screen for an app-like feel.' },
  { icon: 'smartphone', title: 'Built for your phone', desc: 'A phone layout with a bottom navigation bar, a live radar preview, and touch-friendly radar controls.' },
  { icon: 'animation', title: 'Animated weather scene', desc: 'Sun, drifting clouds, rain, snow, fog and lightning play behind the temperature, tinted by your theme.' },
  { icon: 'palette', title: 'Material You, for real', desc: 'Every color comes from Google’s dynamic color algorithm. Pick a seed, a scheme style and contrast — or let the weather choose.' },
  { icon: 'radar', title: 'LibreWXR radar on a vector map', desc: 'A crisp MapLibre map tinted to your theme, with the 90-minute nowcast, color schemes and storm arrows.' },
  { icon: 'notifications_active', title: 'Alert notifications', desc: 'Get NWS warnings and unhealthy-air alerts as browser notifications while SkyView is open.' },
];

const RELEASES = 'https://github.com/StormView-Project';

type Platform = 'desktop' | 'mac' | 'android' | 'ios';

const DOWNLOADS: { id: Platform; icon: string; shape: string; title: string; desc: string; url?: string }[] = [
  { id: 'desktop', icon: 'desktop_windows', shape: 'sunny', title: 'Windows & Linux', desc: 'The native desktop app, with tray alerts and a GPU-rendered map.', url: `${RELEASES}/StormView-Desktop/releases/latest` },
  { id: 'mac', icon: 'laptop_mac', shape: '4-leaf-clover', title: 'macOS', desc: 'A native app for your Mac.', url: `${RELEASES}/StormView-MacOS/releases/latest` },
  { id: 'android', icon: 'android', shape: 'flower', title: 'Android', desc: 'Install the APK from the latest release.', url: `${RELEASES}/StormView-AndroidApp/releases/latest` },
  { id: 'ios', icon: 'phone_iphone', shape: 'soft-burst', title: 'iPhone & iPad', desc: 'Add SkyView to your Home Screen — it opens full-screen, just like an app.' },
];

/** The platform this page is running on, so its download can be marked. */
function currentPlatform(): Platform | null {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch support gives it away.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh/.test(ua)) return 'mac';
  if (/Windows|Linux|CrOS/.test(ua)) return 'desktop';
  return null;
}

@customElement('sv-dialogs')
export class SvDialogs extends SvElement {
  private s = new StoreController(this, (s) =>
    [s.alertDialog, s.welcomeOpen, s.betaOpen, s.location, s.dismissedWhatsNewVersion, s.ready, s.tokens, s.downloadsOpen] as const);
  @state() private iosHelp = false;
  /** Last alerts shown, kept so the dialog doesn't empty out while it animates away. */
  private shownAlerts: Alert[] = [];
  @state() private locating = false;
  @state() private locError = '';
  @state() private whatsNewSession = false;
  @state() private neverShow = false;

  private async locate() {
    this.locating = true;
    this.locError = '';
    try {
      setLocation(await locateMe());
      store.set({ welcomeOpen: false });
    } catch (e) {
      this.locError = errorText(e);
    } finally {
      this.locating = false;
    }
  }

  render() {
    const [alerts, welcome, beta, location, dismissed, ready, , downloads] = this.s.value;
    if (alerts) this.shownAlerts = alerts;
    const shown = this.shownAlerts;
    const whatsNew = ready && !!location && !welcome && !this.whatsNewSession && dismissed !== WHATS_NEW_VERSION;
    return html`
      <m3e-dialog class="sv-dialog sv-dialog--wide" ?open=${!!alerts} dismissible @closed=${() => store.set({ alertDialog: null })}>
        ${shown.length
          ? html`<div slot="header" class="sv-dialog-head"><m3e-icon name="warning" filled></m3e-icon>${shown.length > 1 ? `Active alerts (${shown.length})` : shown[0]?.title}</div>
              <div class="sv-alert-cards">
                ${shown.map((a) => {
                  const c = semantic(SEVERITY_HUE[a.severity] ?? SEVERITY_HUE.Unknown);
                  return html`<article class="sv-alert-card" style="background:${c.container};color:${c.onContainer}">
                    <header>
                      <m3e-shape name="burst" style="--m3e-shape-size:40px;--m3e-shape-container-color:${c.color};color:${c.container}"><m3e-icon name="warning" filled></m3e-icon></m3e-shape>
                      <div class="sv-title-medium sv-strong">${a.title}</div>
                      <span class="sv-chip" style="background:${c.color};color:${c.container}">${a.severity === 'Unknown' ? 'Alert' : a.severity}</span>
                    </header>
                    <div class="sv-label-medium">
                      ${a.end ? `Until ${format(a.end, "EEE, MMM d 'at' h:mm a")}` : ''}${a.certainty && a.certainty !== 'Unknown' ? ` · ${a.certainty}` : ''}
                    </div>
                    ${a.headline ? html`<p class="sv-body-medium sv-strong">${a.headline}</p>` : nothing}
                    ${a.description ? html`<p class="sv-pre sv-body-medium">${a.description}</p>` : nothing}
                    ${a.instruction ? html`<p class="sv-pre sv-body-medium sv-alert-instruction">${a.instruction}</p>` : nothing}
                  </article>`;
                })}
              </div>
              <div slot="actions" end><m3e-button variant="filled"><m3e-dialog-action>Close</m3e-dialog-action></m3e-button></div>`
          : nothing}
      </m3e-dialog>

      <m3e-dialog class="sv-dialog sv-welcome" ?open=${welcome} disable-close>
        <div class="sv-welcome-hero">
          <m3e-shape name="very-sunny" class="sv-welcome-shape" style="--m3e-shape-size:120px;--m3e-shape-container-color:var(--md-sys-color-primary-container);color:var(--md-sys-color-on-primary-container)">
            <m3e-icon name="partly_cloudy_day" filled style="--m3e-icon-size:56px"></m3e-icon>
          </m3e-shape>
          <m3e-heading variant="headline" size="medium" emphasized>Welcome to SkyView</m3e-heading>
          <p class="sv-body-large sv-muted">To show weather and radar for your area, SkyView needs your location. You can also set it manually.</p>
          ${this.locError ? html`<m3e-callout variant="error"><m3e-icon slot="icon" name="error"></m3e-icon>${this.locError}</m3e-callout>` : nothing}
        </div>
        <div slot="actions" class="sv-welcome-actions">
          <m3e-button variant="text" @click=${() => store.set({ welcomeOpen: false, settingsOpen: true, settingsTab: 'location' })}>Set manually</m3e-button>
          <m3e-button variant="filled" size="medium" ?disabled=${this.locating} @click=${this.locate}>
            ${this.locating ? html`<m3e-loading-indicator slot="icon" class="sv-small-loader"></m3e-loading-indicator>` : html`<m3e-icon slot="icon" name="my_location"></m3e-icon>`}
            Use my location
          </m3e-button>
        </div>
      </m3e-dialog>

      <m3e-dialog class="sv-dialog" ?open=${beta} dismissible @closed=${() => store.set({ betaOpen: false })}>
        <div slot="header" class="sv-dialog-head"><m3e-icon name="science" filled></m3e-icon>SkyView is in beta</div>
        <p class="sv-body-medium"><b>Under heavy development.</b> You may run into bugs, missing features, or rough edges. Reporting what breaks goes a long way — every bug report helps.</p>
        <m3e-button variant="outlined" class="sv-full" @click=${() => openExternal('https://github.com/arc360alt/StormView-Rewrite/issues')}>
          <m3e-icon slot="icon" name="bug_report"></m3e-icon>Report an issue on GitHub<m3e-icon slot="trailing-icon" name="open_in_new"></m3e-icon>
        </m3e-button>
      </m3e-dialog>

      <m3e-dialog class="sv-dialog sv-dialog--wide" ?open=${downloads} dismissible @closed=${() => { store.set({ downloadsOpen: false }); this.iosHelp = false; }}>
        <div slot="header" class="sv-dialog-head"><m3e-icon name="download" filled></m3e-icon>Get the apps</div>
        <p class="sv-body-medium sv-muted">SkyView is also available as a native app on every platform.</p>
        <div class="sv-downloads">${this.sortedDownloads().map((d, i) => this.downloadRow(d, i))}</div>
        <div slot="actions" end><m3e-button variant="text"><m3e-dialog-action>Close</m3e-dialog-action></m3e-button></div>
      </m3e-dialog>

      <m3e-dialog class="sv-dialog sv-dialog--wide" ?open=${whatsNew} @closed=${() => this.closeWhatsNew()}>
        <div slot="header" class="sv-dialog-head sv-whatsnew-head">
          <span class="sv-chip sv-chip--primary">New</span>
          <span>What’s new in SkyView</span>
        </div>
        <div class="sv-whatsnew">
          ${WHATS_NEW.map((f, i) => html`<div class="sv-whatsnew-item">
            <m3e-shape name=${['sunny', '4-leaf-clover', 'flower', '8-leaf-clover', 'soft-burst', 'puffy'][i % 6]} style="--m3e-shape-size:48px;--m3e-shape-container-color:var(--md-sys-color-${['primary', 'secondary', 'tertiary'][i % 3]}-container);color:var(--md-sys-color-on-${['primary', 'secondary', 'tertiary'][i % 3]}-container)">
              <m3e-icon name=${f.icon} filled></m3e-icon>
            </m3e-shape>
            <div><div class="sv-title-medium">${f.title}</div><div class="sv-body-medium sv-muted">${f.desc}</div></div>
          </div>`)}
        </div>
        <div slot="actions" class="sv-row-between sv-full sv-whatsnew-actions">
          <label class="sv-check"><m3e-checkbox ?checked=${this.neverShow} @change=${(e: Event) => (this.neverShow = (e.target as unknown as { checked: boolean }).checked)}></m3e-checkbox>Don’t show again until the next update</label>
          <m3e-button variant="filled"><m3e-dialog-action>Got it</m3e-dialog-action></m3e-button>
        </div>
      </m3e-dialog>
    `;
  }

  /** This device's download first. */
  private sortedDownloads() {
    const mine = currentPlatform();
    return [...DOWNLOADS].sort((a, b) => Number(b.id === mine) - Number(a.id === mine));
  }

  private async toggleIosHelp() {
    this.iosHelp = !this.iosHelp;
    await this.updateComplete;
    if (this.iosHelp) this.querySelector('.sv-ios-steps')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  private downloadRow(d: (typeof DOWNLOADS)[number], i: number) {
    const role = ['primary', 'secondary', 'tertiary'][i % 3];
    const mine = currentPlatform() === d.id;
    return html`<div class="sv-download ${mine ? 'mine' : ''}">
      <m3e-shape name=${d.shape} style="--m3e-shape-size:48px;--m3e-shape-container-color:var(--md-sys-color-${role}-container);color:var(--md-sys-color-on-${role}-container)">
        <m3e-icon name=${d.icon} filled></m3e-icon>
      </m3e-shape>
      <div class="sv-download-text">
        <div class="sv-title-medium">${d.title}${mine ? html` <span class="sv-chip sv-chip--primary">This device</span>` : nothing}</div>
        <div class="sv-body-small sv-muted">${d.desc}</div>
      </div>
      ${d.url
        ? html`<m3e-button variant=${mine ? 'filled' : 'tonal'} @click=${() => openExternal(d.url!)}>
            <m3e-icon slot="icon" name="download"></m3e-icon>Download
          </m3e-button>`
        : html`<m3e-button variant=${mine ? 'filled' : 'tonal'} @click=${this.toggleIosHelp}>
            <m3e-icon slot="icon" name=${this.iosHelp ? 'expand_less' : 'add_to_home_screen'}></m3e-icon>${this.iosHelp ? 'Hide steps' : 'Add to Home Screen'}
          </m3e-button>`}
      ${d.id === 'ios' && this.iosHelp
        ? html`<ol class="sv-ios-steps sv-body-medium">
            <li><span>Open this page in <b>Safari</b>.</span></li>
            <li><span>Tap the <b>Share</b> button <m3e-icon name="ios_share" class="sv-inline-icon"></m3e-icon> in the toolbar (on iPhone it’s at the bottom; you may need to tap <b>⋯</b> first).</span></li>
            <li><span>Scroll down and tap <b>Add to Home Screen</b> <m3e-icon name="add_box" class="sv-inline-icon"></m3e-icon>.</span></li>
            <li><span>Make sure <b>Open as Web App</b> is on, then tap <b>Add</b>. SkyView appears on your Home Screen and opens full-screen.</span></li>
          </ol>`
        : nothing}
    </div>`;
  }

  private closeWhatsNew() {
    if (this.neverShow) store.set({ dismissedWhatsNewVersion: WHATS_NEW_VERSION });
    this.whatsNewSession = true;
  }

  connectedCallback() {
    super.connectedCallback();
    // First launch: offer to locate once settings have loaded and no location exists.
    const unsub = store.subscribe((s) => {
      if (!s.ready) return;
      unsub();
      if (!$().location) store.set({ welcomeOpen: true });
    });
  }
}

/**
 * <katalyst-preview> — an embeddable web component that asks the Katalyst solver for a free verdict preview.
 *
 *   <script type="module" src="https://your-app.example/widget/katalyst-widget.js"></script>
 *   <katalyst-preview contract="0x…solver…" prompt="Max yield, A-Tier only"></katalyst-preview>
 *
 * Attributes: `contract` (GenLayer solver address, required), `prompt` (initial text), `chain` (default studionet),
 *             `theme` ("dark" | "light", default follows the page's prefers-color-scheme).
 * Event:      `katalyst:verdict` — CustomEvent whose `detail` is the verdict, bubbling out of the shadow root.
 * Nothing is deposited and nothing is stored: it uses the solver's simulated `preview_intent`.
 */
import { GenLayerReader } from '../sdk/genlayer';
import { poolLabel, type VerdictPayload } from '../utils/types';

const CSS = `
:host { display: block; font-family: Inter, system-ui, -apple-system, 'Segoe UI', sans-serif; color: var(--k-fg); --k-bg:#0a0d12; --k-surface:#10151c; --k-line:#2c374a; --k-fg:#e8edf4; --k-muted:#9ba6b6; --k-accent:#3dd6a6; --k-accent-ink:#04120c; --k-danger:#f87171; --k-warn:#f5b84b; }
:host([theme="light"]) { --k-bg:#ffffff; --k-surface:#f5f7fa; --k-line:#c9d3e0; --k-fg:#0f172a; --k-muted:#475569; --k-accent:#0c8f68; --k-accent-ink:#fff; --k-danger:#dc2626; --k-warn:#b7791f; }
@media (prefers-color-scheme: light) { :host(:not([theme="dark"])) { --k-bg:#ffffff; --k-surface:#f5f7fa; --k-line:#c9d3e0; --k-fg:#0f172a; --k-muted:#475569; --k-accent:#0c8f68; --k-accent-ink:#fff; --k-danger:#dc2626; --k-warn:#b7791f; } }
.card { background: var(--k-bg); border: 1px solid var(--k-line); border-radius: 14px; padding: 16px; }
label { display:block; font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--k-muted); margin-bottom: 6px; }
textarea { box-sizing: border-box; width: 100%; min-height: 76px; resize: vertical; background: var(--k-surface); color: var(--k-fg); border: 1px solid var(--k-line); border-radius: 10px; padding: 10px 12px; font: inherit; font-size: 14px; }
textarea:focus { outline: 2px solid var(--k-accent); outline-offset: 1px; }
button { margin-top: 10px; height: 38px; padding: 0 16px; border: 0; border-radius: 10px; background: var(--k-accent); color: var(--k-accent-ink); font: inherit; font-weight: 600; font-size: 14px; cursor: pointer; }
button:disabled { opacity: .5; cursor: not-allowed; }
.out { margin-top: 14px; font-size: 14px; }
.badge { display:inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.ok { background: color-mix(in srgb, var(--k-accent) 16%, transparent); color: var(--k-accent); }
.bad { background: color-mix(in srgb, var(--k-danger) 16%, transparent); color: var(--k-danger); }
.row { display:flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--k-line); }
.row:last-child { border-bottom: 0; }
.muted { color: var(--k-muted); font-size: 12px; }
.err { color: var(--k-danger); }
.foot { margin: 12px 0 0; font-size: 11px; color: var(--k-muted); }
`;

class KatalystPreview extends HTMLElement {
  static observedAttributes = ['prompt'];
  private readonly root = this.attachShadow({ mode: 'open' });
  private reader: GenLayerReader | null = null;
  private readerKey = '';
  private busy = false;

  connectedCallback(): void {
    this.render();
  }

  attributeChangedCallback(name: string): void {
    if (name === 'prompt' && this.root.querySelector('textarea')) {
      (this.root.querySelector('textarea') as HTMLTextAreaElement).value = this.getAttribute('prompt') ?? '';
    }
  }

  private getReader(): GenLayerReader {
    const contract = this.getAttribute('contract') ?? '';
    const chain = this.getAttribute('chain') ?? 'studionet';
    if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) throw new Error('Set the `contract` attribute to the solver address (0x…)');
    const key = `${chain}:${contract}`;
    if (!this.reader || key !== this.readerKey) {
      this.reader = new GenLayerReader({ contract, chain });
      this.readerKey = key;
    }
    return this.reader;
  }

  private render(): void {
    this.root.innerHTML = `<style>${CSS}</style>
      <div class="card">
        <label for="p">Describe your intent</label>
        <textarea id="p" placeholder="e.g. Maximize yield, but only A-Tier carbon pools"></textarea>
        <button type="button">Preview verdict (free)</button>
        <div class="out" aria-live="polite"></div>
        <p class="foot">Simulated by GenLayer validators · nothing is deposited · powered by Katalyst</p>
      </div>`;
    const ta = this.root.querySelector('textarea')!;
    ta.value = this.getAttribute('prompt') ?? '';
    this.root.querySelector('button')!.addEventListener('click', () => void this.run());
  }

  private async run(): Promise<void> {
    if (this.busy) return;
    const out = this.root.querySelector('.out') as HTMLElement;
    const btn = this.root.querySelector('button') as HTMLButtonElement;
    const prompt = (this.root.querySelector('textarea') as HTMLTextAreaElement).value.trim();
    if (!prompt) {
      out.innerHTML = '<span class="err">Enter an intent first.</span>';
      return;
    }
    this.busy = true;
    btn.disabled = true;
    btn.textContent = 'Asking validators…';
    out.textContent = '';
    try {
      const verdict = await this.getReader().preview(prompt);
      out.innerHTML = this.verdictHtml(verdict);
      this.dispatchEvent(new CustomEvent('katalyst:verdict', { detail: verdict, bubbles: true, composed: true }));
    } catch (err) {
      out.innerHTML = `<span class="err">${escapeHtml(err instanceof Error ? err.message : 'Preview failed')}</span>`;
    } finally {
      this.busy = false;
      btn.disabled = false;
      btn.textContent = 'Preview verdict (free)';
    }
  }

  private verdictHtml(v: VerdictPayload): string {
    const approved = v.status === 'APPROVED';
    const head = `<span class="badge ${approved ? 'ok' : 'bad'}">${approved ? 'Approved' : 'Rejected'}</span>`;
    if (!approved) return `${head} <span class="muted">${escapeHtml(v.reason ?? '')}</span>`;
    const rows = v.trace?.pools.length
      ? v.trace.pools
          .map(
            (p) =>
              `<div class="row"><span><strong>${escapeHtml(poolLabel(p.address))}</strong> <span class="muted">${p.apy.toFixed(1)}% · ${escapeHtml(p.eco)}</span><br><span class="muted">${escapeHtml(p.reason)}</span></span><strong>${p.percentage ? p.percentage + '%' : '—'}</strong></div>`,
          )
          .join('')
      : v.allocations.map((a) => `<div class="row"><span>${escapeHtml(poolLabel(a.target_pool))} <span class="muted">${escapeHtml(a.eco_score)}</span></span><strong>${a.percentage}%</strong></div>`).join('');
    return `${head}<div style="margin-top:8px">${rows}</div>`;
  }
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

if (!customElements.get('katalyst-preview')) customElements.define('katalyst-preview', KatalystPreview);

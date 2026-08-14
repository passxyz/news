// Email + simple HTML page renderers for the CyberSec Daily Worker.
// All styles are inlined because most email clients ignore <style> blocks.
// The palette mirrors the static site: teal accent (#0d9488) on a light surface.

import type { Digest } from './types';

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const tagColor = (tag: string): string => {
  switch (tag) {
    case 'vuln':
      return '#b91c1c';
    case 'advisory':
      return '#b45309';
    case 'research':
      return '#2563eb';
    case 'patch':
      return '#0f766e';
    case 'breach':
      return '#7c3aed';
    default:
      return '#475569';
  }
};

/**
 * Render the daily digest email as an inline-styled HTML string.
 * @param digest       The daily digest document.
 * @param unsubscribeUrl Per-recipient unsubscribe URL (tokenized).
 */
export function renderEmail(digest: Digest, unsubscribeUrl: string): string {
  const dateLabel = escapeHtml(digest.date || 'today');
  const stats = digest.stats
    ? `${digest.stats.items} headlines &middot; ${digest.stats.sources} sources`
    : `${digest.items.length} headlines`;

  const items = digest.items
    .map((item, i) => {
      const tags = (item.tags || [])
        .map(
          (t) =>
            `<span style="display:inline-block;font-size:11px;line-height:1;font-weight:600;padding:3px 7px;border-radius:999px;color:#fff;background:${tagColor(
              t,
            )};margin-right:4px;">${escapeHtml(t)}</span>`,
        )
        .join('');

      return `
      <tr>
        <td style="padding:18px 0;border-bottom:1px solid #e7e3da;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="font-family:IBM Plex Mono,ui-monospace,Consolas,monospace;font-size:11px;color:#6b7280;letter-spacing:.04em;text-transform:uppercase;padding-bottom:6px;">
                ${escapeHtml(item.source || 'Source')}${item.published ? ` &middot; ${escapeHtml(item.published.slice(0, 10))}` : ''}
              </td>
            </tr>
            <tr>
              <td style="font-family:Fraunces,Georgia,serif;font-size:18px;line-height:1.3;color:#1b1b1f;font-weight:600;padding-bottom:6px;">
                <a href="${escapeHtml(item.url)}" style="color:#0f766e;text-decoration:none;">${escapeHtml(item.title)}</a>
              </td>
            </tr>
            ${tags ? `<tr><td style="padding-bottom:8px;">${tags}</td></tr>` : ''}
            <tr>
              <td style="font-family:IBM Plex Sans,system-ui,sans-serif;font-size:14px;line-height:1.55;color:#3f3f46;">
                ${escapeHtml(item.summary || '')}
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>CyberSec Daily &middot; ${dateLabel}</title>
</head>
<body style="margin:0;padding:0;background:#faf9f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#faf9f7;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e7e3da;">
          <tr>
            <td style="padding:24px 28px;background:#0d9488;">
              <div style="font-family:Fraunces,Georgia,serif;font-size:22px;font-weight:600;color:#ffffff;">CyberSec Daily</div>
              <div style="font-family:IBM Plex Mono,ui-monospace,Consolas,monospace;font-size:12px;color:#d1faf4;letter-spacing:.04em;text-transform:uppercase;margin-top:4px;">${dateLabel} &middot; ${stats}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 0 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${items || '<tr><td style="padding:24px 0;color:#6b7280;font-family:IBM Plex Sans,system-ui,sans-serif;">No items were aggregated for this day.</td></tr>'}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px 28px 28px;">
              <p style="margin:0;font-family:IBM Plex Sans,system-ui,sans-serif;font-size:12px;color:#6b7280;line-height:1.5;">
                You receive this digest because you subscribed to CyberSec Daily.
                <a href="${escapeHtml(unsubscribeUrl)}" style="color:#0f766e;">Unsubscribe</a> anytime.
              </p>
            </td>
          </tr>
        </table>
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
          <tr>
            <td style="padding:14px 4px;font-family:IBM Plex Sans,system-ui,sans-serif;font-size:11px;color:#9ca3af;text-align:center;">
              Aggregated from public sources, daily.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Render the double opt-in confirmation email. */
export function renderConfirmationEmail(confirmUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirm your subscription</title></head>
<body style="margin:0;padding:0;background:#faf9f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#faf9f7;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:10px;border:1px solid #e7e3da;">
          <tr><td style="padding:28px;">
            <h1 style="margin:0 0 12px 0;font-family:Fraunces,Georgia,serif;font-size:22px;color:#1b1b1f;font-weight:600;">Confirm your subscription</h1>
            <p style="margin:0 0 20px 0;font-family:IBM Plex Sans,system-ui,sans-serif;font-size:15px;line-height:1.6;color:#3f3f46;">
              Click the button below to activate your CyberSec Daily digest. You will receive one email per day with the latest cyber security headlines.
            </p>
            <p style="margin:0 0 20px 0;">
              <a href="${escapeHtml(confirmUrl)}" style="display:inline-block;background:#0d9488;color:#ffffff;font-family:IBM Plex Sans,system-ui,sans-serif;font-size:15px;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:8px;">Confirm subscription</a>
            </p>
            <p style="margin:0;font-family:IBM Plex Sans,system-ui,sans-serif;font-size:12px;color:#6b7280;line-height:1.5;">
              If you did not request this, you can ignore this email. <br>
              Or paste this link into your browser: ${escapeHtml(confirmUrl)}
            </p>
          </td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Render a minimal confirmation HTML page (confirm / unsubscribe success). */
export function renderSuccessPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#faf9f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#faf9f7;">
    <tr>
      <td align="center" style="padding:48px 12px;">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:10px;border:1px solid #e7e3da;">
          <tr><td style="padding:32px;text-align:center;">
            <h1 style="margin:0 0 12px 0;font-family:Fraunces,Georgia,serif;font-size:24px;color:#1b1b1f;font-weight:600;">${escapeHtml(title)}</h1>
            <p style="margin:0;font-family:IBM Plex Sans,system-ui,sans-serif;font-size:15px;line-height:1.6;color:#3f3f46;">${escapeHtml(message)}</p>
          </td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

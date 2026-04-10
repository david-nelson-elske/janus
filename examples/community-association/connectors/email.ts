/**
 * Email connector — app-level email sending.
 *
 * Dev mode: logs to console (or posts to Mailpit if configured).
 * Production: uses Resend API.
 */
import { config } from '../config';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Send a plain-text email.
 */
export async function sendEmail(title: string, body: string): Promise<void> {
  if (config.email?.mode === 'resend' && config.email.resendApiKey) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.email.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.email.from,
        to: 'noreply@example.com', // TODO: resolve recipient from context
        subject: title,
        text: body,
      }),
    });
  } else {
    console.log(`[email] ${title}\n${body}`);
  }
}

/**
 * Send an HTML email.
 */
export async function sendHtmlEmail(title: string, html: string): Promise<void> {
  if (config.email?.mode === 'resend' && config.email.resendApiKey) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.email.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.email.from,
        to: 'noreply@example.com',
        subject: title,
        html,
      }),
    });
  } else {
    console.log(`[email] ${title} (HTML)`);
  }
}

/**
 * Send an order confirmation email with line item details and QR codes.
 */
export async function sendConfirmationEmail(
  orderId: string,
  totalCents: number,
  confirmations: Array<{ type: string; name: string; ticketCode?: string }>,
  baseUrl: string,
): Promise<void> {
  const isFree = totalCents === 0;
  const title = isFree ? 'Registration Confirmed' : 'Order Confirmation';
  const successUrl = `${baseUrl}/checkout/success?orderId=${orderId}`;

  const itemsHtml = confirmations.map(c => {
    const typeLabel = c.type === 'membership' ? 'Membership' : c.type === 'registration' ? 'Registration' : 'Donation';
    let html = `<tr><td style="padding: 8px 0; border-bottom: 1px solid #eee;">`;
    html += `<span style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #888;">${typeLabel}</span><br/>`;
    html += `<strong>${escapeHtml(c.name)}</strong>`;
    if (c.ticketCode) {
      const qrUrl = `${baseUrl}/assets/qr/${c.ticketCode}`;
      html += `<div style="text-align: center; margin: 12px 0 4px;">`;
      html += `<img src="${qrUrl}" alt="Ticket QR" width="180" height="180" style="border: 1px solid #ddd; border-radius: 6px;" />`;
      html += `<br/><span style="font-family: monospace; font-size: 13px; color: #555; letter-spacing: 1px;">${c.ticketCode}</span>`;
      html += `<br/><span style="font-size: 12px; color: #888;">Show this at the event</span>`;
      html += `</div>`;
    }
    html += `</td></tr>`;
    return html;
  }).join('');

  const totalLine = isFree
    ? `<strong style="color: #079053;">Free</strong>`
    : `<strong>$${(totalCents / 100).toFixed(2)} CAD</strong>`;

  const emailHtml = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>${title}</h2>
      <p style="line-height: 1.6; color: #333;">
        ${isFree ? "You're registered! Here's your confirmation." : 'Thank you for your purchase. Here are your order details.'}
      </p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">${itemsHtml}</table>
      <div style="display: flex; justify-content: space-between; padding: 12px 0; border-top: 2px solid #333; font-size: 16px;">
        <span>Total</span> ${totalLine}
      </div>
      <p style="margin: 20px 0;">
        <a href="${successUrl}" style="display: inline-block; padding: 10px 24px; background: #333; color: white; text-decoration: none; border-radius: 6px; font-weight: 600;">View Order</a>
      </p>
      ${confirmations.some(c => c.type === 'donation')
        ? '<p style="font-size: 13px; color: #666;">This is a confirmation only — tax receipts are not issued.</p>'
        : ''}
      <hr style="border: none; border-top: 1px solid #ccc; margin: 2em 0;" />
      <p style="color: #666; font-size: 0.85em;">${escapeHtml(config.name)}</p>
    </div>
  `;

  await sendHtmlEmail(title, emailHtml);
  console.log(`[email] Confirmation email sent for order ${orderId}`);
}

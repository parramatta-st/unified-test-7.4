import type { NextApiRequest, NextApiResponse } from 'next';
import nodemailer from 'nodemailer';
import Papa from 'papaparse';

function norm(v: any) { return String(v || '').trim(); }
function lower(v: any) { return norm(v).toLowerCase(); }

async function lookupParentEmail(name: string): Promise<string | undefined> {
  const contacts = process.env.NEXT_PUBLIC_CONTACTS_CSV_URL;
  if (!contacts) return undefined;
  const res = await fetch(contacts);
  if (!res.ok) return undefined;
  const text = await res.text();
  const parsed = Papa.parse<Record<string, any>>(text, { header: true, skipEmptyLines: true, transformHeader: h => h.trim() });
  const rows = parsed.data || [];
  const target = lower(name);
  const targetFirst = target.split(/\s+/)[0] || target;

  for (const row of rows) {
    const first = norm(row.firstName || row.FirstName || row.first || row.First);
    const last = norm(row.lastName || row.LastName || row.last || row.Last);
    const fullFromParts = `${first} ${last}`.trim();
    const fullFromName = norm(row.Name || row.name || row.Student || row.student);
    const full = fullFromParts || fullFromName;
    const email = norm(row.parentEmail || row.ParentEmail || row.Email || row.email);
    if (!full || !email) continue;

    const fullLc = lower(full);
    if (fullLc === target) return email;
    if (!target.includes(' ') && first && lower(first) === targetFirst) return email;
  }
  return undefined;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { toName, subject, text, meta = {} } = req.body || {};
  if (!toName || !subject || !text) {
    return res.status(400).json({ ok: false, error: 'Missing fields' });
  }

  const toEmail = norm(meta?.parentEmail) || await lookupParentEmail(toName);
  if (!toEmail) {
    return res.status(400).json({ ok: false, error: 'Parent email not found for selected student' });
  }

  const user = process.env.MAIL_USER || '';
  const pass = process.env.MAIL_PASS || '';
  const replyTo = process.env.REPLY_TO || user;
  const campusName = process.env.NEXT_PUBLIC_CAMPUS_NAME || 'Success Tutoring Parramatta';

  if (!user || !pass) {
    return res.status(500).json({ ok: false, error: 'MAIL_USER/PASS not configured' });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });

    const info = await transporter.sendMail({
      from: `${campusName} <${user}>`,
      to: toEmail,
      replyTo,
      subject,
      text,
    });

    const webhook = process.env.FEEDBACK_LOG_WEBHOOK_URL;
    if (webhook) {
      const payload = {
        campusKey: meta?.campusKey || 'parramatta',
        campusName: meta?.campusName || campusName,
        tutorName: meta?.tutorName || '',
        studentId: '', // intentionally blank: contact IDs can be reassigned
        studentName: meta?.studentName || toName || '',
        studentFirstName: meta?.studentFirstName || (String(toName).split(/\s+/)[0] || ''),
        studentLastName: meta?.studentLastName || '',
        studentYear: meta?.studentYear || '',
        parentName: meta?.parentName || '',
        parentEmail: toEmail,
        mode: meta?.mode || '',
        feedbackType: meta?.feedbackType || '',
        programKey: meta?.programKey || '',
        programLabel: meta?.programLabel || '',
        templateIndex: meta?.templateIndex || '',
        lessonNumber: meta?.lessonNumber || '',
        assessmentName: meta?.assessmentName || '',
        completionStatus: meta?.completionStatus || '',
        sourceForm: meta?.sourceForm || 'feedback',
        year: meta?.year || '',
        subject: meta?.subject || '',
        strand: meta?.strand || '',
        lesson: meta?.lesson || '',
        topic: meta?.topic || '',
        subjectLine: meta?.subjectLine || subject,
        messageId: info?.messageId || '',
      };

      try {
        const logRes = await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!logRes.ok) console.error('Feedback logging failed', await logRes.text());
      } catch (err) {
        console.error('Feedback logging error', err);
      }
    }

    return res.status(200).json({ ok: true, messageId: info?.messageId || '' });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'send failed' });
  }
}

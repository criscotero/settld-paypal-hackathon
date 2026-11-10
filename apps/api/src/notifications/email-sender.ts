// Port for sending mail (ADR-0011). SMTP because it is the one protocol every provider speaks:
// a Gmail app password for the hackathon and Amazon SES in production differ only in variables.
import { createTransport } from "nodemailer";

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_SENDER = Symbol("EMAIL_SENDER");

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly from: string;
}

export function loadSmtpConfig(env: Readonly<Record<string, string | undefined>>): SmtpConfig | null {
  const { SMTP_HOST: host, SMTP_USER: user, SMTP_PASSWORD: password } = env;
  if (!host || !user || !password) return null;
  const port = Number(env.SMTP_PORT || "587");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`SMTP_PORT must be a number, got ${JSON.stringify(env.SMTP_PORT)}`);
  return { host, port, user, password, from: env.EMAIL_FROM || user };
}

export class SmtpEmailSender implements EmailSender {
  private readonly transport;

  constructor(private readonly config: SmtpConfig) {
    this.transport = createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      // Without this, nodemailer falls back to plain text if a network strips the STARTTLS offer,
      // and the password and the buyer's report travel in the clear.
      requireTLS: config.port !== 465,
      // A connection that hangs must fail and be retried, not hold a worker slot indefinitely.
      connectionTimeout: 10_000,
      socketTimeout: 20_000,
      auth: { user: config.user, pass: config.password },
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.config.from, ...message });
  }
}

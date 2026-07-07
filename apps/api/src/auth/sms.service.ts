import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../config/env';

export type SmsChannel = 'sms' | 'console' | 'failed';

/**
 * Sends the one-time login code over SMS. When the Twilio env keys are set it
 * POSTs to the Twilio Messaging API over HTTPS (raw fetch, no twilio SDK —
 * mirroring how StripePaymentGateway talks to Stripe). When they are unset (dev/
 * CI) the code is logged to the API console instead, so the passwordless flow is
 * fully exercisable without a Twilio account. A Twilio failure never throws: the
 * code is already stored, so we return the 'failed' channel (not 'console') and
 * let the caller tell the rider delivery failed and offer a retry. We never log
 * the raw code in production.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  async sendLoginCode(phone: string, code: string): Promise<SmsChannel> {
    const { accountSid, authToken, fromNumber } = this.env.twilio;
    if (!accountSid || !authToken || !fromNumber) {
      // Dev/CI fallback — the AC explicitly allows console delivery here.
      this.logger.log(`OTP for ${phone}: ${code} (Twilio unset — console only)`);
      return 'console';
    }

    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization:
              'Basic ' +
              Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            To: phone,
            From: fromNumber,
            Body: `Your RideNow verification code is ${code}. It expires in ${Math.round(
              this.env.auth.otpTtlSeconds / 60,
            )} minutes.`,
          }).toString(),
        },
      );
      if (!res.ok) {
        const detail = await res.text();
        this.logger.error(`Twilio send failed (${res.status}): ${detail}`);
        return 'failed';
      }
      return 'sms';
    } catch (err) {
      this.logger.error(`Twilio send threw: ${(err as Error).message}`);
      return 'failed';
    }
  }
}

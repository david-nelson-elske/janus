/**
 * Community Association Configuration
 *
 * All association-specific values live here. Fork this file
 * to create a new community association instance.
 */

export interface AssociationConfig {
  /** Full legal name of the association */
  name: string;
  /** Short display name */
  shortName: string;
  locale: {
    currency: string;
    locale: string;
    timezone: string;
  };
  business: {
    /** GST rate in basis points (500 = 5%) */
    gstBps: number;
    /** Service fee in basis points (250 = 2.5%) */
    serviceFeeBps: number;
    /** Minimum donation in cents */
    minDonationCents: number;
    /** Facility booking lead time in minutes */
    facilityLeadTimeMinutes: number;
    /** Facility booking horizon in days */
    facilityHorizonDays: number;
    /** Membership year start (month 1-12, day 1-31) */
    membershipYear: { startMonth: number; startDay: number };
  };
  auth: {
    mode: 'dev' | 'keycloak';
    keycloak?: {
      issuer: string;
      audience: string;
      adminUrl?: string;
    };
  };
  stripe?: {
    secretKey: string;
    webhookSecret: string;
    successUrl: string;
    cancelUrl: string;
  };
  connectors?: {
    /** ArcGIS planning data sync */
    arcgis?: {
      communities: string[];
      boundary?: { type: 'Polygon'; coordinates: number[][][] };
    };
    /** City news RSS feed */
    news?: { feedUrl: string };
  };
  email?: {
    mode: 'dev' | 'resend';
    from: string;
    resendApiKey?: string;
    devSmtpUrl?: string;
  };
  baseUrl: string;
  database: string;
  assets: { dir: string };
}

/**
 * Default configuration — Parkdale Community Association (Calgary, AB).
 * Override any value for a different association.
 */
export const config: AssociationConfig = {
  name: 'Parkdale Community Association',
  shortName: 'PCA',
  locale: {
    currency: 'CAD',
    locale: 'en-CA',
    timezone: 'America/Edmonton',
  },
  business: {
    gstBps: 500,
    serviceFeeBps: 250,
    minDonationCents: 500,
    facilityLeadTimeMinutes: 60,
    facilityHorizonDays: 90,
    membershipYear: { startMonth: 2, startDay: 1 },
  },
  auth: {
    mode: (process.env.JANUS_AUTH_MODE as 'dev' | 'keycloak') || 'dev',
    keycloak: {
      issuer: process.env.KEYCLOAK_ISSUER || '',
      audience: process.env.KEYCLOAK_AUDIENCE || '',
      adminUrl: process.env.KEYCLOAK_ADMIN_URL || '',
    },
  },
  stripe: process.env.STRIPE_SECRET_KEY
    ? {
        secretKey: process.env.STRIPE_SECRET_KEY,
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
        successUrl: `${process.env.BASE_URL || 'http://localhost:3000'}/checkout/success`,
        cancelUrl: `${process.env.BASE_URL || 'http://localhost:3000'}/checkout/cancel`,
      }
    : undefined,
  connectors: {
    arcgis: {
      communities: ['PARKDALE', 'POINT MCKAY'],
    },
    news: {
      feedUrl: 'https://newsroom.calgary.ca/tagfeed/en/tags/city__news,feature',
    },
  },
  email: {
    mode: (process.env.EMAIL_MODE as 'dev' | 'resend') || 'dev',
    from: 'Parkdale Community Association <noreply@parkdalecommunity.org>',
    resendApiKey: process.env.RESEND_API_KEY || '',
    devSmtpUrl: process.env.DEV_SMTP_URL || 'http://localhost:8025',
  },
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  database: process.env.DATABASE_PATH || './data/community.db',
  assets: { dir: process.env.ASSETS_DIR || './data/assets' },
};
